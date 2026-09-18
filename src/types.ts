import type { Coverage } from "./coverage.js";
import { computeCoverage, effectiveStatus, overdueDays } from "./coverage.js";

/** recall_tasks 行（pg 返回的原始形态） */
export interface TaskRow {
  task_id: string;
  source_event_id: string;
  brand_id: string;
  lot_code: string;
  lot_version: number;
  reason_code: string;
  template_code: string;
  template_version: number;
  status: "open" | "closed";
  actor_role: string;
  published_at: Date;
  deadline_at: Date;
  total_notices: number;
  acknowledged_count: number;
  exempted_count: number;
  closed_at: Date | null;
  close_note: string | null;
  created_at: Date;
}

export interface TaskJson {
  task_id: string;
  source_event_id: string;
  brand_id: string;
  lot_code: string;
  lot_version: number;
  reason_code: string;
  template_code: string;
  template_version: number;
  status: "open" | "closed";
  actor_role: string;
  published_at: string;
  deadline_at: string;
  closed_at: string | null;
  coverage: Coverage;
  overdue_days: number;
  unconfirmed?: string[];
}

export function toTaskJson(
  row: TaskRow,
  now: Date,
  opts: { overdue?: number; unconfirmed?: string[] } = {},
): TaskJson {
  const overdue =
    opts.overdue ??
    // 未显式给出时按计数下限估算（仅 closed 任务允许这样兜底）
    0;
  const json: TaskJson = {
    task_id: row.task_id,
    source_event_id: row.source_event_id,
    brand_id: row.brand_id,
    lot_code: row.lot_code,
    lot_version: row.lot_version,
    reason_code: row.reason_code,
    template_code: row.template_code,
    template_version: row.template_version,
    status: row.status,
    actor_role: row.actor_role,
    published_at: row.published_at.toISOString(),
    deadline_at: row.deadline_at.toISOString(),
    closed_at: row.closed_at ? row.closed_at.toISOString() : null,
    coverage: computeCoverage({
      total: row.total_notices,
      acknowledged: row.acknowledged_count,
      exempted: row.exempted_count,
      overdue,
    }),
    overdue_days: overdueDays(row.deadline_at, now),
  };
  if (opts.unconfirmed !== undefined) json.unconfirmed = opts.unconfirmed;
  return json;
}

export interface NoticeRow {
  notice_id: string; // int8 -> string
  task_id: string;
  store_id: string;
  status: "pending" | "acknowledged" | "exempted";
  notified_at: Date;
  acknowledged_at: Date | null;
  late: boolean;
}

export interface NoticeView {
  notice_id: number;
  store_code: string;
  store_name: string;
  status: "pending" | "acknowledged" | "exempted" | "overdue";
  late: boolean;
  notified_at: string;
  acknowledged_at: string | null;
  overdue_days: number;
}

export function toNoticeView(
  row: NoticeRow & { store_code: string; store_name: string },
  deadline: Date,
  now: Date,
): NoticeView {
  const status = effectiveStatus(row.status, deadline, now);
  return {
    notice_id: Number(row.notice_id),
    store_code: row.store_code,
    store_name: row.store_name,
    status,
    late: row.late,
    notified_at: row.notified_at.toISOString(),
    acknowledged_at: row.acknowledged_at ? row.acknowledged_at.toISOString() : null,
    overdue_days: status === "overdue" ? overdueDays(deadline, now) : 0,
  };
}
