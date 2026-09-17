import type { Tx } from './db.js';

/**
 * Recompute the persisted coverage snapshot for a task from the source of
 * truth (`recall_task_stores`). Must be called inside the same transaction
 * as the mutation it follows, so snapshot counts can never drift from the
 * per-store rows. `at` is the "now" used for the pending/overdue split.
 */
export async function recomputeSnapshot(tx: Tx, taskId: string, at: Date): Promise<void> {
  await tx.query(
    `INSERT INTO coverage_snapshots AS cs
       (task_id, total_stores, acknowledged, late_acknowledged, exempted,
        pending, overdue, coverage_rate, computed_at, version)
     SELECT
       $1::uuid,
       COUNT(*)::int,
       COUNT(*) FILTER (WHERE rts.status = 'acknowledged')::int,
       COUNT(*) FILTER (WHERE rts.status = 'acknowledged' AND rts.receipt_late)::int,
       COUNT(*) FILTER (WHERE rts.status = 'exempted')::int,
       COUNT(*) FILTER (WHERE rts.status = 'pending' AND rt.deadline_at >= $2::timestamptz)::int,
       COUNT(*) FILTER (WHERE rts.status = 'pending' AND rt.deadline_at <  $2::timestamptz)::int,
       COALESCE(
         ROUND((COUNT(*) FILTER (WHERE rts.status IN ('acknowledged', 'exempted')))::numeric
               / NULLIF(COUNT(*), 0), 4),
         0
       ),
       $2::timestamptz,
       1
     FROM recall_task_stores rts
     JOIN recall_tasks rt ON rt.id = rts.task_id
     WHERE rts.task_id = $1::uuid
     GROUP BY rt.id
     ON CONFLICT (task_id) DO UPDATE SET
       total_stores      = EXCLUDED.total_stores,
       acknowledged      = EXCLUDED.acknowledged,
       late_acknowledged = EXCLUDED.late_acknowledged,
       exempted          = EXCLUDED.exempted,
       pending           = EXCLUDED.pending,
       overdue           = EXCLUDED.overdue,
       coverage_rate     = EXCLUDED.coverage_rate,
       computed_at       = EXCLUDED.computed_at,
       version           = cs.version + 1`,
    [taskId, at.toISOString()],
  );
}
