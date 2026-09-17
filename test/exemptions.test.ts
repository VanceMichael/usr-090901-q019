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

test('validates the exemption reason against the template rules', async () => {
  const taskId = await publishTask(app, 'ex-rules');

  const badCode = await api(app.base, 'POST', `/api/recalls/${taskId}/exemptions`, {
    storeId: FIX.stores.s1,
    reasonCode: 'TOO_BUSY',
    reasonText: '门店人手不足无法处理',
  });
  assert.equal(badCode.status, 422);
  assert.equal(badCode.json.error.code, 'INVALID_REASON_CODE');
  assert.deepEqual(badCode.json.error.details.allowedReasonCodes, ['NO_STOCK', 'STORE_CLOSED']);

  const shortText = await api(app.base, 'POST', `/api/recalls/${taskId}/exemptions`, {
    storeId: FIX.stores.s1,
    reasonCode: 'NO_STOCK',
    reasonText: '没货',
  });
  assert.equal(shortText.status, 422);
  assert.equal(shortText.json.error.code, 'REASON_TEXT_TOO_SHORT');
});

test('full review flow: request, idempotent re-request, approve, coverage update', async () => {
  const taskId = await publishTask(app, 'ex-flow');

  const req = await api(app.base, 'POST', `/api/recalls/${taskId}/exemptions`, {
    storeId: FIX.stores.s1,
    reasonCode: 'NO_STOCK',
    reasonText: '该门店从未入库该批次商品',
  });
  assert.equal(req.status, 201);
  assert.equal(req.json.status, 'pending');
  assert.equal(req.json.storeId, FIX.stores.s1);

  const dup = await api(app.base, 'POST', `/api/recalls/${taskId}/exemptions`, {
    storeId: FIX.stores.s1,
    reasonCode: 'NO_STOCK',
    reasonText: '该门店从未入库该批次商品',
  });
  assert.equal(dup.status, 200);
  assert.equal(dup.headers.get('x-idempotent-replay'), 'true');
  assert.equal(dup.json.exemptionId, req.json.exemptionId, 're-request returns the pending original');

  const review = await api(app.base, 'POST', `/api/exemptions/${req.json.exemptionId}/review`, {
    decision: 'approved',
    reviewer: 'qa-li',
    note: '仓库出库记录一致',
  });
  assert.equal(review.status, 200);
  assert.equal(review.json.status, 'approved');
  assert.equal(review.json.reviewer, 'qa-li');
  assert.equal(review.json.snapshot.exempted, 1);
  assert.equal(review.json.snapshot.coverageRate, 0.25);

  const store = await app.pool.query(
    'SELECT status FROM recall_task_stores WHERE task_id = $1 AND store_id = $2',
    [taskId, FIX.stores.s1],
  );
  assert.equal(store.rows[0].status, 'exempted');

  const again = await api(app.base, 'POST', `/api/exemptions/${req.json.exemptionId}/review`, {
    decision: 'rejected',
    reviewer: 'qa-li',
  });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'EXEMPTION_ALREADY_REVIEWED');
});

test('rejected exemption keeps the store pending and a new request can be filed', async () => {
  const taskId = await publishTask(app, 'ex-reject');
  const req = await api(app.base, 'POST', `/api/recalls/${taskId}/exemptions`, {
    storeId: FIX.stores.s2,
    reasonCode: 'STORE_CLOSED',
    reasonText: '门店已停业整顿无法执行',
  });
  assert.equal(req.status, 201);

  const review = await api(app.base, 'POST', `/api/exemptions/${req.json.exemptionId}/review`, {
    decision: 'rejected',
    reviewer: 'qa-wang',
    note: '停业证明不足',
  });
  assert.equal(review.status, 200);
  assert.equal(review.json.status, 'rejected');
  assert.equal(review.json.snapshot.exempted, 0);

  const store = await app.pool.query(
    'SELECT status FROM recall_task_stores WHERE task_id = $1 AND store_id = $2',
    [taskId, FIX.stores.s2],
  );
  assert.equal(store.rows[0].status, 'pending');

  const refiled = await api(app.base, 'POST', `/api/recalls/${taskId}/exemptions`, {
    storeId: FIX.stores.s2,
    reasonCode: 'STORE_CLOSED',
    reasonText: '补充停业证明后再次申请豁免',
  });
  assert.equal(refiled.status, 201, 'a fresh request is allowed after rejection');
});

test('exemption requests are rejected for acknowledged or exempted stores', async () => {
  const taskId = await publishTask(app, 'ex-conflict');
  await ackStore(app, taskId, FIX.stores.s1);

  const res = await api(app.base, 'POST', `/api/recalls/${taskId}/exemptions`, {
    storeId: FIX.stores.s1,
    reasonCode: 'NO_STOCK',
    reasonText: '该门店从未入库该批次商品',
  });
  assert.equal(res.status, 409);
  assert.equal(res.json.error.code, 'STORE_ALREADY_ACKNOWLEDGED');
});

test('approval fails when the store acknowledged in the meantime', async () => {
  const taskId = await publishTask(app, 'ex-race');
  const req = await api(app.base, 'POST', `/api/recalls/${taskId}/exemptions`, {
    storeId: FIX.stores.s1,
    reasonCode: 'NO_STOCK',
    reasonText: '该门店从未入库该批次商品',
  });
  assert.equal(req.status, 201);
  await ackStore(app, taskId, FIX.stores.s1);

  const review = await api(app.base, 'POST', `/api/exemptions/${req.json.exemptionId}/review`, {
    decision: 'approved',
    reviewer: 'qa-li',
  });
  assert.equal(review.status, 409);
  assert.equal(review.json.error.code, 'STORE_ALREADY_ACKNOWLEDGED');
});

test('exemption requests on closed tasks and unknown stores are rejected', async () => {
  const taskId = await publishTask(app, 'ex-closed');
  await api(app.base, 'POST', `/api/recalls/${taskId}/close`, {});

  const closed = await api(app.base, 'POST', `/api/recalls/${taskId}/exemptions`, {
    storeId: FIX.stores.s1,
    reasonCode: 'NO_STOCK',
    reasonText: '该门店从未入库该批次商品',
  });
  assert.equal(closed.status, 409);
  assert.equal(closed.json.error.code, 'TASK_CLOSED');

  const task2 = await publishTask(app, 'ex-unknown-store');
  const unknownStore = await api(app.base, 'POST', `/api/recalls/${task2}/exemptions`, {
    storeId: FIX.stores.v1,
    reasonCode: 'NO_STOCK',
    reasonText: '该门店从未入库该批次商品',
  });
  assert.equal(unknownStore.status, 422);
  assert.equal(unknownStore.json.error.code, 'STORE_NOT_IN_TASK');

  const missing = await api(app.base, 'POST', '/api/exemptions/10000000-0000-4000-8000-000000009999/review', {
    decision: 'approved',
    reviewer: 'qa-li',
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'EXEMPTION_NOT_FOUND');
});
