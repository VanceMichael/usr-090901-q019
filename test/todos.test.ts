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

interface TodoItem {
  taskId: string;
  storeId: string;
  deadlineAt: string;
  status: string;
  overdueDays: number;
}

async function collectPages(path: string): Promise<{ items: TodoItem[]; pages: number }> {
  const items: TodoItem[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const url = cursor === null ? path : `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;
    const res = await api(app.base, 'GET', url);
    assert.equal(res.status, 200);
    items.push(...(res.json.items as TodoItem[]));
    cursor = res.json.nextCursor as string | null;
    pages += 1;
    assert.ok(pages < 20, 'pagination must terminate');
  } while (cursor !== null);
  return { items, pages };
}

test('paginates todos by deadline with a stable keyset cursor', async () => {
  const urgentTask = await publishTask(app, 'todo-urgent', FIX.templates.urgent); // 24h deadline
  const stdTask = await publishTask(app, 'todo-std', FIX.templates.std); // 72h deadline

  const { items, pages } = await collectPages('/api/todos?brandId=lumina&limit=3');
  assert.equal(pages, 3, '8 todos in pages of 3, 3 and 2');
  assert.equal(items.length, 8);

  const keys = new Set(items.map((i) => `${i.taskId}:${i.storeId}`));
  assert.equal(keys.size, 8, 'no duplicates across pages');

  // ordered by deadline: all urgent-task todos come before standard-task todos
  const urgentIdx = items.map((i) => i.taskId).lastIndexOf(urgentTask);
  const stdIdx = items.map((i) => i.taskId).indexOf(stdTask);
  assert.ok(urgentIdx < stdIdx, 'earlier deadline sorts first');
  for (let i = 1; i < items.length; i += 1) {
    assert.ok(Date.parse(items[i - 1].deadlineAt) <= Date.parse(items[i].deadlineAt));
  }
  assert.ok(items.every((i) => i.status === 'pending' && i.overdueDays === 0));
});

test('marks overdue todos with their overdue days', async () => {
  const taskId = await publishTask(app, 'todo-overdue');
  await app.pool.query(
    "UPDATE recall_tasks SET deadline_at = now() - interval '5 days' WHERE id = $1",
    [taskId],
  );
  const res = await api(app.base, 'GET', '/api/todos?brandId=lumina');
  assert.equal(res.json.items.length, 4);
  for (const item of res.json.items) {
    assert.equal(item.status, 'overdue');
    assert.equal(item.overdueDays, 5);
  }
});

test('filters todos by brand and dueBefore', async () => {
  await publishTask(app, 'todo-f-lumina', FIX.templates.urgent); // 24h
  await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: 'todo-f-velvette',
    brandId: 'velvette',
    batchCode: 'V-1',
    batchVersion: 2,
    templateId: FIX.templates.velvetteStd,
  });

  const velvette = await api(app.base, 'GET', '/api/todos?brandId=velvette');
  assert.equal(velvette.json.items.length, 2);
  assert.ok(velvette.json.items.every((i: { brandId: string }) => i.brandId === 'velvette'));

  const all = await api(app.base, 'GET', '/api/todos');
  assert.equal(all.json.items.length, 6);

  const dueSoon = new Date(Date.now() + 36 * 3_600_000).toISOString();
  const due = await api(app.base, 'GET', `/api/todos?dueBefore=${encodeURIComponent(dueSoon)}`);
  assert.equal(due.json.items.length, 4, 'only the 24h-deadline task is due within 36h');
});

test('closed tasks drop out of the todo list', async () => {
  const taskId = await publishTask(app, 'todo-close');
  await api(app.base, 'POST', `/api/recalls/${taskId}/close`, {});
  const res = await api(app.base, 'GET', '/api/todos');
  assert.equal(res.json.items.length, 0);
  assert.equal(res.json.nextCursor, null);
});

test('rejects invalid cursors and limits', async () => {
  const badCursor = await api(app.base, 'GET', '/api/todos?cursor=%%%invalid%%%');
  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.json.error.code, 'VALIDATION_ERROR');

  const garbage = await api(app.base, 'GET', `/api/todos?cursor=${Buffer.from('{"a":1}').toString('base64url')}`);
  assert.equal(garbage.status, 400);

  const badLimit = await api(app.base, 'GET', '/api/todos?limit=0');
  assert.equal(badLimit.status, 400);
});
