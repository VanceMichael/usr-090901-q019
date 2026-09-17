/* eslint-disable @typescript-eslint/no-explicit-any */

const iso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value as string).toISOString();
};

export function taskJson(row: any): Record<string, unknown> {
  return {
    taskId: row.id,
    idempotencyKey: row.idempotency_key,
    brandId: row.brand_id,
    batchCode: row.batch_code,
    batchVersion: row.batch_version,
    templateId: row.template_id,
    status: row.status,
    publishedAt: iso(row.published_at),
    deadlineAt: iso(row.deadline_at),
    closedAt: iso(row.closed_at),
    closeReason: row.close_reason ?? null,
  };
}

export function snapshotJson(row: any): Record<string, unknown> {
  return {
    taskId: row.task_id,
    totalStores: row.total_stores,
    acknowledged: row.acknowledged,
    lateAcknowledged: row.late_acknowledged,
    exempted: row.exempted,
    pending: row.pending,
    overdue: row.overdue,
    coverageRate: Number(row.coverage_rate),
    computedAt: iso(row.computed_at),
    version: row.version,
  };
}

export function exemptionJson(row: any): Record<string, unknown> {
  return {
    exemptionId: row.id,
    taskId: row.task_id,
    storeId: row.store_id,
    reasonCode: row.reason_code,
    reasonText: row.reason_text,
    status: row.status,
    reviewer: row.reviewer ?? null,
    reviewNote: row.review_note ?? null,
    requestedAt: iso(row.requested_at),
    reviewedAt: iso(row.reviewed_at),
  };
}

export function receiptJson(row: any): Record<string, unknown> {
  return {
    receiptId: row.id,
    taskId: row.task_id,
    storeId: row.store_id,
    ...(row.brand_id !== undefined ? { brandId: row.brand_id } : {}),
    ...(row.batch_code !== undefined ? { batchCode: row.batch_code } : {}),
    ...(row.batch_version !== undefined ? { batchVersion: row.batch_version } : {}),
    receiptTime: iso(row.receipt_time),
    receivedAt: iso(row.received_at),
    channel: row.channel,
    note: row.note ?? null,
    outcome: row.outcome,
  };
}

export function templateJson(row: any): Record<string, unknown> {
  return {
    templateId: row.id,
    brandId: row.brand_id,
    name: row.name,
    channel: row.channel,
    body: row.body,
    rules: row.rules,
  };
}
