import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTx } from '../db.js';
import { ApiError, notFound, unprocessable } from '../errors.js';
import { recomputeSnapshot } from '../snapshot.js';
import { now } from '../time.js';

export interface PublishInput {
  idempotencyKey: string;
  brandId: string;
  batchCode: string;
  batchVersion: number;
  templateId: string;
  deadlineAt?: Date;
  storeIds?: string[];
}

export interface PublishResult {
  replay: boolean;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  task: any;
  storeCount: number;
}

interface TemplateRules {
  ackDeadlineHours?: number;
  allowedChannels?: string[];
  exemptionReasonCodes?: string[];
  minReasonTextLength?: number;
}

const DEFAULT_ACK_DEADLINE_HOURS = 72;

async function countTaskStores(tx: Pick<pg.PoolClient, 'query'>, taskId: string): Promise<number> {
  const res = await tx.query(
    'SELECT COUNT(*)::int AS c FROM recall_task_stores WHERE task_id = $1',
    [taskId],
  );
  return res.rows[0].c;
}

/**
 * Publish a recall task. Idempotent on `idempotencyKey`: a duplicate publish
 * returns the original task (`replay: true`) without touching any rows.
 *
 * The task row, its per-store assignments and the initial coverage snapshot
 * are written in a single transaction, so counts are consistent by construction.
 */
export async function publishRecall(pool: pg.Pool, input: PublishInput): Promise<PublishResult> {
  // Fast path: a task with this idempotency key already exists.
  const existing = await pool.query(
    'SELECT * FROM recall_tasks WHERE idempotency_key = $1',
    [input.idempotencyKey],
  );
  if ((existing.rowCount ?? 0) > 0) {
    const task = existing.rows[0];
    return { replay: true, task, storeCount: await countTaskStores(pool, task.id) };
  }

  return withTx(pool, async (tx) => {
    // 批次版本校验: the request must target the batch's current version.
    const batchRes = await tx.query(
      'SELECT * FROM batches WHERE brand_id = $1 AND batch_code = $2',
      [input.brandId, input.batchCode],
    );
    if ((batchRes.rowCount ?? 0) === 0) {
      throw notFound('BATCH_NOT_FOUND', `batch "${input.batchCode}" not found for brand "${input.brandId}"`);
    }
    const batch = batchRes.rows[0];
    if (batch.current_version !== input.batchVersion) {
      throw unprocessable(
        'BATCH_VERSION_MISMATCH',
        `batch "${input.batchCode}" is at version ${batch.current_version}, but version ${input.batchVersion} was requested`,
        { currentVersion: batch.current_version },
      );
    }

    const tplRes = await tx.query(
      'SELECT * FROM notification_templates WHERE id = $1 AND brand_id = $2',
      [input.templateId, input.brandId],
    );
    if ((tplRes.rowCount ?? 0) === 0) {
      throw notFound('TEMPLATE_NOT_FOUND', `template ${input.templateId} not found for brand "${input.brandId}"`);
    }
    const rules = tplRes.rows[0].rules as TemplateRules;

    // 门店归属校验: every targeted store must belong to the brand and be active.
    let storeIds: string[];
    if (input.storeIds !== undefined) {
      const res = await tx.query(
        'SELECT id, active FROM stores WHERE brand_id = $1 AND id = ANY($2::uuid[])',
        [input.brandId, input.storeIds],
      );
      const found = new Map<string, boolean>(res.rows.map((r) => [r.id as string, r.active as boolean]));
      const missing = input.storeIds.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw unprocessable('STORE_NOT_IN_BRAND', 'some stores do not belong to this brand', { storeIds: missing });
      }
      const inactive = input.storeIds.filter((id) => found.get(id) === false);
      if (inactive.length > 0) {
        throw unprocessable('STORE_INACTIVE', 'some stores are inactive', { storeIds: inactive });
      }
      storeIds = [...new Set(input.storeIds)];
    } else {
      const res = await tx.query(
        'SELECT id FROM stores WHERE brand_id = $1 AND active ORDER BY store_code',
        [input.brandId],
      );
      storeIds = res.rows.map((r) => r.id as string);
    }
    if (storeIds.length === 0) {
      throw unprocessable('NO_ELIGIBLE_STORES', `brand "${input.brandId}" has no active stores to notify`);
    }

    const publishedAt = now();
    const deadlineHours = rules.ackDeadlineHours ?? DEFAULT_ACK_DEADLINE_HOURS;
    const deadline = input.deadlineAt ?? new Date(publishedAt.getTime() + deadlineHours * 3_600_000);
    if (deadline.getTime() <= publishedAt.getTime()) {
      throw unprocessable('DEADLINE_IN_PAST', 'deadlineAt must be in the future');
    }

    const inserted = await tx.query(
      `INSERT INTO recall_tasks
         (id, idempotency_key, brand_id, batch_id, batch_code, batch_version,
          template_id, status, published_at, deadline_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING *`,
      [
        randomUUID(),
        input.idempotencyKey,
        input.brandId,
        batch.id,
        input.batchCode,
        input.batchVersion,
        input.templateId,
        publishedAt.toISOString(),
        deadline.toISOString(),
      ],
    );

    if ((inserted.rowCount ?? 0) === 0) {
      // Lost a concurrent race on the same idempotency key: return the winner.
      const winner = await tx.query('SELECT * FROM recall_tasks WHERE idempotency_key = $1', [input.idempotencyKey]);
      const task = winner.rows[0];
      return { replay: true, task, storeCount: await countTaskStores(tx, task.id) };
    }

    const task = inserted.rows[0];
    const params: unknown[] = [task.id, ...storeIds, publishedAt.toISOString()];
    const tuples = storeIds
      .map((_, i) => `($1::uuid, $${i + 2}::uuid, 'pending', $${storeIds.length + 2}::timestamptz)`)
      .join(', ');
    await tx.query(
      `INSERT INTO recall_task_stores (task_id, store_id, status, updated_at) VALUES ${tuples}`,
      params,
    );
    await recomputeSnapshot(tx, task.id, publishedAt);

    return { replay: false, task, storeCount: storeIds.length };
  });
}

export async function getSnapshotRow(pool: pg.Pool, taskId: string): Promise<unknown | null> {
  const res = await pool.query('SELECT * FROM coverage_snapshots WHERE task_id = $1', [taskId]);
  return (res.rowCount ?? 0) > 0 ? res.rows[0] : null;
}

export async function getTaskRow(pool: pg.Pool, taskId: string): Promise<unknown | null> {
  const res = await pool.query('SELECT * FROM recall_tasks WHERE id = $1', [taskId]);
  return (res.rowCount ?? 0) > 0 ? res.rows[0] : null;
}

export function assertTaskExists(task: unknown | null, taskId: string): asserts task {
  if (task === null || task === undefined) {
    throw new ApiError(404, 'TASK_NOT_FOUND', `recall task ${taskId} not found`);
  }
}
