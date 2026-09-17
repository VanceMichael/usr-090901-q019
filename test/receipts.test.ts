import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { api, FIX, publishTask, resetDb, startApp, stopTestDb, type TestApp } from './helpers.js';

let app: TestApp;
before(async () => {
  app = await startApp();
});
after(async () => {
  await app.close();
  await stopTestDb();
});
beforeEach(async () => {
  await resetDb(app.pool);
});

test('accepts receipts and keeps snapshot counts consistent with the rows', async () => {
  const taskId = await publishTask(app, 'rcpt-basic');
  const now = new Date().toISOString();
  const res = await api(app.base, 'POST', `/api/recalls/${taskId}/receipts`, {
    receipts: [
      { storeId: FIX.stores.s1, receiptTime: now, channel: 'app' },
      { storeId: FIX.stores.s2, receiptTime: now, channel: 'sms', note: '已下架封存' },
    ],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    res.json.results.map((r: { index: number; ok: boolean }) => [r.index, r.ok]),
    [[0, true], [1, true]],
  );
  assert.equal(res.json.results[0].status, 'acknowledged');
  assert.equal(res.json.results[0].late, false);
  assert.equal(res.json.snapshot.acknowledged, 2);
  assert.equal(res.json.snapshot.pending, 2);
  assert.equal(res.json.snapshot.coverageRate, 0.5);

  const check = await app.pool.query(
    `SELECT
       (SELECT COUNT(*) FROM recall_task_stores WHERE task_id = $1 AND status = 'acknowledged')::int AS actual,
       (SELECT acknowledged FROM coverage_snapshots WHERE task_id = $1) AS snapshot`,
    [taskId],
  );
  assert.equal(check.rows[0].snapshot, check.rows[0].actual, 'snapshot must match the rows');
});

test('isolates mixed batch errors by input index', async () => {
  const taskId = await publishTask(app, 'rcpt-mixed');
  const good = new Date().toISOString();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const res = await api(app.base, 'POST', `/api/recalls/${taskId}/receipts`, {
    receipts: [
      { storeId: FIX.stores.s1, receiptTime: good, channel: 'app' }, // ok
      { storeId: FIX.stores.v1, receiptTime: good, channel: 'app' }, // foreign store
      { storeId: FIX.stores.s2, receiptTime: future, channel: 'app' }, // future receipt time
      { storeId: FIX.stores.s3, receiptTime: good, channel: 'pigeon' }, // channel not allowed
      { storeId: 'not-a-uuid', receiptTime: good, channel: 'app' }, // malformed item
    ],
  });
  assert.equal(res.status, 200, 'item errors must not fail the batch');
  const results = res.json.results;
  assert.equal(results.length, 5);
  assert.deepEqual(results.map((r: { index: number }) => r.index), [0, 1, 2, 3, 4]);

  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.equal(results[1].error.code, 'STORE_NOT_IN_TASK');
  assert.equal(results[2].ok, false);
  assert.equal(results[2].error.code, 'RECEIPT_TIME_IN_FUTURE');
  assert.equal(results[3].ok, false);
  assert.equal(results[3].error.code, 'INVALID_CHANNEL');
  assert.equal(results[4].ok, false);
  assert.equal(results[4].error.code, 'VALIDATION_ERROR');

  // only the first receipt was committed
  assert.equal(res.json.snapshot.acknowledged, 1);
  const rows = await app.pool.query(
    "SELECT store_id FROM recall_task_stores WHERE task_id = $1 AND status = 'acknowledged'",
    [taskId],
  );
  assert.deepEqual(rows.rows.map((r) => r.store_id), [FIX.stores.s1]);
});

test('flags late receipts and records overdue days at acknowledgement', async () => {
  const taskId = await publishTask(app, 'rcpt-late');
  await app.pool.query(
    "UPDATE recall_tasks SET deadline_at = now() - interval '2 days' WHERE id = $1",
    [taskId],
  );
  const res = await api(app.base, 'POST', `/api/recalls/${taskId}/receipts`, {
    receipts: [{ storeId: FIX.stores.s1, receiptTime: new Date().toISOString(), channel: 'app' }],
  });
  assert.equal(res.json.results[0].ok, true);
  assert.equal(res.json.results[0].late, true, 'receipt after the deadline is late');
  assert.equal(res.json.snapshot.acknowledged, 1);
  assert.equal(res.json.snapshot.lateAcknowledged, 1);

  const row = await app.pool.query(
    'SELECT receipt_late, overdue_days_at_ack FROM recall_task_stores WHERE task_id = $1 AND store_id = $2',
    [taskId, FIX.stores.s1],
  );
  assert.equal(row.rows[0].receipt_late, true);
  assert.equal(row.rows[0].overdue_days_at_ack, 2);

  const receipt = await app.pool.query(
    'SELECT outcome FROM receipts WHERE task_id = $1 AND store_id = $2',
    [taskId, FIX.stores.s1],
  );
  assert.equal(receipt.rows[0].outcome, 'accepted_late');
});

test('rejects receipt times before publication', async () => {
  const taskId = await publishTask(app, 'rcpt-early');
  const task = await app.pool.query('SELECT published_at FROM recall_tasks WHERE id = $1', [taskId]);
  const beforePublish = new Date((task.rows[0].published_at as Date).getTime() - 3_600_000).toISOString();
  const res = await api(app.base, 'POST', `/api/recalls/${taskId}/receipts`, {
    receipts: [{ storeId: FIX.stores.s1, receiptTime: beforePublish, channel: 'app' }],
  });
  assert.equal(res.json.results[0].ok, false);
  assert.equal(res.json.results[0].error.code, 'RECEIPT_BEFORE_PUBLISH');
});

test('duplicate receipts are idempotent and logged in the history', async () => {
  const taskId = await publishTask(app, 'rcpt-dup');
  const now = new Date().toISOString();
  const first = await api(app.base, 'POST', `/api/recalls/${taskId}/receipts`, {
    receipts: [{ storeId: FIX.stores.s1, receiptTime: now, channel: 'app' }],
  });
  assert.equal(first.json.results[0].duplicate, false);

  const dup = await api(app.base, 'POST', `/api/recalls/${taskId}/receipts`, {
    receipts: [{ storeId: FIX.stores.s1, receiptTime: now, channel: 'app' }],
  });
  assert.equal(dup.json.results[0].ok, true);
  assert.equal(dup.json.results[0].duplicate, true);
  assert.equal(dup.json.snapshot.acknowledged, 1, 'counts unchanged by duplicate');

  const history = await api(app.base, 'GET', `/api/stores/${FIX.stores.s1}/receipts`);
  assert.equal(history.status, 200);
  assert.equal(history.json.total, 2, 'both the original and the duplicate are logged');
  assert.deepEqual(
    history.json.items.map((i: { outcome: string }) => i.outcome).sort(),
    ['accepted', 'duplicate'],
  );
  assert.equal(history.json.items[0].batchCode, 'B-100');
});

test('receipts for exempted stores and closed tasks are rejected per item', async () => {
  const taskId = await publishTask(app, 'rcpt-closed');
  await api(app.base, 'POST', `/api/recalls/${taskId}/close`, { reason: '监管要求结案' });

  const res = await api(app.base, 'POST', `/api/recalls/${taskId}/receipts`, {
    receipts: [{ storeId: FIX.stores.s1, receiptTime: new Date().toISOString(), channel: 'app' }],
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.results[0].ok, false);
  assert.equal(res.json.results[0].error.code, 'TASK_CLOSED');
});

test('receipts on an unknown task return 404 for the batch', async () => {
  const res = await api(app.base, 'POST', '/api/recalls/10000000-0000-4000-8000-000000009999/receipts', {
    receipts: [{ storeId: FIX.stores.s1, receiptTime: new Date().toISOString(), channel: 'app' }],
  });
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'TASK_NOT_FOUND');
});

test('store receipt history filters by task and paginates', async () => {
  const taskA = await publishTask(app, 'rcpt-hist-a');
  const taskB = await publishTask(app, 'rcpt-hist-b', FIX.templates.urgent);
  const now = new Date().toISOString();
  for (const taskId of [taskA, taskB]) {
    await api(app.base, 'POST', `/api/recalls/${taskId}/receipts`, {
      receipts: [{ storeId: FIX.stores.s1, receiptTime: now, channel: taskId === taskB ? 'sms' : 'app' }],
    });
  }
  const all = await api(app.base, 'GET', `/api/stores/${FIX.stores.s1}/receipts`);
  assert.equal(all.json.total, 2);

  const filtered = await api(app.base, 'GET', `/api/stores/${FIX.stores.s1}/receipts?taskId=${taskA}`);
  assert.equal(filtered.json.total, 1);
  assert.equal(filtered.json.items[0].taskId, taskA);

  const unknown = await api(app.base, 'GET', '/api/stores/10000000-0000-4000-8000-000000009999/receipts');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'STORE_NOT_FOUND');
});
