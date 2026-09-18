import type { PoolClient } from "pg";
import type { AppConfig } from "./config.js";
import { computeCoverage } from "./coverage.js";
import type { Database, Queryable } from "./db.js";
import { conflict, notFound, unprocessable, type ApiError } from "./errors.js";
import type { RulesFixture } from "./rules.js";
import { toTaskJson, type TaskJson, type TaskRow } from "./types.js";
import {
  optString,
  optTime,
  reqInt,
  reqObject,
  reqString,
  reqTime,
  requireRole,
} from "./validate.js";

const PUBLISH_ROLES = ["regulator", "brand_safety"] as const;
const RECEIPT_ROLES = ["store", "brand_safety", "warehouse"] as const;
const EXEMPTION_APPLY_ROLES = ["store", "brand_safety"] as const;
const EXEMPTION_REVIEW_ROLES = ["brand_safety", "regulator"] as const;
const CLOSE_ROLES = ["regulator", "brand_safety"] as const;

interface Ctx {
  db: Database;
  rules: RulesFixture;
  cfg: AppConfig;
  now: () => Date;
}

// ---------- 共享查询 ----------

async function findTaskBySourceEvent(db: Queryable, sourceEventId: string): Promise<TaskRow | null> {
  const { rows } = await db.query<TaskRow>(
    "SELECT * FROM recall_tasks WHERE source_event_id = $1",
    [sourceEventId],
  );
  return rows[0] ?? null;
}

async function findTaskByLot(db: Queryable, brandId: string, lotCode: string, lotVersion: number): Promise<TaskRow | null> {
  const { rows } = await db.query<TaskRow>(
    "SELECT * FROM recall_tasks WHERE brand_id = $1 AND lot_code = $2 AND lot_version = $3",
    [brandId, lotCode, lotVersion],
  );
  return rows[0] ?? null;
}

async function liveOverdueCount(db: Queryable, taskId: string, now: Date): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM recall_notices n
     JOIN recall_tasks t ON t.task_id = n.task_id
     WHERE n.task_id = $1 AND n.status = 'pending' AND t.deadline_at < $2`,
    [taskId, now],
  );
  return Number(rows[0]?.n ?? 0);
}

async function unconfirmedStores(db: Queryable, taskId: string): Promise<string[]> {
  const { rows } = await db.query<{ store_code: string }>(
    `SELECT s.store_code FROM recall_notices n
     JOIN stores s ON s.store_id = n.store_id
     WHERE n.task_id = $1 AND n.status = 'pending'
     ORDER BY s.store_code`,
    [taskId],
  );
  return rows.map((r) => r.store_code);
}

/** 在事务内写入覆盖率快照（计数与明细同事务，保证一致） */
async function insertSnapshot(
  client: PoolClient,
  taskId: string,
  trigger: "publish" | "receipt" | "exemption" | "close",
  now: Date,
): Promise<void> {
  const { rows } = await client.query<TaskRow & { overdue: string }>(
    `SELECT t.total_notices, t.acknowledged_count, t.exempted_count,
            (SELECT count(*)::int FROM recall_notices n
              WHERE n.task_id = t.task_id AND n.status = 'pending' AND t.deadline_at < $2) AS overdue
     FROM recall_tasks t WHERE t.task_id = $1`,
    [taskId, now],
  );
  const t = rows[0];
  if (!t) return;
  const cov = computeCoverage({
    total: t.total_notices,
    acknowledged: t.acknowledged_count,
    exempted: t.exempted_count,
    overdue: Number(t.overdue),
  });
  await client.query(
    `INSERT INTO coverage_snapshots (task_id, trigger, computed_at, total, acknowledged, exempted, pending, overdue, coverage_rate)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [taskId, trigger, now, cov.total, cov.acknowledged, cov.exempted, cov.pending, cov.overdue, cov.coverage_rate],
  );
}

async function taskJsonWithLive(db: Queryable, row: TaskRow, now: Date, withUnconfirmed = true): Promise<TaskJson> {
  const overdue = await liveOverdueCount(db, row.task_id, now);
  const unconfirmed = withUnconfirmed ? await unconfirmedStores(db, row.task_id) : undefined;
  return toTaskJson(row, now, unconfirmed === undefined ? { overdue } : { overdue, unconfirmed });
}

// ---------- 发布召回任务 ----------

export interface PublishResult {
  status: number;
  body: { task: TaskJson; deduplicated: boolean };
}

export async function publishTask(ctx: Ctx, rawBody: unknown): Promise<PublishResult> {
  const body = reqObject(rawBody);
  const sourceEventId = reqString(body, "source_event_id", 120);
  const brandId = reqString(body, "brand_id", 120);
  const lotCode = reqString(body, "lot_code", 120);
  const lotVersion = reqInt(body, "lot_version", 1);
  const reasonCode = reqString(body, "reason_code", 120);
  const actorRole = reqString(body, "actor_role", 60);
  const occurredAt = reqTime(body, "occurred_at");
  const deadlineAt = optTime(body, "deadline_at");
  const templateCode = optString(body, "template_code", 120);
  const storeCodesRaw = body["store_codes"];
  if (storeCodesRaw !== undefined && (!Array.isArray(storeCodesRaw) || storeCodesRaw.some((s) => typeof s !== "string"))) {
    throw unprocessable("invalid_field", "字段 store_codes 必须为字符串数组", { field: "store_codes" });
  }
  const storeCodes = (storeCodesRaw as string[] | undefined)?.map((s) => s.trim()).filter((s) => s !== "");
  if (storeCodes !== undefined && storeCodes.length === 0) {
    throw unprocessable("no_target_stores", "store_codes 为空，没有可通知的门店", { field: "store_codes" });
  }

  requireRole(actorRole, PUBLISH_ROLES);
  if (!ctx.rules.reason_codes.includes(reasonCode)) {
    throw unprocessable("unknown_reason_code", `召回原因编码 ${reasonCode} 不在规则集 ${ctx.rules.version} 中`, {
      field: "reason_code",
      allowed: ctx.rules.reason_codes,
    });
  }

  const { db } = ctx;
  const now = ctx.now();

  // 幂等：同一 source_event_id 或同一 (brand, lot, version) 重复发布 => 返回原任务
  const byEvent = await findTaskBySourceEvent(db, sourceEventId);
  if (byEvent) {
    return { status: 200, body: { task: await taskJsonWithLive(db, byEvent, now), deduplicated: true } };
  }
  const byLot = await findTaskByLot(db, brandId, lotCode, lotVersion);
  if (byLot) {
    return { status: 200, body: { task: await taskJsonWithLive(db, byLot, now), deduplicated: true } };
  }

  // 批次版本校验：不允许发布低于现有版本的旧批次
  const { rows: maxRows } = await db.query<{ max_v: number | null }>(
    "SELECT max(lot_version) AS max_v FROM recall_tasks WHERE brand_id = $1 AND lot_code = $2",
    [brandId, lotCode],
  );
  const maxV = maxRows[0]?.max_v ?? null;
  if (maxV !== null && lotVersion < maxV) {
    throw conflict("stale_lot_version", `批次 ${lotCode} 已存在版本 ${maxV} 的召回任务，拒绝发布旧版本 ${lotVersion}`, {
      lot_code: lotCode,
      existing_version: maxV,
    });
  }

  const brand = await db.query("SELECT brand_id FROM brands WHERE brand_id = $1", [brandId]);
  if (brand.rowCount === 0) {
    throw unprocessable("unknown_brand", `品牌 ${brandId} 不存在`, { field: "brand_id" });
  }

  // 模板解析：显式指定或按原因编码取最新版本
  let template: { template_code: string; version: number; reason_code: string } | undefined;
  if (templateCode) {
    const r = await db.query<{ template_code: string; version: number; reason_code: string }>(
      "SELECT template_code, version, reason_code FROM notice_templates WHERE template_code = $1 ORDER BY version DESC LIMIT 1",
      [templateCode],
    );
    template = r.rows[0];
    if (!template) throw unprocessable("unknown_template", `通知模板 ${templateCode} 不存在`, { field: "template_code" });
    if (template.reason_code !== reasonCode) {
      throw unprocessable("template_reason_mismatch", `模板 ${templateCode} 不适用于原因编码 ${reasonCode}`, {
        field: "template_code",
      });
    }
  } else {
    const r = await db.query<{ template_code: string; version: number; reason_code: string }>(
      "SELECT template_code, version, reason_code FROM notice_templates WHERE reason_code = $1 ORDER BY version DESC LIMIT 1",
      [reasonCode],
    );
    template = r.rows[0];
    if (!template) throw unprocessable("no_template", `原因编码 ${reasonCode} 没有可用通知模板`, { field: "reason_code" });
  }

  // 期限：显式指定或按期限规则推导
  let deadline: Date;
  if (deadlineAt) {
    deadline = deadlineAt;
  } else {
    const r = await db.query<{ ack_due_hours: number }>(
      "SELECT ack_due_hours FROM deadline_rules WHERE reason_code = $1",
      [reasonCode],
    );
    const hours = r.rows[0]?.ack_due_hours;
    if (!hours) throw unprocessable("no_deadline_rule", `原因编码 ${reasonCode} 没有期限规则，请显式指定 deadline_at`);
    deadline = new Date(occurredAt.getTime() + hours * 3_600_000);
  }
  if (deadline.getTime() <= occurredAt.getTime()) {
    throw unprocessable("invalid_deadline", "deadline_at 必须晚于 occurred_at", { field: "deadline_at" });
  }

  // 门店归属校验：显式清单逐家校验，缺省取品牌全部门店
  let storeIds: { store_id: string; store_code: string }[];
  if (storeCodes && storeCodes.length > 0) {
    const r = await db.query<{ store_id: string; store_code: string; brand_id: string; active: boolean }>(
      "SELECT store_id, store_code, brand_id, active FROM stores WHERE store_code = ANY($1)",
      [storeCodes],
    );
    const byCode = new Map(r.rows.map((s) => [s.store_code, s]));
    const errors: { store_code: string; code: string; message: string }[] = [];
    const seen = new Set<string>();
    storeIds = [];
    for (const code of storeCodes) {
      if (seen.has(code)) continue;
      seen.add(code);
      const s = byCode.get(code);
      if (!s) {
        errors.push({ store_code: code, code: "unknown_store", message: `门店 ${code} 不存在` });
      } else if (s.brand_id !== brandId) {
        errors.push({ store_code: code, code: "store_brand_mismatch", message: `门店 ${code} 不属于品牌 ${brandId}` });
      } else if (!s.active) {
        errors.push({ store_code: code, code: "store_inactive", message: `门店 ${code} 已停用` });
      } else {
        storeIds.push({ store_id: s.store_id, store_code: s.store_code });
      }
    }
    if (errors.length > 0) {
      throw unprocessable("invalid_store_list", "门店清单校验失败", { errors });
    }
  } else {
    const r = await db.query<{ store_id: string; store_code: string }>(
      "SELECT store_id, store_code FROM stores WHERE brand_id = $1 AND active ORDER BY store_code",
      [brandId],
    );
    storeIds = r.rows;
  }
  if (storeIds.length === 0) {
    throw unprocessable("no_target_stores", `品牌 ${brandId} 没有可通知的门店`, { field: "store_codes" });
  }

  // 事务：任务 + 通知 + 计数 + 快照，一次提交
  try {
    const created = await db.withTx(async (client) => {
      const ins = await client.query<TaskRow>(
        `INSERT INTO recall_tasks
           (source_event_id, brand_id, lot_code, lot_version, reason_code,
            template_code, template_version, actor_role, published_at, deadline_at, total_notices)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING *`,
        [
          sourceEventId, brandId, lotCode, lotVersion, reasonCode,
          template.template_code, template.version, actorRole, occurredAt, deadline, storeIds.length,
        ],
      );
      const task = ins.rows[0]!;
      const values: string[] = [];
      const params: unknown[] = [task.task_id, occurredAt];
      storeIds.forEach((s, i) => {
        values.push(`($1, $${i + 3}, $2)`);
        params.push(s.store_id);
      });
      await client.query(
        `INSERT INTO recall_notices (task_id, store_id, notified_at) VALUES ${values.join(", ")}`,
        params,
      );
      await insertSnapshot(client, task.task_id, "publish", now);
      return task;
    });
    return { status: 201, body: { task: await taskJsonWithLive(db, created, now), deduplicated: false } };
  } catch (err) {
    // 并发重复发布：唯一约束冲突时返回原任务
    if (isUniqueViolation(err)) {
      const dup = (await findTaskBySourceEvent(db, sourceEventId)) ?? (await findTaskByLot(db, brandId, lotCode, lotVersion));
      if (dup) {
        return { status: 200, body: { task: await taskJsonWithLive(db, dup, now), deduplicated: true } };
      }
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

// ---------- 批量门店回执 ----------

export interface ReceiptItemResult {
  index: number;
  status: "accepted" | "duplicate" | "error";
  receipt_id?: number;
  store_code?: string;
  late?: boolean;
  notice_status?: string;
  code?: string;
  message?: string;
}

export async function submitReceiptsBatch(ctx: Ctx, taskId: string, rawBody: unknown): Promise<{ status: number; body: unknown }> {
  const body = reqObject(rawBody);
  const actorRole = reqString(body, "actor_role", 60);
  requireRole(actorRole, RECEIPT_ROLES);
  const items = body["receipts"];
  if (!Array.isArray(items) || items.length < 1 || items.length > ctx.cfg.maxBatchReceipts) {
    throw unprocessable("invalid_field", `字段 receipts 必须为长度 1..${ctx.cfg.maxBatchReceipts} 的数组`, { field: "receipts" });
  }

  const { db } = ctx;
  const { rows: taskRows } = await db.query<TaskRow>("SELECT * FROM recall_tasks WHERE task_id = $1", [taskId]);
  const task = taskRows[0];
  if (!task) throw notFound("task_not_found", `召回任务 ${taskId} 不存在`);

  const results: ReceiptItemResult[] = [];
  let accepted = 0;
  let duplicates = 0;
  let errors = 0;

  for (let i = 0; i < items.length; i++) {
    const res = await processOneReceipt(ctx, task, items[i], i);
    results.push(res);
    if (res.status === "accepted") accepted++;
    else if (res.status === "duplicate") duplicates++;
    else errors++;
  }

  // 本批有实际变更时，落一条覆盖率快照（独立事务，与最终计数一致）
  if (accepted > 0) {
    await db.withTx(async (client) => {
      await insertSnapshot(client, task.task_id, "receipt", ctx.now());
    });
  }

  return {
    status: 200,
    body: {
      task_id: task.task_id,
      summary: { total: items.length, accepted, duplicates, errors },
      results,
    },
  };
}

async function processOneReceipt(ctx: Ctx, task: TaskRow, raw: unknown, index: number): Promise<ReceiptItemResult> {
  const fail = (code: string, message: string): ReceiptItemResult => ({ index, status: "error", code, message });
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return fail("invalid_item", "回执条目必须为 JSON 对象");
    }
    const item = raw as Record<string, unknown>;
    const sourceEventId = reqString(item, "source_event_id", 120);
    const storeCode = reqString(item, "store_code", 120);
    const receivedAt = reqTime(item, "received_at");
    const channel = optString(item, "channel", 60) ?? "unspecified";
    const note = optString(item, "note", 2000);
    const now = ctx.now();

    if (task.status === "closed") return fail("task_closed", `召回任务 ${task.task_id} 已关闭，拒绝回执`);
    if (receivedAt.getTime() < task.published_at.getTime()) {
      return fail("receipt_before_publish", "回执时间早于任务发布时间");
    }
    if (receivedAt.getTime() > now.getTime() + ctx.cfg.futureSkewMs) {
      return fail("receipt_in_future", "回执时间超过当前时间（允许 5 分钟时钟偏移）");
    }

    // 幂等：同一回执事件重复提交 => 返回原回执
    const dup = await ctx.db.query<{ receipt_id: string; task_id: string; store_id: string; result: string }>(
      "SELECT receipt_id, task_id, store_id, result FROM receipts WHERE source_event_id = $1",
      [sourceEventId],
    );
    if (dup.rows[0]) {
      const d = dup.rows[0];
      const store = await ctx.db.query<{ store_code: string }>("SELECT store_code FROM stores WHERE store_id = $1", [d.store_id]);
      if (d.task_id === task.task_id && store.rows[0]?.store_code === storeCode) {
        return {
          index,
          status: "duplicate",
          receipt_id: Number(d.receipt_id),
          store_code: storeCode,
          late: d.result === "late",
          notice_status: "acknowledged",
        };
      }
      return fail("source_event_conflict", `回执事件 ${sourceEventId} 已用于其他门店或任务`);
    }

    const storeRes = await ctx.db.query<{ store_id: string; brand_id: string }>(
      "SELECT store_id, brand_id FROM stores WHERE store_code = $1",
      [storeCode],
    );
    const store = storeRes.rows[0];
    if (!store) return fail("unknown_store", `门店 ${storeCode} 不存在`);
    if (store.brand_id !== task.brand_id) {
      return fail("store_brand_mismatch", `门店 ${storeCode} 不属于品牌 ${task.brand_id}`);
    }

    const noticeRes = await ctx.db.query<{ notice_id: string; status: string }>(
      "SELECT notice_id, status FROM recall_notices WHERE task_id = $1 AND store_id = $2",
      [task.task_id, store.store_id],
    );
    const notice = noticeRes.rows[0];
    if (!notice) return fail("store_not_in_task", `门店 ${storeCode} 不在该召回任务的通知范围内`);
    if (notice.status === "acknowledged") return fail("already_acknowledged", `门店 ${storeCode} 已确认，拒绝重复回执`);
    if (notice.status === "exempted") return fail("already_exempted", `门店 ${storeCode} 已豁免，无需回执`);

    const late = receivedAt.getTime() > task.deadline_at.getTime();

    // 单条回执一个事务：回执 + 通知状态 + 任务计数同时提交
    const receiptId = await ctx.db.withTx(async (client) => {
      const ins = await client.query<{ receipt_id: string }>(
        `INSERT INTO receipts (source_event_id, notice_id, task_id, store_id, received_at, channel, note, result)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING receipt_id`,
        [sourceEventId, notice.notice_id, task.task_id, store.store_id, receivedAt, channel, note ?? null, late ? "late" : "accepted"],
      );
      const upd = await client.query(
        `UPDATE recall_notices SET status = 'acknowledged', acknowledged_at = $1, late = $2
         WHERE notice_id = $3 AND status = 'pending'`,
        [receivedAt, late, notice.notice_id],
      );
      if (upd.rowCount !== 1) {
        throw conflict("notice_state_changed", `门店 ${storeCode} 的通知状态已变化，请重试`);
      }
      await client.query(
        "UPDATE recall_tasks SET acknowledged_count = acknowledged_count + 1 WHERE task_id = $1",
        [task.task_id],
      );
      return Number(ins.rows[0]!.receipt_id);
    });

    return {
      index,
      status: "accepted",
      receipt_id: receiptId,
      store_code: storeCode,
      late,
      notice_status: "acknowledged",
    };
  } catch (err) {
    const apiErr = err as ApiError;
    if (apiErr && typeof apiErr.code === "string" && typeof apiErr.status === "number") {
      return { index, status: "error", code: apiErr.code, message: apiErr.message };
    }
    throw err;
  }
}

// ---------- 豁免申请与审核 ----------

export async function applyExemption(ctx: Ctx, taskId: string, rawBody: unknown): Promise<{ status: number; body: unknown }> {
  const body = reqObject(rawBody);
  const sourceEventId = reqString(body, "source_event_id", 120);
  const storeCode = reqString(body, "store_code", 120);
  const reasonCode = reqString(body, "reason_code", 120);
  const reasonText = reqString(body, "reason_text", 2000);
  const actorRole = reqString(body, "actor_role", 60);
  requireRole(actorRole, EXEMPTION_APPLY_ROLES);
  if (reasonText.length < 10) {
    throw unprocessable("invalid_reason_text", "豁免理由说明至少需要 10 个字符", { field: "reason_text" });
  }

  const { db } = ctx;
  const { rows: taskRows } = await db.query<TaskRow>("SELECT * FROM recall_tasks WHERE task_id = $1", [taskId]);
  const task = taskRows[0];
  if (!task) throw notFound("task_not_found", `召回任务 ${taskId} 不存在`);

  // 幂等：同一申请事件重复提交 => 返回原申请
  const dup = await db.query("SELECT * FROM exemptions WHERE source_event_id = $1", [sourceEventId]);
  if (dup.rows[0]) return { status: 200, body: { exemption: dup.rows[0], deduplicated: true } };

  if (task.status === "closed") throw conflict("task_closed", `召回任务 ${taskId} 已关闭，拒绝豁免申请`);

  const rc = await db.query("SELECT code FROM exemption_reason_codes WHERE code = $1", [reasonCode]);
  if (rc.rowCount === 0) {
    throw unprocessable("unknown_exemption_reason", `豁免理由编码 ${reasonCode} 不在规则中`, { field: "reason_code" });
  }

  const storeRes = await db.query<{ store_id: string; brand_id: string }>(
    "SELECT store_id, brand_id FROM stores WHERE store_code = $1",
    [storeCode],
  );
  const store = storeRes.rows[0];
  if (!store) throw unprocessable("unknown_store", `门店 ${storeCode} 不存在`, { field: "store_code" });
  if (store.brand_id !== task.brand_id) {
    throw unprocessable("store_brand_mismatch", `门店 ${storeCode} 不属于品牌 ${task.brand_id}`, { field: "store_code" });
  }

  const noticeRes = await db.query<{ notice_id: string; status: string }>(
    "SELECT notice_id, status FROM recall_notices WHERE task_id = $1 AND store_id = $2",
    [task.task_id, store.store_id],
  );
  const notice = noticeRes.rows[0];
  if (!notice) throw unprocessable("store_not_in_task", `门店 ${storeCode} 不在该召回任务的通知范围内`);
  if (notice.status === "acknowledged") throw conflict("already_acknowledged", `门店 ${storeCode} 已确认，不能申请豁免`);
  if (notice.status === "exempted") throw conflict("already_exempted", `门店 ${storeCode} 已豁免`);

  try {
    const created = await db.withTx(async (client) => {
      const ins = await client.query(
        `INSERT INTO exemptions (source_event_id, task_id, store_id, reason_code, reason_text)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [sourceEventId, task.task_id, store.store_id, reasonCode, reasonText],
      );
      return ins.rows[0];
    });
    return { status: 201, body: { exemption: created, deduplicated: false } };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await db.query(
        `SELECT e.* FROM exemptions e WHERE e.task_id = $1 AND e.store_id = $2`,
        [task.task_id, store.store_id],
      );
      if (existing.rows[0]) {
        throw conflict("exemption_exists", `门店 ${storeCode} 在该任务下已存在豁免申请`, {
          exemption_id: existing.rows[0].exemption_id,
        });
      }
    }
    throw err;
  }
}

export async function reviewExemption(ctx: Ctx, exemptionId: string, rawBody: unknown): Promise<{ status: number; body: unknown }> {
  const body = reqObject(rawBody);
  const decision = reqString(body, "decision", 20);
  const reviewer = reqString(body, "reviewer", 120);
  const reviewNote = optString(body, "review_note", 2000);
  const actorRole = reqString(body, "actor_role", 60);
  requireRole(actorRole, EXEMPTION_REVIEW_ROLES);
  if (decision !== "approve" && decision !== "reject") {
    throw unprocessable("invalid_decision", "decision 必须为 approve 或 reject", { field: "decision" });
  }
  const id = Number.parseInt(exemptionId, 10);
  if (!Number.isInteger(id)) throw unprocessable("invalid_field", "豁免申请 id 非法", { field: "exemption_id" });

  const { db } = ctx;
  const now = ctx.now();
  const updated = await db.withTx(async (client) => {
    const { rows } = await client.query("SELECT * FROM exemptions WHERE exemption_id = $1 FOR UPDATE", [id]);
    const ex = rows[0];
    if (!ex) throw notFound("exemption_not_found", `豁免申请 ${exemptionId} 不存在`);
    if (ex.status !== "submitted") {
      throw conflict("exemption_already_reviewed", `豁免申请 ${exemptionId} 已审核（${ex.status}）`);
    }
    const newStatus = decision === "approve" ? "approved" : "rejected";
    const upd = await client.query(
      `UPDATE exemptions SET status = $1, reviewed_by = $2, reviewed_at = $3, review_note = $4
       WHERE exemption_id = $5 RETURNING *`,
      [newStatus, reviewer, now, reviewNote ?? null, id],
    );
    if (decision === "approve") {
      const noticeUpd = await client.query(
        `UPDATE recall_notices SET status = 'exempted'
         WHERE task_id = $1 AND store_id = $2 AND status = 'pending'`,
        [ex.task_id, ex.store_id],
      );
      if (noticeUpd.rowCount === 1) {
        await client.query(
          "UPDATE recall_tasks SET exempted_count = exempted_count + 1 WHERE task_id = $1",
          [ex.task_id],
        );
      }
      await insertSnapshot(client, ex.task_id, "exemption", now);
    }
    return upd.rows[0];
  });
  return { status: 200, body: { exemption: updated } };
}

// ---------- 任务关闭 ----------

export async function closeTask(ctx: Ctx, taskId: string, rawBody: unknown): Promise<{ status: number; body: unknown }> {
  const body = reqObject(rawBody);
  const actorRole = reqString(body, "actor_role", 60);
  const note = optString(body, "note", 2000);
  requireRole(actorRole, CLOSE_ROLES);

  const { db } = ctx;
  const now = ctx.now();
  const { rows } = await db.query<TaskRow>("SELECT * FROM recall_tasks WHERE task_id = $1", [taskId]);
  const task = rows[0];
  if (!task) throw notFound("task_not_found", `召回任务 ${taskId} 不存在`);
  if (task.status === "closed") {
    return { status: 200, body: { task: await taskJsonWithLive(db, task, now), deduplicated: true } };
  }
  const closed = await db.withTx(async (client) => {
    const upd = await client.query<TaskRow>(
      `UPDATE recall_tasks SET status = 'closed', closed_at = $1, close_note = $2
       WHERE task_id = $3 AND status = 'open' RETURNING *`,
      [now, note ?? null, taskId],
    );
    if (upd.rowCount !== 1) throw conflict("task_state_changed", "任务状态已变化，请重试");
    await insertSnapshot(client, taskId, "close", now);
    return upd.rows[0]!;
  });
  return { status: 200, body: { task: await taskJsonWithLive(db, closed, now), deduplicated: false } };
}
