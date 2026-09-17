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

test('publish creates per-store pending rows and a zero-coverage snapshot', async () => {
  const res = await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: 'pub-1',
    brandId: 'lumina',
    batchCode: 'B-100',
    batchVersion: 3,
    templateId: FIX.templates.std,
  });
  assert.equal(res.status, 201);
  assert.equal(res.json.status, 'open');
  assert.equal(res.json.storeCount, 4, 'inactive store S5 must be excluded');
  assert.equal(res.json.snapshot.totalStores, 4);
  assert.equal(res.json.snapshot.pending, 4);
  assert.equal(res.json.snapshot.acknowledged, 0);
  assert.equal(res.json.snapshot.coverageRate, 0);

  // deadline derived from the template's ackDeadlineHours rule (72h)
  const published = Date.parse(res.json.publishedAt);
  const deadline = Date.parse(res.json.deadlineAt);
  assert.ok(Math.abs(deadline - published - 72 * 3_600_000) < 5_000);

  const rows = await app.pool.query(
    "SELECT COUNT(*)::int AS c FROM recall_task_stores WHERE task_id = $1 AND status = 'pending'",
    [res.json.taskId],
  );
  assert.equal(rows.rows[0].c, 4);
});

test('duplicate publish returns the original task without duplicating rows', async () => {
  const body = {
    idempotencyKey: 'pub-dup',
    brandId: 'lumina',
    batchCode: 'B-100',
    batchVersion: 3,
    templateId: FIX.templates.std,
  };
  const first = await api(app.base, 'POST', '/api/recalls', body);
  const second = await api(app.base, 'POST', '/api/recalls', body);
  assert.equal(first.status, 201);
  assert.equal(second.status, 200);
  assert.equal(second.headers.get('x-idempotent-replay'), 'true');
  assert.equal(second.json.taskId, first.json.taskId);
  assert.equal(second.json.storeCount, 4);

  const stores = await app.pool.query(
    'SELECT COUNT(*)::int AS c FROM recall_task_stores WHERE task_id = $1',
    [first.json.taskId],
  );
  assert.equal(stores.rows[0].c, 4, 'no duplicated store assignments');
  const tasks = await app.pool.query('SELECT COUNT(*)::int AS c FROM recall_tasks');
  assert.equal(tasks.rows[0].c, 1, 'no duplicated task');
  const snap = await app.pool.query(
    'SELECT version FROM coverage_snapshots WHERE task_id = $1',
    [first.json.taskId],
  );
  assert.equal(snap.rows[0].version, 1, 'snapshot not recomputed on replay');
});

test('rejects a stale batch version with the current version in details', async () => {
  const res = await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: 'pub-stale',
    brandId: 'lumina',
    batchCode: 'B-100',
    batchVersion: 2,
    templateId: FIX.templates.std,
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'BATCH_VERSION_MISMATCH');
  assert.equal(res.json.error.details.currentVersion, 3);
});

test('rejects unknown batch, foreign template and past deadline', async () => {
  const unknownBatch = await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: 'pub-nb',
    brandId: 'lumina',
    batchCode: 'NOPE',
    batchVersion: 1,
    templateId: FIX.templates.std,
  });
  assert.equal(unknownBatch.status, 404);
  assert.equal(unknownBatch.json.error.code, 'BATCH_NOT_FOUND');

  const foreignTemplate = await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: 'pub-ft',
    brandId: 'lumina',
    batchCode: 'B-100',
    batchVersion: 3,
    templateId: FIX.templates.velvetteStd,
  });
  assert.equal(foreignTemplate.status, 404);
  assert.equal(foreignTemplate.json.error.code, 'TEMPLATE_NOT_FOUND');

  const pastDeadline = await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: 'pub-past',
    brandId: 'lumina',
    batchCode: 'B-100',
    batchVersion: 3,
    templateId: FIX.templates.std,
    deadlineAt: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.equal(pastDeadline.status, 422);
  assert.equal(pastDeadline.json.error.code, 'DEADLINE_IN_PAST');
});

test('rejects stores that do not belong to the brand', async () => {
  const res = await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: 'pub-foreign-store',
    brandId: 'lumina',
    batchCode: 'B-100',
    batchVersion: 3,
    templateId: FIX.templates.std,
    storeIds: [FIX.stores.s1, FIX.stores.v1],
  });
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'STORE_NOT_IN_BRAND');
  assert.deepEqual(res.json.error.details.storeIds, [FIX.stores.v1]);
});

test('rejects inactive stores and honours an explicit store subset', async () => {
  const inactive = await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: 'pub-inactive',
    brandId: 'lumina',
    batchCode: 'B-100',
    batchVersion: 3,
    templateId: FIX.templates.std,
    storeIds: [FIX.stores.s1, FIX.stores.s5Inactive],
  });
  assert.equal(inactive.status, 422);
  assert.equal(inactive.json.error.code, 'STORE_INACTIVE');

  const subset = await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: 'pub-subset',
    brandId: 'lumina',
    batchCode: 'B-100',
    batchVersion: 3,
    templateId: FIX.templates.std,
    storeIds: [FIX.stores.s1, FIX.stores.s2],
  });
  assert.equal(subset.status, 201);
  assert.equal(subset.json.storeCount, 2);
  assert.equal(subset.json.snapshot.totalStores, 2);
});

test('explicit deadlineAt overrides the template rule', async () => {
  const deadline = new Date(Date.now() + 6 * 3_600_000).toISOString();
  const res = await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: 'pub-deadline',
    brandId: 'lumina',
    batchCode: 'B-100',
    batchVersion: 3,
    templateId: FIX.templates.std,
    deadlineAt: deadline,
  });
  assert.equal(res.status, 201);
  assert.equal(Date.parse(res.json.deadlineAt), Date.parse(deadline));
});

test('validation errors do not burn the idempotency key', async () => {
  const bad = await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: 'pub-reuse',
    brandId: 'lumina',
    batchCode: 'B-100',
    batchVersion: 2,
    templateId: FIX.templates.std,
  });
  assert.equal(bad.status, 422);
  const good = await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: 'pub-reuse',
    brandId: 'lumina',
    batchCode: 'B-100',
    batchVersion: 3,
    templateId: FIX.templates.std,
  });
  assert.equal(good.status, 201, 'key must remain usable after a failed publish');
});

test('unknown task id returns 404 on detail', async () => {
  const res = await api(app.base, 'GET', '/api/recalls/10000000-0000-4000-8000-000000009999');
  assert.equal(res.status, 404);
  assert.equal(res.json.error.code, 'TASK_NOT_FOUND');
});

test('publishTask helper exposes the urgent template deadline rule', async () => {
  const taskId = await publishTask(app, 'pub-urgent', FIX.templates.urgent);
  const res = await api(app.base, 'GET', `/api/recalls/${taskId}`);
  const published = Date.parse(res.json.task.publishedAt);
  const deadline = Date.parse(res.json.task.deadlineAt);
  assert.ok(Math.abs(deadline - published - 24 * 3_600_000) < 5_000);
});
