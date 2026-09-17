import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { withTx } from '../db.js';
import { ApiError, conflict, notFound, unprocessable } from '../errors.js';
import { recomputeSnapshot } from '../snapshot.js';
import { FUTURE_TOLERANCE_MS, now, overdueDays } from '../time.js';

export interface ReceiptInput {
  storeId: string;
  receiptTime: Date;
  channel: string;
  note?: string;
}

export interface ReceiptItemError {
  code: string;
  message: string;
}

export interface ReceiptItemResult {
  index: number;
  ok: boolean;
  storeId?: string;
  status?: string;
  late?: boolean;
  duplicate?: boolean;
  error?: ReceiptItemError;
}

/** An item that failed per-item validation before any DB work. */
export interface InvalidReceiptItem {
  index: number;
  error: ReceiptItemError;
}

export type PreparedReceiptItem =
  | { index: number; input: ReceiptInput }
  | InvalidReceiptItem;

export function isInvalidItem(item: PreparedReceiptItem): item is InvalidReceiptItem {
  return 'error' in item;
}

/**
 * Process one receipt in its own transaction. Per-store mutations of the
 * same task are serialized with SELECT ... FOR UPDATE on the task row, so
 * the snapshot recompute always observes every previously committed receipt.
 */
async function processOne(
  pool: pg.Pool,
  taskId: string,
  item: ReceiptInput,
): Promise<{ status: string; late: boolean; duplicate: boolean }> {
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
      [taskId, item.storeId],
    );
    if ((tsRes.rowCount ?? 0) === 0) {
      throw unprocessable('STORE_NOT_IN_TASK', `store ${item.storeId} is not assigned to task ${taskId}`);
    }
    const taskStore = tsRes.rows[0];

    const tplRes = await tx.query('SELECT rules FROM notification_templates WHERE id = $1', [task.template_id]);
    const rules = ((tplRes.rowCount ?? 0) > 0 ? tplRes.rows[0].rules : {}) as {
      allowedChannels?: string[];
    };
    const allowedChannels = rules.allowedChannels ?? [];
    if (allowedChannels.length > 0 && !allowedChannels.includes(item.channel)) {
      throw unprocessable(
        'INVALID_CHANNEL',
        `channel "${item.channel}" is not allowed by the notification template`,
        { allowedChannels },
      );
    }

    // 回执时间校验
    const serverNow = now();
    if (item.receiptTime.getTime() > serverNow.getTime() + FUTURE_TOLERANCE_MS) {
      throw unprocessable('RECEIPT_TIME_IN_FUTURE', 'receiptTime is in the future');
    }
    const publishedAt = new Date(task.published_at as string);
    if (item.receiptTime.getTime() < publishedAt.getTime()) {
      throw unprocessable('RECEIPT_BEFORE_PUBLISH', 'receiptTime is before the task was published');
    }

    if (taskStore.status === 'exempted') {
      throw conflict('STORE_ALREADY_EXEMPTED', `store ${item.storeId} is exempted from task ${taskId}`);
    }

    if (taskStore.status === 'acknowledged') {
      // Idempotent re-acknowledgement: keep the original state, log the attempt.
      await tx.query(
        `INSERT INTO receipts (id, task_id, store_id, receipt_time, received_at, channel, note, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'duplicate')`,
        [randomUUID(), taskId, item.storeId, item.receiptTime.toISOString(), serverNow.toISOString(), item.channel, item.note ?? null],
      );
      return { status: 'acknowledged', late: taskStore.receipt_late as boolean, duplicate: true };
    }

    const deadline = new Date(task.deadline_at as string);
    const late = item.receiptTime.getTime() > deadline.getTime();
    const overdueDaysAtAck = late ? overdueDays(deadline, item.receiptTime) : 0;

    await tx.query(
      `UPDATE recall_task_stores
         SET status = 'acknowledged',
             acknowledged_at = $3,
             receipt_late = $4,
             overdue_days_at_ack = $5,
             updated_at = $6
       WHERE task_id = $1 AND store_id = $2`,
      [taskId, item.storeId, item.receiptTime.toISOString(), late, overdueDaysAtAck, serverNow.toISOString()],
    );
    await tx.query(
      `INSERT INTO receipts (id, task_id, store_id, receipt_time, received_at, channel, note, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        randomUUID(),
        taskId,
        item.storeId,
        item.receiptTime.toISOString(),
        serverNow.toISOString(),
        item.channel,
        item.note ?? null,
        late ? 'accepted_late' : 'accepted',
      ],
    );
    await recomputeSnapshot(tx, taskId, serverNow);
    return { status: 'acknowledged', late, duplicate: false };
  });
}

/**
 * Submit a batch of receipts. Every item is processed independently: item
 * failures are reported at their input index and never abort the batch.
 */
export async function submitReceipts(
  pool: pg.Pool,
  taskId: string,
  items: PreparedReceiptItem[],
): Promise<ReceiptItemResult[]> {
  const results: ReceiptItemResult[] = [];
  for (const item of items) {
    if (isInvalidItem(item)) {
      results.push({ index: item.index, ok: false, error: item.error });
      continue;
    }
    try {
      const outcome = await processOne(pool, taskId, item.input);
      results.push({
        index: item.index,
        ok: true,
        storeId: item.input.storeId,
        status: outcome.status,
        late: outcome.late,
        duplicate: outcome.duplicate,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        results.push({
          index: item.index,
          ok: false,
          storeId: item.input.storeId,
          error: { code: err.code, message: err.message },
        });
      } else {
        throw err;
      }
    }
  }
  return results;
}
