import type pg from 'pg';
import type { RequestContext } from './router.js';
import { sendJson } from './http-utils.js';
import { ApiError, badRequest, notFound } from './errors.js';
import {
  asObject,
  isUuid,
  optIsoDate,
  optString,
  optUuidArray,
  parseIsoDate,
  queryLimit,
  queryOffset,
  reqEnum,
  reqInt,
  reqString,
  reqUuid,
} from './validation.js';
import { decodeTodoCursor, encodeTodoCursor } from './cursor.js';
import { now } from './time.js';
import { publishRecall, getSnapshotRow, getTaskRow } from './services/publish.js';
import { submitReceipts, type PreparedReceiptItem } from './services/receipts.js';
import { requestExemption, reviewExemption } from './services/exemptions.js';
import { closeTask } from './services/close.js';
import {
  brandProgress,
  currentCounts,
  listTemplates,
  storeReceipts,
  todoPage,
  unconfirmedStores,
} from './services/queries.js';
import {
  exemptionJson,
  receiptJson,
  snapshotJson,
  taskJson,
  templateJson,
} from './serializers.js';

const MAX_BATCH_RECEIPTS = 500;

function taskIdParam(ctx: RequestContext): string {
  const id = ctx.params.taskId;
  if (!isUuid(id)) throw badRequest('path parameter "taskId" must be a UUID');
  return id.toLowerCase();
}

export function buildHandlers(pool: pg.Pool) {
  return {
    /** GET /health — liveness + DB probe for container healthchecks. */
    async health(ctx: RequestContext): Promise<void> {
      try {
        await pool.query('SELECT 1');
        sendJson(ctx.res, 200, { status: 'ok', db: 'up' });
      } catch {
        sendJson(ctx.res, 503, { status: 'error', db: 'down' });
      }
    },

    /** GET / — service index. */
    async root(ctx: RequestContext): Promise<void> {
      sendJson(ctx.res, 200, {
        service: 'cosmetics-recall-service',
        endpoints: [
          'POST /api/recalls',
          'GET /api/recalls/:taskId',
          'POST /api/recalls/:taskId/close',
          'POST /api/recalls/:taskId/receipts',
          'POST /api/recalls/:taskId/exemptions',
          'POST /api/exemptions/:exemptionId/review',
          'GET /api/brands/:brandId/recalls',
          'GET /api/stores/:storeId/receipts',
          'GET /api/todos',
          'GET /api/templates',
          'GET /health',
        ],
      });
    },

    /** POST /api/recalls — publish a recall task (idempotent). */
    async publishRecall(ctx: RequestContext): Promise<void> {
      const obj = asObject(ctx.body);
      const result = await publishRecall(pool, {
        idempotencyKey: reqString(obj, 'idempotencyKey', { max: 200 }),
        brandId: reqString(obj, 'brandId', { max: 100 }),
        batchCode: reqString(obj, 'batchCode', { max: 100 }),
        batchVersion: reqInt(obj, 'batchVersion', { min: 1 }),
        templateId: reqUuid(obj, 'templateId'),
        deadlineAt: optIsoDate(obj, 'deadlineAt'),
        storeIds: optUuidArray(obj, 'storeIds'),
      });
      const snapshot = await getSnapshotRow(pool, result.task.id);
      sendJson(
        ctx.res,
        result.replay ? 200 : 201,
        {
          ...taskJson(result.task),
          storeCount: result.storeCount,
          snapshot: snapshot === null ? null : snapshotJson(snapshot),
        },
        result.replay ? { 'x-idempotent-replay': 'true' } : {},
      );
    },

    /** GET /api/recalls/:taskId — task detail, snapshot, live counts, unconfirmed list. */
    async getTask(ctx: RequestContext): Promise<void> {
      const taskId = taskIdParam(ctx);
      const task = await getTaskRow(pool, taskId);
      if (task === null) throw notFound('TASK_NOT_FOUND', `recall task ${taskId} not found`);
      const at = now();
      const [snapshot, current, unconfirmed] = await Promise.all([
        getSnapshotRow(pool, taskId),
        currentCounts(pool, taskId, at),
        unconfirmedStores(pool, taskId, at),
      ]);
      sendJson(ctx.res, 200, {
        task: taskJson(task),
        snapshot: snapshot === null ? null : snapshotJson(snapshot),
        current: {
          pending: current.pending,
          overdue: current.overdue,
          maxOverdueDays: current.max_overdue_days,
        },
        unconfirmed: unconfirmed.map((row) => ({
          storeId: row.store_id,
          storeCode: row.store_code,
          name: row.name,
          region: row.region,
          status: row.status,
          overdueDays: row.overdue_days,
          deadlineAt: new Date(row.deadline_at).toISOString(),
        })),
      });
    },

    /** POST /api/recalls/:taskId/close — close a task (idempotent). */
    async closeTask(ctx: RequestContext): Promise<void> {
      const taskId = taskIdParam(ctx);
      const reason = ctx.body === undefined ? undefined : optString(asObject(ctx.body), 'reason', { max: 500 });
      const result = await closeTask(pool, taskId, reason);
      const snapshot = await getSnapshotRow(pool, taskId);
      sendJson(
        ctx.res,
        200,
        {
          ...taskJson(result.task),
          snapshot: snapshot === null ? null : snapshotJson(snapshot),
        },
        result.replay ? { 'x-idempotent-replay': 'true' } : {},
      );
    },

    /**
     * POST /api/recalls/:taskId/receipts — batch store acknowledgements.
     * Item errors are isolated by input index; the batch itself returns 200.
     */
    async submitReceipts(ctx: RequestContext): Promise<void> {
      const taskId = taskIdParam(ctx);
      const obj = asObject(ctx.body);
      const rawItems = obj.receipts;
      if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > MAX_BATCH_RECEIPTS) {
        throw badRequest(`field "receipts" must be an array of 1..${MAX_BATCH_RECEIPTS} items`);
      }
      if ((await getTaskRow(pool, taskId)) === null) {
        throw notFound('TASK_NOT_FOUND', `recall task ${taskId} not found`);
      }

      const items: PreparedReceiptItem[] = rawItems.map((raw, index): PreparedReceiptItem => {
        try {
          if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            throw badRequest('receipt item must be an object');
          }
          const item = raw as Record<string, unknown>;
          return {
            index,
            input: {
              storeId: reqUuid(item, 'storeId'),
              receiptTime: typeof item.receiptTime === 'string'
                ? parseIsoDate(item.receiptTime, 'receiptTime')
                : badRequestThrow('field "receiptTime" must be an ISO-8601 timestamp'),
              channel: reqString(item, 'channel', { max: 50 }),
              note: optString(item, 'note', { max: 1000 }),
            },
          };
        } catch (err) {
          if (err instanceof ApiError) {
            return { index, error: { code: err.code, message: err.message } };
          }
          throw err;
        }
      });

      const results = await submitReceipts(pool, taskId, items);
      const snapshot = await getSnapshotRow(pool, taskId);
      sendJson(ctx.res, 200, {
        taskId,
        results,
        snapshot: snapshot === null ? null : snapshotJson(snapshot),
      });
    },

    /** POST /api/recalls/:taskId/exemptions — request an exemption for a store. */
    async requestExemption(ctx: RequestContext): Promise<void> {
      const taskId = taskIdParam(ctx);
      const obj = asObject(ctx.body);
      const result = await requestExemption(pool, taskId, {
        storeId: reqUuid(obj, 'storeId'),
        reasonCode: reqString(obj, 'reasonCode', { max: 64 }),
        reasonText: reqString(obj, 'reasonText', { max: 2000 }),
      });
      sendJson(
        ctx.res,
        result.replay ? 200 : 201,
        exemptionJson(result.exemption),
        result.replay ? { 'x-idempotent-replay': 'true' } : {},
      );
    },

    /** POST /api/exemptions/:exemptionId/review — approve or reject. */
    async reviewExemption(ctx: RequestContext): Promise<void> {
      const exemptionId = ctx.params.exemptionId;
      if (!isUuid(exemptionId)) throw badRequest('path parameter "exemptionId" must be a UUID');
      const obj = asObject(ctx.body);
      const result = await reviewExemption(pool, exemptionId.toLowerCase(), {
        decision: reqEnum(obj, 'decision', ['approved', 'rejected'] as const),
        reviewer: reqString(obj, 'reviewer', { max: 100 }),
        note: optString(obj, 'note', { max: 1000 }),
      });
      const snapshot = await getSnapshotRow(pool, result.taskId);
      sendJson(ctx.res, 200, {
        ...exemptionJson(result.exemption),
        snapshot: snapshot === null ? null : snapshotJson(snapshot),
      });
    },

    /** GET /api/brands/:brandId/recalls — brand-level recall progress. */
    async brandProgress(ctx: RequestContext): Promise<void> {
      const progress = await brandProgress(pool, ctx.params.brandId, now());
      sendJson(ctx.res, 200, progress);
    },

    /** GET /api/stores/:storeId/receipts — one store's receipt history. */
    async storeReceipts(ctx: RequestContext): Promise<void> {
      const storeId = ctx.params.storeId;
      if (!isUuid(storeId)) throw badRequest('path parameter "storeId" must be a UUID');
      const taskIdRaw = ctx.query.get('taskId');
      if (taskIdRaw !== null && !isUuid(taskIdRaw)) {
        throw badRequest('query param "taskId" must be a UUID');
      }
      const { rows, total } = await storeReceipts(pool, storeId.toLowerCase(), {
        taskId: taskIdRaw === null ? undefined : taskIdRaw.toLowerCase(),
        limit: queryLimit(ctx.query),
        offset: queryOffset(ctx.query),
      });
      sendJson(ctx.res, 200, {
        storeId: storeId.toLowerCase(),
        total,
        items: rows.map(receiptJson),
      });
    },

    /** GET /api/todos — pending assignments ordered by deadline, keyset-paginated. */
    async todos(ctx: RequestContext): Promise<void> {
      const dueBeforeRaw = ctx.query.get('dueBefore');
      const cursorRaw = ctx.query.get('cursor');
      const { rows, hasMore } = await todoPage(pool, {
        brandId: ctx.query.get('brandId') ?? undefined,
        dueBefore: dueBeforeRaw === null ? undefined : parseIsoDate(dueBeforeRaw, 'dueBefore'),
        limit: queryLimit(ctx.query),
        cursor: cursorRaw === null ? undefined : decodeTodoCursor(cursorRaw),
        at: now(),
      });
      const last = rows[rows.length - 1];
      sendJson(ctx.res, 200, {
        items: rows.map((row) => ({
          taskId: row.task_id,
          brandId: row.brand_id,
          batchCode: row.batch_code,
          batchVersion: row.batch_version,
          storeId: row.store_id,
          storeCode: row.store_code,
          storeName: row.store_name,
          region: row.region,
          deadlineAt: new Date(row.deadline_at).toISOString(),
          status: row.status,
          overdueDays: row.overdue_days,
        })),
        nextCursor: hasMore && last
          ? encodeTodoCursor({
              deadlineAt: new Date(last.deadline_at),
              taskId: last.task_id,
              storeId: last.store_id,
            })
          : null,
      });
    },

    /** GET /api/templates — notification templates and their rules. */
    async templates(ctx: RequestContext): Promise<void> {
      const brandId = ctx.query.get('brandId') ?? undefined;
      const rows = await listTemplates(pool, brandId);
      sendJson(ctx.res, 200, { items: rows.map(templateJson) });
    },
  };
}

function badRequestThrow(message: string): never {
  throw badRequest(message);
}
