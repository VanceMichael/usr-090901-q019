import type pg from 'pg';
import { withTx } from '../db.js';
import { notFound } from '../errors.js';
import { recomputeSnapshot } from '../snapshot.js';
import { now } from '../time.js';

export interface CloseResult {
  replay: boolean;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  task: any;
}

/**
 * Close a recall task. Idempotent: closing an already-closed task returns the
 * current state. The final coverage snapshot is recomputed in the same
 * transaction as the status flip.
 */
export async function closeTask(pool: pg.Pool, taskId: string, reason?: string): Promise<CloseResult> {
  return withTx(pool, async (tx) => {
    const taskRes = await tx.query('SELECT * FROM recall_tasks WHERE id = $1 FOR UPDATE', [taskId]);
    if ((taskRes.rowCount ?? 0) === 0) {
      throw notFound('TASK_NOT_FOUND', `recall task ${taskId} not found`);
    }
    const task = taskRes.rows[0];
    if (task.status === 'closed') {
      return { replay: true, task };
    }
    const closedAt = now();
    const updated = await tx.query(
      `UPDATE recall_tasks
         SET status = 'closed', closed_at = $2, close_reason = $3
       WHERE id = $1
       RETURNING *`,
      [taskId, closedAt.toISOString(), reason ?? null],
    );
    await recomputeSnapshot(tx, taskId, closedAt);
    return { replay: false, task: updated.rows[0] };
  });
}
