import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { api, getCtx, hoursAgo, hoursFromNow, uid, type TestCtx } from "../helpers.js";

let ctx: TestCtx;

before(async () => {
  ctx = await getCtx();
});

after(async () => {
  if (ctx) await ctx.close();
});

const AURORA_ACTIVE_STORES = [
  "store-a01", "store-a02", "store-a03", "store-a04",
  "store-a05", "store-a06", "store-a07",
]; // store-a08 为停用门店，不应收到通知

function publishBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const lot = uid("lot");
  return {
    source_event_id: `evt-${lot}`,
    brand_id: "brand-aurora",
    lot_code: lot,
    lot_version: 1,
    reason_code: "COSMETIC_RECALL",
    actor_role: "regulator",
    occurred_at: hoursAgo(1),
    ...overrides,
  };
}

test("发布召回任务：为品牌全部在营门店生成通知，初始覆盖率为 0", async () => {
  const res = await api(ctx, "POST", "/api/v1/recall-tasks", publishBody());
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const { task, deduplicated } = res.json;
  assert.equal(deduplicated, false);
  assert.equal(task.status, "open");
  assert.equal(task.template_code, "tmpl-cosmetic-recall");
  assert.equal(task.coverage.total, 7);
  assert.equal(task.coverage.acknowledged, 0);
  assert.equal(task.coverage.coverage_rate, 0);
  assert.deepEqual(task.unconfirmed, AURORA_ACTIVE_STORES);
  // 期限规则：COSMETIC_RECALL 默认 72 小时
  const deadline = Date.parse(task.deadline_at);
  const published = Date.parse(task.published_at);
  assert.equal(deadline - published, 72 * 3_600_000);
});

test("重复发布（同 source_event_id / 同批次版本）返回原任务", async () => {
  const body = publishBody();
  const first = await api(ctx, "POST", "/api/v1/recall-tasks", body);
  assert.equal(first.status, 201);

  // 同一事件重复发布
  const dup1 = await api(ctx, "POST", "/api/v1/recall-tasks", body);
  assert.equal(dup1.status, 200);
  assert.equal(dup1.json.deduplicated, true);
  assert.equal(dup1.json.task.task_id, first.json.task.task_id);
  assert.equal(dup1.json.task.coverage.total, 7);

  // 同一批次版本、不同事件 id
  const dup2 = await api(ctx, "POST", "/api/v1/recall-tasks", {
    ...body,
    source_event_id: uid("evt-other"),
  });
  assert.equal(dup2.status, 200);
  assert.equal(dup2.json.deduplicated, true);
  assert.equal(dup2.json.task.task_id, first.json.task.task_id);

  // 进度里该批次仍只有一个任务
  const progress = await api(ctx, "GET", "/api/v1/brands/brand-aurora/recall-progress");
  const matches = progress.json.tasks.filter((t: { lot_code: string }) => t.lot_code === body["lot_code"]);
  assert.equal(matches.length, 1);
});

test("批次版本校验：旧版本拒绝，新版本放行", async () => {
  const lot = uid("lot-ver");
  const v2 = await api(ctx, "POST", "/api/v1/recall-tasks", publishBody({ lot_code: lot, lot_version: 2 }));
  assert.equal(v2.status, 201);

  const stale = await api(ctx, "POST", "/api/v1/recall-tasks", publishBody({ lot_code: lot, lot_version: 1 }));
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "stale_lot_version");

  const v3 = await api(ctx, "POST", "/api/v1/recall-tasks", publishBody({ lot_code: lot, lot_version: 3 }));
  assert.equal(v3.status, 201);
  assert.notEqual(v3.json.task.task_id, v2.json.task.task_id);
});

test("发布校验：未知原因编码 / 非法角色 / 跨品牌门店清单", async () => {
  const badReason = await api(ctx, "POST", "/api/v1/recall-tasks", publishBody({ reason_code: "NOPE" }));
  assert.equal(badReason.status, 422);
  assert.equal(badReason.json.error.code, "unknown_reason_code");

  const badRole = await api(ctx, "POST", "/api/v1/recall-tasks", publishBody({ actor_role: "store" }));
  assert.equal(badRole.status, 422);
  assert.equal(badRole.json.error.code, "forbidden_role");

  const crossBrand = await api(ctx, "POST", "/api/v1/recall-tasks", publishBody({
    store_codes: ["store-a01", "store-v01", "store-ghost"],
  }));
  assert.equal(crossBrand.status, 422);
  assert.equal(crossBrand.json.error.code, "invalid_store_list");
  const codes = crossBrand.json.error.details.errors.map((e: { code: string }) => e.code).sort();
  assert.deepEqual(codes, ["store_brand_mismatch", "unknown_store"]);
});

test("批量回执：混合错误按输入索引隔离，合法项照常落库", async () => {
  const pub = await api(ctx, "POST", "/api/v1/recall-tasks", publishBody());
  const taskId = pub.json.task.task_id as string;

  const res = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/receipts:batch`, {
    actor_role: "warehouse",
    receipts: [
      { source_event_id: uid("rcpt"), store_code: "store-a01", received_at: hoursAgo(0) },
      { source_event_id: uid("rcpt"), store_code: "store-ghost", received_at: hoursAgo(0) },
      { source_event_id: uid("rcpt"), store_code: "store-v01", received_at: hoursAgo(0) },
      { source_event_id: uid("rcpt"), store_code: "store-a02", received_at: hoursAgo(5) },
      { source_event_id: uid("rcpt"), store_code: "store-a03", received_at: hoursFromNow(1) },
      { store_code: "store-a04" },
    ],
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(res.json.summary, { total: 6, accepted: 1, duplicates: 0, errors: 5 });

  const r = res.json.results;
  assert.equal(r[0].status, "accepted");
  assert.equal(r[0].index, 0);
  assert.equal(r[0].late, false);
  assert.equal(r[1].status, "error"); assert.equal(r[1].code, "unknown_store"); assert.equal(r[1].index, 1);
  assert.equal(r[2].status, "error"); assert.equal(r[2].code, "store_brand_mismatch");
  assert.equal(r[3].status, "error"); assert.equal(r[3].code, "receipt_before_publish");
  assert.equal(r[4].status, "error"); assert.equal(r[4].code, "receipt_in_future");
  assert.equal(r[5].status, "error"); assert.equal(r[5].code, "invalid_field");

  // 只有合法项计入覆盖率
  const detail = await api(ctx, "GET", `/api/v1/recall-tasks/${taskId}`);
  assert.equal(detail.json.coverage.acknowledged, 1);
  assert.equal(detail.json.coverage.total, 7);
  assert.equal(detail.json.live_counts.acknowledged, 1);
  assert.equal(detail.json.unconfirmed.length, 6);
});

test("迟到回执：超过期限仍接收但标记 late，逾期门店状态为 overdue", async () => {
  const pub = await api(ctx, "POST", "/api/v1/recall-tasks", publishBody({
    occurred_at: hoursAgo(72),
    deadline_at: hoursAgo(24),
    store_codes: ["store-a01", "store-a02"],
  }));
  assert.equal(pub.status, 201, JSON.stringify(pub.json));
  const taskId = pub.json.task.task_id as string;

  const res = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/receipts:batch`, {
    actor_role: "store",
    receipts: [{ source_event_id: uid("rcpt-late"), store_code: "store-a01", received_at: hoursAgo(0) }],
  });
  assert.equal(res.json.summary.accepted, 1);
  assert.equal(res.json.results[0].late, true);

  const detail = await api(ctx, "GET", `/api/v1/recall-tasks/${taskId}`);
  const a01 = detail.json.stores.find((s: { store_code: string }) => s.store_code === "store-a01");
  const a02 = detail.json.stores.find((s: { store_code: string }) => s.store_code === "store-a02");
  assert.equal(a01.status, "acknowledged");
  assert.equal(a01.late, true);
  assert.equal(a02.status, "overdue");
  assert.ok(a02.overdue_days >= 1);
  assert.equal(detail.json.coverage.overdue, 1);
  assert.ok(detail.json.overdue_days >= 1);
});

test("回执幂等：同事件重复提交返回 duplicate，同门店换事件报错", async () => {
  const pub = await api(ctx, "POST", "/api/v1/recall-tasks", publishBody());
  const taskId = pub.json.task.task_id as string;
  const eventId = uid("rcpt-dup");

  const first = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/receipts:batch`, {
    actor_role: "store",
    receipts: [{ source_event_id: eventId, store_code: "store-a01", received_at: hoursAgo(0) }],
  });
  assert.equal(first.json.results[0].status, "accepted");

  const again = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/receipts:batch`, {
    actor_role: "store",
    receipts: [
      { source_event_id: eventId, store_code: "store-a01", received_at: hoursAgo(0) },
      { source_event_id: uid("rcpt-new"), store_code: "store-a01", received_at: hoursAgo(0) },
    ],
  });
  assert.equal(again.json.results[0].status, "duplicate");
  assert.equal(again.json.results[0].receipt_id, first.json.results[0].receipt_id);
  assert.equal(again.json.results[1].status, "error");
  assert.equal(again.json.results[1].code, "already_acknowledged");

  // 计数没有被重复累加
  const detail = await api(ctx, "GET", `/api/v1/recall-tasks/${taskId}`);
  assert.equal(detail.json.coverage.acknowledged, 1);
});

test("覆盖率计算与计数一致性：计数器与明细实算一致", async () => {
  const pub = await api(ctx, "POST", "/api/v1/recall-tasks", publishBody({
    store_codes: ["store-a01", "store-a02", "store-a03", "store-a04"],
  }));
  const taskId = pub.json.task.task_id as string;

  await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/receipts:batch`, {
    actor_role: "warehouse",
    receipts: [
      { source_event_id: uid("rcpt"), store_code: "store-a01", received_at: hoursAgo(0) },
      { source_event_id: uid("rcpt"), store_code: "store-a02", received_at: hoursAgo(0) },
    ],
  });
  const ex = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/exemptions`, {
    source_event_id: uid("exm"),
    store_code: "store-a03",
    reason_code: "NO_STOCK_OF_LOT",
    reason_text: "该门店从未购进此批次商品",
    actor_role: "store",
  });
  assert.equal(ex.status, 201, JSON.stringify(ex.json));
  const exemptionId = ex.json.exemption.exemption_id;
  const review = await api(ctx, "POST", `/api/v1/exemptions/${exemptionId}/review`, {
    decision: "approve",
    reviewer: "brand-safety-01",
    actor_role: "brand_safety",
  });
  assert.equal(review.status, 200);

  const detail = await api(ctx, "GET", `/api/v1/recall-tasks/${taskId}`);
  assert.equal(detail.json.coverage.total, 4);
  assert.equal(detail.json.coverage.acknowledged, 2);
  assert.equal(detail.json.coverage.exempted, 1);
  assert.equal(detail.json.coverage.pending, 1);
  assert.equal(detail.json.coverage.coverage_rate, 0.75);
  assert.deepEqual(detail.json.unconfirmed, ["store-a04"]);
  // 计数器（coverage）与明细实算（live_counts）一致 => 事务内计数正确
  assert.equal(detail.json.live_counts.acknowledged, detail.json.coverage.acknowledged);
  assert.equal(detail.json.live_counts.exempted, detail.json.coverage.exempted);
  assert.equal(detail.json.live_counts.total, detail.json.coverage.total);
  // 快照随写入生成
  assert.ok(detail.json.latest_snapshot);
  assert.equal(Number(detail.json.latest_snapshot.coverage_rate), 0.75);

  // 品牌进度视图同样一致
  const progress = await api(ctx, "GET", "/api/v1/brands/brand-aurora/recall-progress");
  const t = progress.json.tasks.find((x: { task_id: string }) => x.task_id === taskId);
  assert.equal(t.coverage.coverage_rate, 0.75);
  assert.deepEqual(t.unconfirmed, ["store-a04"]);
});

test("任务关闭：关闭后拒绝回执，重复关闭幂等", async () => {
  const pub = await api(ctx, "POST", "/api/v1/recall-tasks", publishBody());
  const taskId = pub.json.task.task_id as string;

  const closed = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/close`, {
    actor_role: "regulator",
    note: "监管确认处置完成",
  });
  assert.equal(closed.status, 200);
  assert.equal(closed.json.task.status, "closed");
  assert.ok(closed.json.task.closed_at);

  const again = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/close`, { actor_role: "regulator" });
  assert.equal(again.status, 200);
  assert.equal(again.json.deduplicated, true);

  const late = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/receipts:batch`, {
    actor_role: "store",
    receipts: [{ source_event_id: uid("rcpt-closed"), store_code: "store-a01", received_at: hoursAgo(0) }],
  });
  assert.equal(late.json.results[0].status, "error");
  assert.equal(late.json.results[0].code, "task_closed");
});
