import type pg from 'pg';
import { notFound } from '../errors.js';
import type { TodoCursor } from '../cursor.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Live (as-of-now) pending/overdue split for one task. */
export async function currentCounts(pool: pg.Pool, taskId: string, at: Date): Promise<any> {
  const res = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE rts.status = 'pending' AND rt.deadline_at >= $2::timestamptz)::int AS pending,
       COUNT(*) FILTER (WHERE rts.status = 'pending' AND rt.deadline_at <  $2::timestamptz)::int AS overdue,
       COALESCE(MAX(
         GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - rt.deadline_at)) / 86400))::int
       ) FILTER (WHERE rts.status = 'pending' AND rt.deadline_at < $2::timestamptz), 0) AS max_overdue_days
     FROM recall_task_stores rts
     JOIN recall_tasks rt ON rt.id = rts.task_id
     WHERE rts.task_id = $1
     GROUP BY rt.id`,
    [taskId, at.toISOString()],
  );
  return (res.rowCount ?? 0) > 0
    ? res.rows[0]
    : { pending: 0, overdue: 0, max_overdue_days: 0 };
}

/** Unconfirmed stores (still pending; overdue flagged live) for one task. */
export async function unconfirmedStores(pool: pg.Pool, taskId: string, at: Date): Promise<any[]> {
  const res = await pool.query(
    `SELECT
       rts.store_id,
       s.store_code,
       s.name,
       s.region,
       rt.deadline_at,
       CASE WHEN rt.deadline_at < $2::timestamptz THEN 'overdue' ELSE 'pending' END AS status,
       GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($2::timestamptz - rt.deadline_at)) / 86400))::int AS overdue_days
     FROM recall_task_stores rts
     JOIN stores s ON s.id = rts.store_id
     JOIN recall_tasks rt ON rt.id = rts.task_id
     WHERE rts.task_id = $1 AND rts.status = 'pending'
     ORDER BY overdue_days DESC, s.store_code ASC`,
    [taskId, at.toISOString()],
  );
  return res.rows;
}

/** Brand-level progress: every task with its persisted snapshot + live counts. */
export async function brandProgress(pool: pg.Pool, brandId: string, at: Date): Promise<any> {
  const brandRes = await pool.query('SELECT id, name FROM brands WHERE id = $1', [brandId]);
  if ((brandRes.rowCount ?? 0) === 0) {
    throw notFound('BRAND_NOT_FOUND', `brand "${brandId}" not found`);
  }
  const tasksRes = await pool.query(
    `SELECT rt.*, cs.total_stores, cs.acknowledged, cs.late_acknowledged, cs.exempted,
            cs.pending AS snap_pending, cs.overdue AS snap_overdue,
            cs.coverage_rate, cs.computed_at, cs.version AS snapshot_version
     FROM recall_tasks rt
     LEFT JOIN coverage_snapshots cs ON cs.task_id = rt.id
     WHERE rt.brand_id = $1
     ORDER BY rt.published_at DESC`,
    [brandId],
  );
  const liveRes = await pool.query(
    `SELECT rts.task_id,
       COUNT(*) FILTER (WHERE rts.status = 'pending' AND rt.deadline_at >= $2::timestamptz)::int AS pending,
       COUNT(*) FILTER (WHERE rts.status = 'pending' AND rt.deadline_at <  $2::timestamptz)::int AS overdue
     FROM recall_task_stores rts
     JOIN recall_tasks rt ON rt.id = rts.task_id
     WHERE rt.brand_id = $1
     GROUP BY rts.task_id`,
    [brandId, at.toISOString()],
  );
  const live = new Map<string, { pending: number; overdue: number }>(
    liveRes.rows.map((r) => [r.task_id as string, { pending: r.pending, overdue: r.overdue }]),
  );

  const tasks = tasksRes.rows.map((row) => ({
    taskId: row.id,
    batchCode: row.batch_code,
    batchVersion: row.batch_version,
    status: row.status,
    publishedAt: new Date(row.published_at).toISOString(),
    deadlineAt: new Date(row.deadline_at).toISOString(),
    snapshot:
      row.total_stores === null
        ? null
        : {
            totalStores: row.total_stores,
            acknowledged: row.acknowledged,
            lateAcknowledged: row.late_acknowledged,
            exempted: row.exempted,
            pending: row.snap_pending,
            overdue: row.snap_overdue,
            coverageRate: Number(row.coverage_rate),
            computedAt: new Date(row.computed_at).toISOString(),
            version: row.snapshot_version,
          },
    current: live.get(row.id) ?? { pending: 0, overdue: 0 },
  }));

  const summary = tasks.reduce(
    (acc, t) => {
      acc.totalStores += t.snapshot?.totalStores ?? 0;
      acc.acknowledged += t.snapshot?.acknowledged ?? 0;
      acc.exempted += t.snapshot?.exempted ?? 0;
      acc.pending += t.current.pending;
      acc.overdue += t.current.overdue;
      if (t.status === 'open') acc.openTasks += 1;
      else acc.closedTasks += 1;
      return acc;
    },
    { openTasks: 0, closedTasks: 0, totalStores: 0, acknowledged: 0, exempted: 0, pending: 0, overdue: 0 },
  );
  const done = summary.acknowledged + summary.exempted;
  const coverageRate = summary.totalStores === 0 ? 0 : Math.round((done / summary.totalStores) * 10000) / 10000;

  return {
    brand: { brandId: brandRes.rows[0].id, name: brandRes.rows[0].name },
    summary: { ...summary, coverageRate },
    tasks,
  };
}

/** Receipt history for one store, newest first. */
export async function storeReceipts(
  pool: pg.Pool,
  storeId: string,
  opts: { taskId?: string; limit: number; offset: number },
): Promise<{ rows: any[]; total: number }> {
  const storeRes = await pool.query('SELECT id FROM stores WHERE id = $1', [storeId]);
  if ((storeRes.rowCount ?? 0) === 0) {
    throw notFound('STORE_NOT_FOUND', `store ${storeId} not found`);
  }
  const params: unknown[] = [storeId];
  let taskFilter = '';
  if (opts.taskId !== undefined) {
    params.push(opts.taskId);
    taskFilter = `AND r.task_id = $${params.length}`;
  }
  const totalRes = await pool.query(
    `SELECT COUNT(*)::int AS c FROM receipts r WHERE r.store_id = $1 ${taskFilter}`,
    params,
  );
  params.push(opts.limit, opts.offset);
  const rows = await pool.query(
    `SELECT r.*, rt.brand_id, rt.batch_code, rt.batch_version
     FROM receipts r
     JOIN recall_tasks rt ON rt.id = r.task_id
     WHERE r.store_id = $1 ${taskFilter}
     ORDER BY r.created_at DESC, r.id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows: rows.rows, total: totalRes.rows[0].c };
}

export interface TodoQuery {
  brandId?: string;
  dueBefore?: Date;
  limit: number;
  cursor?: TodoCursor;
  at: Date;
}

/**
 * Pending (task, store) assignments ordered by deadline — the brand's to-do
 * list. Keyset pagination via a stateless cursor, stable across restarts.
 */
export async function todoPage(pool: pg.Pool, q: TodoQuery): Promise<{ rows: any[]; hasMore: boolean }> {
  const ZERO_UUID = '00000000-0000-0000-0000-000000000000';
  const res = await pool.query(
    `SELECT
       rt.id AS task_id,
       rt.brand_id,
       rt.batch_code,
       rt.batch_version,
       rt.deadline_at,
       rts.store_id,
       s.store_code,
       s.name AS store_name,
       s.region,
       CASE WHEN rt.deadline_at < $5::timestamptz THEN 'overdue' ELSE 'pending' END AS status,
       GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($5::timestamptz - rt.deadline_at)) / 86400))::int AS overdue_days
     FROM recall_task_stores rts
     JOIN recall_tasks rt ON rt.id = rts.task_id
     JOIN stores s ON s.id = rts.store_id
     WHERE rt.status = 'open'
       AND rts.status = 'pending'
       AND ($1::text IS NULL OR rt.brand_id = $1)
       AND ($2::timestamptz IS NULL OR rt.deadline_at <= $2::timestamptz)
       AND ($3::timestamptz IS NULL OR (rt.deadline_at, rt.id, rts.store_id) > ($3::timestamptz, $4::uuid, $6::uuid))
     ORDER BY rt.deadline_at ASC, rt.id ASC, rts.store_id ASC
     LIMIT $7`,
    [
      q.brandId ?? null,
      q.dueBefore ? q.dueBefore.toISOString() : null,
      q.cursor ? q.cursor.deadlineAt.toISOString() : null,
      q.cursor ? q.cursor.taskId : ZERO_UUID,
      q.at.toISOString(),
      q.cursor ? q.cursor.storeId : ZERO_UUID,
      q.limit + 1,
    ],
  );
  const hasMore = res.rows.length > q.limit;
  return { rows: hasMore ? res.rows.slice(0, q.limit) : res.rows, hasMore };
}

export async function listTemplates(pool: pg.Pool, brandId?: string): Promise<any[]> {
  const res = brandId === undefined
    ? await pool.query('SELECT * FROM notification_templates ORDER BY brand_id, name')
    : await pool.query('SELECT * FROM notification_templates WHERE brand_id = $1 ORDER BY name', [brandId]);
  return res.rows;
}
