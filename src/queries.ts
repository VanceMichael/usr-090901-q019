import type { AppConfig } from "./config.js";
import { decodeHistoryCursor, decodeTodoCursor, encodeHistoryCursor, encodeTodoCursor } from "./cursor.js";
import type { Database } from "./db.js";
import { notFound, unprocessable } from "./errors.js";
import type { RulesFixture } from "./rules.js";
import { toNoticeView, toTaskJson, type NoticeRow, type TaskRow } from "./types.js";
import { parseLimit } from "./validate.js";

interface Ctx {
  db: Database;
  rules: RulesFixture;
  cfg: AppConfig;
  now: () => Date;
}

// ---------- 按品牌查看召回进度 ----------

export async function getBrandProgress(ctx: Ctx, brandId: string): Promise<unknown> {
  const { db } = ctx;
  const now = ctx.now();
  const brand = await db.query("SELECT brand_id, name FROM brands WHERE brand_id = $1", [brandId]);
  if (brand.rowCount === 0) throw notFound("brand_not_found", `品牌 ${brandId} 不存在`);

  const { rows: tasks } = await db.query<TaskRow>(
    "SELECT * FROM recall_tasks WHERE brand_id = $1 ORDER BY published_at DESC, task_id",
    [brandId],
  );
  const items = [];
  for (const t of tasks) {
    const overdue = await liveOverdue(db, t.task_id, now);
    const unconfirmed = await unconfirmedList(db, t.task_id);
    items.push(toTaskJson(t, now, { overdue, unconfirmed }));
  }
  return { brand_id: brandId, brand_name: brand.rows[0]!.name as string, generated_at: now.toISOString(), tasks: items };
}

async function liveOverdue(db: Database, taskId: string, now: Date): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM recall_notices n
     JOIN recall_tasks t ON t.task_id = n.task_id
     WHERE n.task_id = $1 AND n.status = 'pending' AND t.deadline_at < $2`,
    [taskId, now],
  );
  return Number(rows[0]?.n ?? 0);
}

async function unconfirmedList(db: Database, taskId: string): Promise<string[]> {
  const { rows } = await db.query<{ store_code: string }>(
    `SELECT s.store_code FROM recall_notices n
     JOIN stores s ON s.store_id = n.store_id
     WHERE n.task_id = $1 AND n.status = 'pending' ORDER BY s.store_code`,
    [taskId],
  );
  return rows.map((r) => r.store_code);
}

// ---------- 任务详情（含每门店状态与最新快照） ----------

export async function getTaskDetail(ctx: Ctx, taskId: string): Promise<unknown> {
  const { db } = ctx;
  const now = ctx.now();
  const { rows } = await db.query<TaskRow>("SELECT * FROM recall_tasks WHERE task_id = $1", [taskId]);
  const task = rows[0];
  if (!task) throw notFound("task_not_found", `召回任务 ${taskId} 不存在`);

  const notices = await db.query<NoticeRow & { store_code: string; store_name: string }>(
    `SELECT n.*, s.store_code, s.name AS store_name
     FROM recall_notices n JOIN stores s ON s.store_id = n.store_id
     WHERE n.task_id = $1 ORDER BY s.store_code`,
    [taskId],
  );
  const stores = notices.rows.map((n) => toNoticeView(n, task.deadline_at, now));

  // 用明细表现算计数，与任务行计数交叉校验（事务一致性由写入侧保证）
  const live = { total: stores.length, acknowledged: 0, exempted: 0, overdue: 0 };
  for (const s of stores) {
    if (s.status === "acknowledged") live.acknowledged++;
    else if (s.status === "exempted") live.exempted++;
    else if (s.status === "overdue") live.overdue++;
  }

  const snap = await db.query(
    `SELECT snapshot_id, trigger, computed_at, total, acknowledged, exempted, pending, overdue, coverage_rate
     FROM coverage_snapshots WHERE task_id = $1 ORDER BY snapshot_id DESC LIMIT 1`,
    [taskId],
  );

  const overdue = live.overdue;
  const unconfirmed = stores.filter((s) => s.status === "pending" || s.status === "overdue").map((s) => s.store_code);
  return {
    ...toTaskJson(task, now, { overdue, unconfirmed }),
    live_counts: live,
    stores,
    latest_snapshot: snap.rows[0] ?? null,
  };
}

// ---------- 单门店回执历史（回执 + 豁免，键集分页） ----------

export async function getStoreHistory(ctx: Ctx, storeCode: string, query: URLSearchParams): Promise<unknown> {
  const { db, cfg } = ctx;
  const limit = parseLimit(query.get("limit") ?? undefined, cfg.defaultPageSize, cfg.maxPageSize);
  const cursorRaw = query.get("cursor") ?? undefined;

  const storeRes = await db.query<{ store_id: string; store_code: string; name: string; brand_id: string }>(
    "SELECT store_id, store_code, name, brand_id FROM stores WHERE store_code = $1",
    [storeCode],
  );
  const store = storeRes.rows[0];
  if (!store) throw notFound("store_not_found", `门店 ${storeCode} 不存在`);

  const params: unknown[] = [store.store_id];
  let cursorClause = "";
  if (cursorRaw !== undefined) {
    const c = decodeHistoryCursor(cursorRaw);
    cursorClause = "AND (recorded_at, id) < ($2::timestamptz, $3::bigint)";
    params.push(c.r, c.i);
  }

  const { rows } = await db.query<{
    kind: "receipt" | "exemption";
    id: string;
    recorded_at: Date;
    task_id: string;
    lot_code: string;
    lot_version: number;
    payload: Record<string, unknown>;
  }>(
    `SELECT * FROM (
       SELECT 'receipt'::text AS kind, r.receipt_id AS id, r.recorded_at, r.task_id,
              jsonb_build_object('received_at', r.received_at, 'channel', r.channel,
                                 'note', r.note, 'result', r.result, 'source_event_id', r.source_event_id) AS payload
       FROM receipts r WHERE r.store_id = $1
       UNION ALL
       SELECT 'exemption'::text, e.exemption_id, e.applied_at, e.task_id,
              jsonb_build_object('reason_code', e.reason_code, 'reason_text', e.reason_text,
                                 'status', e.status, 'reviewed_by', e.reviewed_by,
                                 'reviewed_at', e.reviewed_at, 'source_event_id', e.source_event_id)
       FROM exemptions e WHERE e.store_id = $1
     ) h
     WHERE true ${cursorClause}
     ORDER BY recorded_at DESC, id DESC
     LIMIT ${limit + 1}`,
    params,
  );

  const taskIds = [...new Set(rows.map((r) => r.task_id))];
  const tasks = taskIds.length
    ? await db.query<{ task_id: string; lot_code: string; lot_version: number }>(
        "SELECT task_id, lot_code, lot_version FROM recall_tasks WHERE task_id = ANY($1)",
        [taskIds],
      )
    : { rows: [] as { task_id: string; lot_code: string; lot_version: number }[] };
  const taskMap = new Map(tasks.rows.map((t) => [t.task_id, t]));

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = page.map((r) => {
    const t = taskMap.get(r.task_id);
    return {
      kind: r.kind,
      id: Number(r.id),
      recorded_at: r.recorded_at.toISOString(),
      task_id: r.task_id,
      lot_code: t?.lot_code ?? null,
      lot_version: t?.lot_version ?? null,
      ...r.payload,
    };
  });
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeHistoryCursor({ r: last.recorded_at.toISOString(), i: Number(last.id) })
      : null;

  return {
    store: { store_code: store.store_code, name: store.name, brand_id: store.brand_id },
    items,
    next_cursor: nextCursor,
  };
}

// ---------- 按期限分页的待办 ----------

export async function getTodos(ctx: Ctx, query: URLSearchParams): Promise<unknown> {
  const { db, cfg } = ctx;
  const now = ctx.now();
  const limit = parseLimit(query.get("limit") ?? undefined, cfg.defaultPageSize, cfg.maxPageSize);
  const brandId = query.get("brand_id") ?? undefined;
  const statusFilter = query.get("status") ?? "all"; // all | pending | overdue
  if (!["all", "pending", "overdue"].includes(statusFilter)) {
    throw unprocessable("invalid_field", "status 必须为 all | pending | overdue", { field: "status" });
  }
  const dueBeforeRaw = query.get("due_before") ?? undefined;
  let dueBefore: Date | undefined;
  if (dueBeforeRaw !== undefined) {
    const t = Date.parse(dueBeforeRaw);
    if (Number.isNaN(t)) throw unprocessable("invalid_field", "due_before 必须为 RFC3339 时间", { field: "due_before" });
    dueBefore = new Date(t);
  }
  const cursorRaw = query.get("cursor") ?? undefined;

  const params: unknown[] = [];
  const clauses: string[] = ["n.status = 'pending'", "t.status = 'open'"];
  if (brandId !== undefined) {
    params.push(brandId);
    clauses.push(`t.brand_id = $${params.length}`);
  }
  if (dueBefore !== undefined) {
    params.push(dueBefore);
    clauses.push(`t.deadline_at <= $${params.length}`);
  }
  // 逾期过滤相对于当前时间
  if (statusFilter === "overdue") {
    params.push(now);
    clauses.push(`t.deadline_at < $${params.length}`);
  } else if (statusFilter === "pending") {
    params.push(now);
    clauses.push(`t.deadline_at >= $${params.length}`);
  }
  if (cursorRaw !== undefined) {
    const c = decodeTodoCursor(cursorRaw);
    params.push(c.d, c.n);
    clauses.push(`(t.deadline_at, n.notice_id) > ($${params.length - 1}::timestamptz, $${params.length}::bigint)`);
  }

  const { rows } = await db.query<{
    notice_id: string;
    task_id: string;
    store_code: string;
    store_name: string;
    brand_id: string;
    lot_code: string;
    lot_version: number;
    deadline_at: Date;
    notified_at: Date;
  }>(
    `SELECT n.notice_id, n.task_id, n.notified_at,
            s.store_code, s.name AS store_name,
            t.brand_id, t.lot_code, t.lot_version, t.deadline_at
     FROM recall_notices n
     JOIN recall_tasks t ON t.task_id = n.task_id
     JOIN stores s ON s.store_id = n.store_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY t.deadline_at ASC, n.notice_id ASC
     LIMIT ${limit + 1}`,
    params,
  );

  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const items = page.map((r) => {
    const overdue = r.deadline_at.getTime() < now.getTime();
    return {
      notice_id: Number(r.notice_id),
      task_id: r.task_id,
      brand_id: r.brand_id,
      lot_code: r.lot_code,
      lot_version: r.lot_version,
      store_code: r.store_code,
      store_name: r.store_name,
      status: overdue ? "overdue" : "pending",
      deadline_at: r.deadline_at.toISOString(),
      notified_at: r.notified_at.toISOString(),
      overdue_days: overdue ? Math.ceil((now.getTime() - r.deadline_at.getTime()) / 86_400_000) : 0,
    };
  });
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeTodoCursor({ d: last.deadline_at.toISOString(), n: Number(last.notice_id) })
      : null;
  return { items, next_cursor: nextCursor, generated_at: now.toISOString() };
}

// ---------- 模板与规则查询 ----------

export async function getTemplates(ctx: Ctx, query: URLSearchParams): Promise<unknown> {
  const { db, rules } = ctx;
  const reasonCode = query.get("reason_code") ?? undefined;
  if (reasonCode !== undefined && !rules.reason_codes.includes(reasonCode)) {
    throw unprocessable("unknown_reason_code", `原因编码 ${reasonCode} 不在规则集 ${rules.version} 中`, {
      field: "reason_code",
      allowed: rules.reason_codes,
    });
  }
  const templates = reasonCode
    ? await db.query("SELECT template_code, version, reason_code, title, body FROM notice_templates WHERE reason_code = $1 ORDER BY template_code, version", [reasonCode])
    : await db.query("SELECT template_code, version, reason_code, title, body FROM notice_templates ORDER BY template_code, version");
  const deadlineRules = await db.query("SELECT reason_code, ack_due_hours FROM deadline_rules ORDER BY reason_code");
  const exemptionReasons = await db.query("SELECT code, description FROM exemption_reason_codes ORDER BY code");
  return {
    rule_version: rules.version,
    theme: rules.theme ?? null,
    reason_codes: rules.reason_codes,
    deadline_rules: deadlineRules.rows,
    exemption_reason_codes: exemptionReasons.rows,
    templates: templates.rows,
  };
}
