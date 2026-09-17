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

test('coverage snapshot and pagination cursor survive a service restart', async () => {
  // --- before the restart: publish, acknowledge one store, capture state ---
  const taskId = await publishTask(app, 'restart-1');
  await ackStore(app, taskId, FIX.stores.s1);

  const beforeDetail = await api(app.base, 'GET', `/api/recalls/${taskId}`);
  assert.equal(beforeDetail.json.snapshot.acknowledged, 1);
  assert.equal(beforeDetail.json.snapshot.pending, 3);

  const page1 = await api(app.base, 'GET', '/api/todos?limit=2');
  assert.equal(page1.json.items.length, 2);
  const cursor = page1.json.nextCursor as string;
  assert.ok(cursor.length > 0);

  // --- restart: shut the service down, boot a fresh instance on the same DB ---
  await app.close();
  app = await startApp();

  // snapshot is persisted, so the coverage view is identical after restart
  const afterDetail = await api(app.base, 'GET', `/api/recalls/${taskId}`);
  assert.deepEqual(afterDetail.json.snapshot, beforeDetail.json.snapshot);
  assert.equal(afterDetail.json.task.status, 'open');

  // the cursor issued before the restart still pages correctly
  const page2 = await api(
    app.base,
    'GET',
    `/api/todos?limit=2&cursor=${encodeURIComponent(cursor)}`,
  );
  assert.equal(page2.status, 200);
  assert.equal(page2.json.items.length, 1, '3 pending todos: 2 on page 1, 1 on page 2');
  assert.equal(page2.json.nextCursor, null);

  const page1Keys = new Set(
    page1.json.items.map((i: { taskId: string; storeId: string }) => `${i.taskId}:${i.storeId}`),
  );
  for (const item of page2.json.items) {
    assert.ok(!page1Keys.has(`${item.taskId}:${item.storeId}`), 'no overlap across restart');
  }

  // and the service keeps accepting work on the recovered state
  const receipt = await api(app.base, 'POST', `/api/recalls/${taskId}/receipts`, {
    receipts: [{ storeId: FIX.stores.s2, receiptTime: new Date().toISOString(), channel: 'app' }],
  });
  assert.equal(receipt.json.results[0].ok, true);
  assert.equal(receipt.json.snapshot.acknowledged, 2);
});
