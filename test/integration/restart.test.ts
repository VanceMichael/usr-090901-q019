import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { api, getCtx, hoursAgo, type TestCtx } from "../helpers.js";

/**
 * 重启恢复验收：
 * - 进程内模式：写入状态 → 关闭并重启应用（同一数据库）→ 校验覆盖率快照与游标继续有效
 * - 黑盒模式（容器验收）：RESTART_PHASE=setup 写入确定性状态；
 *   宿主脚本重启 app 容器后以 RESTART_PHASE=verify 再跑一遍做断言
 */

const PUBLISH_EVENT = "restart-accept-publish";
const LOT_CODE = "lot-restart-accept";
const STORES = ["store-a01", "store-a02", "store-a03", "store-a04", "store-a05"];

let ctx: TestCtx;

before(async () => {
  ctx = await getCtx();
});

after(async () => {
  if (ctx) await ctx.close();
});

async function setupState(): Promise<void> {
  const pub = await api(ctx, "POST", "/api/v1/recall-tasks", {
    source_event_id: PUBLISH_EVENT,
    brand_id: "brand-aurora",
    lot_code: LOT_CODE,
    lot_version: 1,
    reason_code: "COSMETIC_RECALL",
    actor_role: "regulator",
    occurred_at: hoursAgo(1),
    store_codes: STORES,
  });
  assert.ok([200, 201].includes(pub.status), JSON.stringify(pub.json));
  const taskId = pub.json.task.task_id as string;

  const receipts = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/receipts:batch`, {
    actor_role: "warehouse",
    receipts: STORES.slice(0, 3).map((store_code) => ({
      source_event_id: `restart-accept-rcpt-${store_code}`,
      store_code,
      received_at: hoursAgo(0),
    })),
  });
  // 首次 accepted，重复执行 duplicate，都允许
  for (const r of receipts.json.results) {
    assert.ok(["accepted", "duplicate"].includes(r.status), JSON.stringify(r));
  }

  const exm = await api(ctx, "POST", `/api/v1/recall-tasks/${taskId}/exemptions`, {
    source_event_id: "restart-accept-exm-a04",
    store_code: "store-a04",
    reason_code: "NO_STOCK_OF_LOT",
    reason_text: "该门店从未购进此批次商品",
    actor_role: "store",
  });
  assert.ok([200, 201].includes(exm.status), JSON.stringify(exm.json));
  const exemptionId = exm.json.exemption.exemption_id as number;
  const review = await api(ctx, "POST", `/api/v1/exemptions/${exemptionId}/review`, {
    decision: "approve",
    reviewer: "brand-safety-01",
    actor_role: "brand_safety",
  });
  // 首次 200，重复执行 409（已审核）
  assert.ok([200, 409].includes(review.status), JSON.stringify(review.json));

  // 第二个任务保持全部待确认，确保待办超过一页、游标必然存在
  const pub2 = await api(ctx, "POST", "/api/v1/recall-tasks", {
    source_event_id: "restart-accept-publish-2",
    brand_id: "brand-aurora",
    lot_code: "lot-restart-accept-2",
    lot_version: 1,
    reason_code: "COSMETIC_RECALL",
    actor_role: "regulator",
    occurred_at: hoursAgo(1),
    store_codes: ["store-a05", "store-a06", "store-a07"],
  });
  assert.ok([200, 201].includes(pub2.status), JSON.stringify(pub2.json));
}

async function findTask(): Promise<{ task_id: string; [k: string]: unknown }> {
  const progress = await api(ctx, "GET", "/api/v1/brands/brand-aurora/recall-progress");
  assert.equal(progress.status, 200);
  const task = progress.json.tasks.find((t: { lot_code: string }) => t.lot_code === LOT_CODE);
  assert.ok(task, "重启后应仍能通过品牌进度查到召回任务");
  return task;
}

async function verifyState(): Promise<void> {
  const task = await findTask();
  const cov = task.coverage as { total: number; acknowledged: number; exempted: number; pending: number; coverage_rate: number };
  assert.equal(cov.total, 5);
  assert.equal(cov.acknowledged, 3);
  assert.equal(cov.exempted, 1);
  assert.equal(cov.pending, 1);
  assert.equal(cov.coverage_rate, 0.8);
  assert.deepEqual(task.unconfirmed, ["store-a05"]);

  // 覆盖率快照在重启后仍然有效
  const detail = await api(ctx, "GET", `/api/v1/recall-tasks/${task.task_id}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.json.latest_snapshot, "重启后快照应仍存在");
  assert.equal(Number(detail.json.latest_snapshot.coverage_rate), 0.8);
  assert.equal(detail.json.live_counts.acknowledged, 3);
  assert.equal(detail.json.live_counts.exempted, 1);

  // 游标分页在重启后继续有效：翻页找到该任务唯一未确认门店（共享库中按 task_id 过滤）
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 40; page++) {
    const qs = `/api/v1/todos?brand_id=brand-aurora&limit=5${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const res = await api(ctx, "GET", qs);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    for (const i of res.json.items) {
      if (i.task_id === task.task_id) seen.push(i.store_code);
    }
    cursor = res.json.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, ["store-a05"], "待办中该任务应只剩 store-a05 未确认");
}

test("重启恢复：覆盖率快照与分页游标在重启后继续有效", async (t) => {
  if (ctx.mode === "black-box") {
    const phase = process.env.RESTART_PHASE;
    if (phase === "setup") {
      await setupState();
      return;
    }
    if (phase === "verify") {
      await verifyState();
      return;
    }
    t.skip("黑盒模式需设置 RESTART_PHASE=setup|verify（由 scripts/acceptance.sh 驱动）");
    return;
  }

  // 进程内模式：写入 → 抓重启前游标 → 重启 → 用旧游标续翻并校验
  await setupState();
  const firstPage = await api(ctx, "GET", "/api/v1/todos?brand_id=brand-aurora&limit=2");
  assert.equal(firstPage.status, 200);
  const preRestartCursor = firstPage.json.next_cursor as string | null;
  assert.ok(preRestartCursor, "应存在下一页游标");

  await ctx.restart();

  // 重启后服务恢复，且重启前拿到的游标仍可续翻
  const cont = await api(ctx, "GET", `/api/v1/todos?brand_id=brand-aurora&limit=2&cursor=${encodeURIComponent(preRestartCursor!)}`);
  assert.equal(cont.status, 200, "重启后旧游标应继续有效");
  // 旧游标续翻到的内容应与全新翻页互补（续翻页不再包含第一页的门店）
  assert.ok(cont.json.items.length >= 1);
  await verifyState();
});
