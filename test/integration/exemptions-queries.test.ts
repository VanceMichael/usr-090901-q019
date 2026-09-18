import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { api, getCtx, hoursAgo, uid, type TestCtx } from "../helpers.js";

let ctx: TestCtx;

before(async () => {
  ctx = await getCtx();
});

after(async () => {
  if (ctx) await ctx.close();
});

async function publishAurora(overrides: Record<string, unknown> = {}): Promise<string> {
  const lot = uid("lot");
  const res = await api(ctx, "POST", "/api/v1/recall-tasks", {
    source_event_id: `evt-${lot}`,
    brand_id: "brand-aurora",
    lot_code: lot,
    lot_version: 1,
    reason_code: "COSMETIC_RECALL",
    actor_role: "regulator",
    occurred_at: hoursAgo(1),
    ...overrides,
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json.task.task_id as string;
}

test("模板与规则查询：规则版本、原因编码、期限规则、模板过滤", async () => {
  const res = await api(ctx, "GET", "/api/v1/notice-templates");
  assert.equal(res.status, 200);
  assert.equal(res.json.rule_version, "2026-09-08");
  assert.deepEqual(res.json.reason_codes, ["COSMETIC_RECALL", "DISTRIBUTION_GRAPH", "REVISIONED_REPORT"]);
  assert.equal(res.json.templates.length, 3);
  assert.equal(res.json.deadline_rules.length, 3);
  assert.ok(res.json.exemption_reason_codes.length >= 4);

  const filtered = await api(ctx, "GET", "/api/v1/notice-templates?reason_code=COSMETIC_RECALL");
  assert.equal(filtered.json.templates.length, 1);
  assert.equal(filtered.json.templates[0].template_code, "tmpl-cosmetic-recall");

  const bad = await api(ctx, "GET", "/api/v1/notice-templates?reason_code=NOPE");
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, "unknown_reason_code");
});

test("豁免审核：申请 → 批准 → 门店状态 exempted，重复审核拒绝", async () => {
  const taskId = await publishAurora();

  // 非法理由编码
  const badReason = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/exemptions`, {
    source_event_id: uid("exm"),
    store_code: "store-a01",
    reason_code: "WHATEVER",
    reason_text: "这个理由编码不存在于规则中",
    actor_role: "store",
  });
  assert.equal(badReason.status, 422);
  assert.equal(badReason.json.error.code, "unknown_exemption_reason");

  // 理由说明太短
  const shortText = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/exemptions`, {
    source_event_id: uid("exm"),
    store_code: "store-a01",
    reason_code: "NO_STOCK_OF_LOT",
    reason_text: "太短",
    actor_role: "store",
  });
  assert.equal(shortText.status, 422);
  assert.equal(shortText.json.error.code, "invalid_reason_text");

  // 正常申请
  const eventId = uid("exm");
  const applied = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/exemptions`, {
    source_event_id: eventId,
    store_code: "store-a01",
    reason_code: "NO_STOCK_OF_LOT",
    reason_text: "该门店从未购进此批次商品",
    actor_role: "store",
  });
  assert.equal(applied.status, 201, JSON.stringify(applied.json));
  const exemptionId = applied.json.exemption.exemption_id as number;

  // 同事件重复申请 => 幂等返回原申请
  const dup = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/exemptions`, {
    source_event_id: eventId,
    store_code: "store-a01",
    reason_code: "NO_STOCK_OF_LOT",
    reason_text: "该门店从未购进此批次商品",
    actor_role: "store",
  });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.deduplicated, true);
  assert.equal(dup.json.exemption.exemption_id, exemptionId);

  // 审核批准
  const reviewed = await api(ctx, "POST", `/api/v1/exemptions/${exemptionId}/review`, {
    decision: "approve",
    reviewer: "brand-safety-01",
    actor_role: "brand_safety",
  });
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.json.exemption.status, "approved");

  // 重复审核 => 409
  const again = await api(ctx, "POST", `/api/v1/exemptions/${exemptionId}/review`, {
    decision: "reject",
    reviewer: "brand-safety-02",
    actor_role: "brand_safety",
  });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "exemption_already_reviewed");

  const detail = await api(ctx, "GET", `/api/v1/recall-tasks/${taskId}`);
  const a01 = detail.json.stores.find((s: { store_code: string }) => s.store_code === "store-a01");
  assert.equal(a01.status, "exempted");
  assert.equal(detail.json.coverage.exempted, 1);
  assert.equal(detail.json.coverage.coverage_rate, Math.round((1 / 7) * 10000) / 10000);
});

test("豁免驳回后门店保持 pending，已确认门店不能申请豁免", async () => {
  const taskId = await publishAurora();

  // store-a01 先确认
  await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/receipts:batch`, {
    actor_role: "store",
    receipts: [{ source_event_id: uid("rcpt"), store_code: "store-a01", received_at: hoursAgo(0) }],
  });
  const conflictRes = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/exemptions`, {
    source_event_id: uid("exm"),
    store_code: "store-a01",
    reason_code: "NO_STOCK_OF_LOT",
    reason_text: "已确认门店不应再申请豁免",
    actor_role: "store",
  });
  assert.equal(conflictRes.status, 409);
  assert.equal(conflictRes.json.error.code, "already_acknowledged");

  // store-a02 申请后被驳回
  const applied = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/exemptions`, {
    source_event_id: uid("exm"),
    store_code: "store-a02",
    reason_code: "IN_TRANSIT_ONLY",
    reason_text: "商品仅在途未入库，由仓库直接处置",
    actor_role: "brand_safety",
  });
  const exemptionId = applied.json.exemption.exemption_id as number;
  const rejected = await api(ctx, "POST", `/api/v1/exemptions/${exemptionId}/review`, {
    decision: "reject",
    reviewer: "regulator-01",
    actor_role: "regulator",
    review_note: "在途商品仍需门店签收后确认",
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.json.exemption.status, "rejected");

  const detail = await api(ctx, "GET", `/api/v1/recall-tasks/${taskId}`);
  const a02 = detail.json.stores.find((s: { store_code: string }) => s.store_code === "store-a02");
  assert.equal(a02.status, "pending");
  assert.equal(detail.json.coverage.exempted, 0);
});

test("待办分页：按期限键集翻页，游标可持续翻完全部", async () => {
  // 使用 brand-vela 避免与共享库中其他用例的待办互相干扰
  const publishVela = async (deadlineHours: number, stores: string[]): Promise<string> => {
    const lot = uid("lot");
    const res = await api(ctx, "POST", "/api/v1/recall-tasks", {
      source_event_id: `evt-${lot}`,
      brand_id: "brand-vela",
      lot_code: lot,
      lot_version: 1,
      reason_code: "COSMETIC_RECALL",
      actor_role: "regulator",
      occurred_at: hoursAgo(1),
      deadline_at: new Date(Date.now() + deadlineHours * 3_600_000).toISOString(),
      store_codes: stores,
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return res.json.task.task_id as string;
  };
  // 两个任务：一个 48h 期限（较早），一个 72h（较晚），各 2 家门店
  const early = await publishVela(48, ["store-v01", "store-v02"]);
  const late = await publishVela(72, ["store-v03", "store-v04"]);

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const qs = `?brand_id=brand-vela&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await api(ctx, "GET", `/api/v1/todos${qs}`);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    for (const item of res.json.items) {
      seen.push(`${item.task_id}:${item.store_code}`);
    }
    cursor = res.json.next_cursor;
    if (!cursor) break;
  }
  // 两个任务的 4 条待办都在结果中，且较早期限的排在前面
  const earlyIdx = seen.findIndex((s) => s.startsWith(early));
  const lateIdx = seen.findIndex((s) => s.startsWith(late));
  assert.ok(earlyIdx >= 0 && lateIdx >= 0, `待办中应包含两个任务: ${JSON.stringify(seen)}`);
  assert.ok(earlyIdx < lateIdx, "待办应按期限升序");
  assert.equal(seen.filter((s) => s.startsWith(early)).length, 2);
  assert.equal(seen.filter((s) => s.startsWith(late)).length, 2);

  // due_before 过滤：返回项期限均不晚于阈值，本任务的早期项在内、晚期项被排除
  const dueBefore = new Date(Date.now() + 60 * 3_600_000).toISOString();
  const due = await api(ctx, "GET", `/api/v1/todos?brand_id=brand-vela&due_before=${encodeURIComponent(dueBefore)}&limit=200`);
  assert.equal(due.status, 200, JSON.stringify(due.json));
  assert.ok(due.json.items.every((i: { deadline_at: string }) => Date.parse(i.deadline_at) <= Date.parse(dueBefore)));
  assert.equal(due.json.items.filter((i: { task_id: string }) => i.task_id === early).length, 2);
  assert.ok(due.json.items.every((i: { task_id: string }) => i.task_id !== late));

  // 非法游标
  const badCursor = await api(ctx, "GET", "/api/v1/todos?cursor=%%%bad%%%");
  assert.equal(badCursor.status, 400);
  assert.equal(badCursor.json.error.code, "invalid_cursor");
});

test("单门店回执历史：回执与豁免合并，支持游标分页", async () => {
  const taskId = await publishAurora({ store_codes: ["store-a05"] });
  await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/receipts:batch`, {
    actor_role: "store",
    receipts: [{ source_event_id: uid("rcpt"), store_code: "store-a05", received_at: hoursAgo(0), channel: "pos", note: "已下架封存" }],
  });
  const taskId2 = await publishAurora({ store_codes: ["store-a05"] });
  await api(ctx, "POST", `/api/v1/recall-tasks/${taskId2}/exemptions`, {
    source_event_id: uid("exm"),
    store_code: "store-a05",
    reason_code: "ALREADY_RETURNED",
    reason_text: "该批次商品已在发布前退回仓库",
    actor_role: "store",
  });

  // 共享库中历史会跨用例累积，按本用例的任务 id 定位记录
  const res = await api(ctx, "GET", "/api/v1/stores/store-a05/receipts?limit=200");
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.store.store_code, "store-a05");
  const receipt = res.json.items.find((i: { task_id: string; kind: string }) => i.task_id === taskId && i.kind === "receipt");
  assert.ok(receipt, "历史中应包含本用例的回执");
  assert.equal(receipt.channel, "pos");
  assert.equal(receipt.result, "accepted");
  assert.equal(receipt.note, "已下架封存");
  const exemption = res.json.items.find((i: { task_id: string; kind: string }) => i.task_id === taskId2 && i.kind === "exemption");
  assert.ok(exemption, "历史中应包含本用例的豁免申请");
  assert.equal(exemption.status, "submitted");
  assert.equal(exemption.reason_code, "ALREADY_RETURNED");

  // 分页：limit=1 翻页，两页记录不重复
  const page1 = await api(ctx, "GET", "/api/v1/stores/store-a05/receipts?limit=1");
  assert.equal(page1.json.items.length, 1);
  assert.ok(page1.json.next_cursor);
  const page2 = await api(ctx, "GET", `/api/v1/stores/store-a05/receipts?limit=1&cursor=${encodeURIComponent(page1.json.next_cursor)}`);
  assert.equal(page2.json.items.length, 1);
  assert.notEqual(page1.json.items[0].id, page2.json.items[0].id);

  const missing = await api(ctx, "GET", "/api/v1/stores/store-ghost/receipts");
  assert.equal(missing.status, 404);
});
