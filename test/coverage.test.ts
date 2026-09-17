import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { ackStore, api, FIX, publishTask, resetDb, startApp, stopTestDb, type TestApp } from './helpers.js';

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

async function exemptStore(taskId: string, storeId: string): Promise<void> {
  const req = await api(app.base, 'POST', `/api/recalls/${taskId}/exemptions`, {
    storeId,
    reasonCode: 'NO_STOCK',
    reasonText: '该门店从未入库该批次商品',
  });
  assert.equal(req.status, 201);
  const review = await api(app.base, 'POST', `/api/exemptions/${req.json.exemptionId}/review`, {
    decision: 'approved',
    reviewer: 'qa-li',
  });
  assert.equal(review.status, 200);
}

test('computes coverage rate, unconfirmed list and overdue days', async () => {
  const taskId = await publishTask(app, 'cov-basic');
  await ackStore(app, taskId, FIX.stores.s1);
  await exemptStore(taskId, FIX.stores.s2);

  // push the deadline 3 days into the past: s3 and s4 become overdue
  await app.pool.query(
    "UPDATE recall_tasks SET deadline_at = now() - interval '3 days' WHERE id = $1",
    [taskId],
  );

  const res = await api(app.base, 'GET', `/api/recalls/${taskId}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.snapshot.acknowledged, 1);
  assert.equal(res.json.snapshot.exempted, 1);
  assert.equal(res.json.snapshot.coverageRate, 0.5);
  assert.equal(res.json.current.pending, 0);
  assert.equal(res.json.current.overdue, 2);
  assert.equal(res.json.current.maxOverdueDays, 3);

  assert.equal(res.json.unconfirmed.length, 2);
  for (const row of res.json.unconfirmed) {
    assert.equal(row.status, 'overdue');
    assert.equal(row.overdueDays, 3);
  }
  assert.deepEqual(
    res.json.unconfirmed.map((r: { storeId: string }) => r.storeId).sort(),
    [FIX.stores.s3, FIX.stores.s4].sort(),
  );
});

test('brand progress aggregates tasks with live overdue split', async () => {
  const taskA = await publishTask(app, 'cov-brand-a');
  const taskB = await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: 'cov-brand-b',
    brandId: 'lumina',
    batchCode: 'B-200',
    batchVersion: 1,
    templateId: FIX.templates.urgent,
  });
  assert.equal(taskB.status, 201);
  const taskBId = taskB.json.taskId as string;

  await ackStore(app, taskA, FIX.stores.s1);
  await ackStore(app, taskA, FIX.stores.s2);
  await exemptStore(taskBId, FIX.stores.s1);
  await app.pool.query(
    "UPDATE recall_tasks SET deadline_at = now() - interval '1 day' WHERE id = $1",
    [taskBId],
  );

  const res = await api(app.base, 'GET', '/api/brands/lumina/recalls');
  assert.equal(res.status, 200);
  assert.equal(res.json.brand.brandId, 'lumina');
  assert.equal(res.json.summary.openTasks, 2);
  assert.equal(res.json.summary.totalStores, 8);
  assert.equal(res.json.summary.acknowledged, 2);
  assert.equal(res.json.summary.exempted, 1);
  assert.equal(res.json.summary.overdue, 3, 'task B: 3 pending stores past deadline');
  assert.equal(res.json.summary.coverageRate, 0.375);
  assert.equal(res.json.tasks.length, 2);

  const unknown = await api(app.base, 'GET', '/api/brands/nope/recalls');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.code, 'BRAND_NOT_FOUND');
});

test('closing a task is idempotent and freezes further updates', async () => {
  const taskId = await publishTask(app, 'cov-close');
  await ackStore(app, taskId, FIX.stores.s1);

  const close = await api(app.base, 'POST', `/api/recalls/${taskId}/close`, { reason: '监管确认结案' });
  assert.equal(close.status, 200);
  assert.equal(close.json.status, 'closed');
  assert.ok(close.json.closedAt !== null);
  assert.equal(close.json.closeReason, '监管确认结案');
  assert.equal(close.json.snapshot.acknowledged, 1);

  const again = await api(app.base, 'POST', `/api/recalls/${taskId}/close`, {});
  assert.equal(again.status, 200);
  assert.equal(again.headers.get('x-idempotent-replay'), 'true');
  assert.equal(again.json.taskId, taskId);

  const receipt = await api(app.base, 'POST', `/api/recalls/${taskId}/receipts`, {
    receipts: [{ storeId: FIX.stores.s2, receiptTime: new Date().toISOString(), channel: 'app' }],
  });
  assert.equal(receipt.json.results[0].error.code, 'TASK_CLOSED');

  const detail = await api(app.base, 'GET', `/api/recalls/${taskId}`);
  assert.equal(detail.json.task.status, 'closed');
});

test('template rules are queryable per brand', async () => {
  const res = await api(app.base, 'GET', '/api/templates?brandId=lumina');
  assert.equal(res.status, 200);
  assert.equal(res.json.items.length, 2);
  const std = res.json.items.find((t: { name: string }) => t.name === 'std');
  assert.equal(std.rules.ackDeadlineHours, 72);
  assert.deepEqual(std.rules.allowedChannels, ['app', 'sms']);
  assert.deepEqual(std.rules.exemptionReasonCodes, ['NO_STOCK', 'STORE_CLOSED']);

  const all = await api(app.base, 'GET', '/api/templates');
  assert.equal(all.json.items.length, 3);
});
