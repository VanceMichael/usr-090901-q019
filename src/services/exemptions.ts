import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTx } from '../db.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { recomputeSnapshot } from '../snapshot.js';
import { now } from '../time.js';

export interface ExemptionInput {
  storeId: string;
  reasonCode: string;
  reasonText: string;
}

export interface ExemptionResult {
  replay: boolean;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  exemption: any;
}

interface TemplateRules {
  exemptionReasonCodes?: string[];
  minReasonTextLength?: number;
}

/**
 * Request an exemption for one store of a task. Idempotent per (task, store):
 * a repeated request while one is still pending returns the original record.
 */
export async function requestExemption(
  pool: pg.Pool,
  taskId: string,
  input: ExemptionInput,
): Promise<ExemptionResult> {
  return withTx(pool, async (tx) => {
    const taskRes = await tx.query('SELECT * FROM recall_tasks WHERE id = $1 FOR UPDATE', [taskId]);
    if ((taskRes.rowCount ?? 0) === 0) {
      throw notFound('TASK_NOT_FOUND', `recall task ${taskId} not found`);
    }
    const task = taskRes.rows[0];
    if (task.status !== 'open') {
      throw conflict('TASK_CLOSED', `recall task ${taskId} is closed`);
    }

    const tsRes = await tx.query(
      'SELECT * FROM recall_task_stores WHERE task_id = $1 AND store_id = $2',
      [taskId, input.storeId],
    );
    if ((tsRes.rowCount ?? 0) === 0) {
      throw unprocessable('STORE_NOT_IN_TASK', `store ${input.storeId} is not assigned to task ${taskId}`);
    }
    const taskStore = tsRes.rows[0];
    if (taskStore.status === 'acknowledged') {
      throw conflict('STORE_ALREADY_ACKNOWLEDGED', `store ${input.storeId} already acknowledged task ${taskId}`);
    }
    if (taskStore.status === 'exempted') {
      throw conflict('STORE_ALREADY_EXEMPTED', `store ${input.storeId} is already exempted from task ${taskId}`);
    }

    // 豁免理由校验: reason code whitelist + minimum text length from the template rules.
    const tplRes = await tx.query('SELECT rules FROM notification_templates WHERE id = $1', [task.template_id]);
    const rules = ((tplRes.rowCount ?? 0) > 0 ? tplRes.rows[0].rules : {}) as TemplateRules;
    const allowedReasons = rules.exemptionReasonCodes ?? [];
    if (allowedReasons.length > 0 && !allowedReasons.includes(input.reasonCode)) {
      throw unprocessable(
        'INVALID_REASON_CODE',
        `reason code "${input.reasonCode}" is not allowed by the notification template`,
        { allowedReasonCodes: allowedReasons },
      );
    }
    const minLength = rules.minReasonTextLength ?? 1;
    if (input.reasonText.trim().length < minLength) {
      throw unprocessable(
        'REASON_TEXT_TOO_SHORT',
        `reasonText must have at least ${minLength} characters`,
        { minLength },
      );
    }

    const requestedAt = now();
    const inserted = await tx.query(
      `INSERT INTO exemption_requests (id, task_id, store_id, reason_code, reason_text, status, requested_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', $6)
       ON CONFLICT (task_id, store_id) WHERE status = 'pending' DO NOTHING
       RETURNING *`,
      [randomUUID(), taskId, input.storeId, input.reasonCode, input.reasonText, requestedAt.toISOString()],
    );
    if ((inserted.rowCount ?? 0) > 0) {
      return { replay: false, exemption: inserted.rows[0] };
    }
    const existing = await tx.query(
      `SELECT * FROM exemption_requests
        WHERE task_id = $1 AND store_id = $2 AND status = 'pending'`,
      [taskId, input.storeId],
    );
    return { replay: true, exemption: existing.rows[0] };
  });
}

export interface ReviewInput {
  decision: 'approved' | 'rejected';
  reviewer: string;
  note?: string;
}

/**
 * Review (approve/reject) a pending exemption. Approval flips the store to
 * `exempted` and recomputes the coverage snapshot in the same transaction.
 */
export async function reviewExemption(
  pool: pg.Pool,
  exemptionId: string,
  input: ReviewInput,
  /* eslint-disable @typescript-eslint/no-explicit-any */
): Promise<{ exemption: any; taskId: string }> {
  return withTx(pool, async (tx) => {
    const exRes = await tx.query('SELECT * FROM exemption_requests WHERE id = $1 FOR UPDATE', [exemptionId]);
    if ((exRes.rowCount ?? 0) === 0) {
      throw notFound('EXEMPTION_NOT_FOUND', `exemption request ${exemptionId} not found`);
    }
    const exemption = exRes.rows[0];
    if (exemption.status !== 'pending') {
      throw conflict('EXEMPTION_ALREADY_REVIEWED', `exemption ${exemptionId} is already ${exemption.status}`, {
        status: exemption.status,
      });
    }

    const taskRes = await tx.query('SELECT * FROM recall_tasks WHERE id = $1 FOR UPDATE', [exemption.task_id]);
    const task = taskRes.rows[0];
    if (!task || task.status !== 'open') {
      throw conflict('TASK_CLOSED', `recall task ${exemption.task_id} is closed`);
    }

    const reviewedAt = now();
    if (input.decision === 'approved') {
      const tsRes = await tx.query(
        'SELECT status FROM recall_task_stores WHERE task_id = $1 AND store_id = $2',
        [exemption.task_id, exemption.store_id],
      );
      if ((tsRes.rowCount ?? 0) > 0 && tsRes.rows[0].status === 'acknowledged') {
        throw conflict(
          'STORE_ALREADY_ACKNOWLEDGED',
          `store ${exemption.store_id} already acknowledged task ${exemption.task_id}`,
        );
      }
      await tx.query(
        `UPDATE recall_task_stores SET status = 'exempted', updated_at = $3
          WHERE task_id = $1 AND store_id = $2`,
        [exemption.task_id, exemption.store_id, reviewedAt.toISOString()],
      );
    }

    const updated = await tx.query(
      `UPDATE exemption_requests
         SET status = $2, reviewer = $3, review_note = $4, reviewed_at = $5
       WHERE id = $1
       RETURNING *`,
      [exemptionId, input.decision, input.reviewer, input.note ?? null, reviewedAt.toISOString()],
    );
    await recomputeSnapshot(tx, exemption.task_id, reviewedAt);
    return { exemption: updated.rows[0], taskId: exemption.task_id };
  });
}
