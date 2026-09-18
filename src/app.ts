import type { AppConfig } from "./config.js";
import type { Database } from "./db.js";
import { Router } from "./http.js";
import {
  getBrandProgress,
  getStoreHistory,
  getTaskDetail,
  getTemplates,
  getTodos,
} from "./queries.js";
import type { RulesFixture } from "./rules.js";
import {
  applyExemption,
  closeTask,
  publishTask,
  reviewExemption,
  submitReceiptsBatch,
} from "./service.js";
import { sendJson } from "./http.js";

export interface AppDeps {
  db: Database;
  rules: RulesFixture;
  cfg: AppConfig;
  now?: () => Date;
}

/** 组装全部路由；now 可注入以便测试 */
export function createApp(deps: AppDeps): Router {
  const now = deps.now ?? (() => new Date());
  const ctx = { db: deps.db, rules: deps.rules, cfg: deps.cfg, now };
  const r = new Router();

  r.get("/healthz", async () => ({ status: "ok" }));
  r.get("/readyz", async () => {
    await deps.db.query("SELECT 1");
    return { status: "ready" };
  });

  r.post("/api/v1/recall-tasks", async (c) => {
    const result = await publishTask(ctx, await c.body());
    sendJson(c.res, result.status, result.body);
    return undefined;
  });

  r.post("/api/v1/recall-tasks/:taskId/receipts:batch", async (c) => {
    const result = await submitReceiptsBatch(ctx, c.params["taskId"]!, await c.body());
    sendJson(c.res, result.status, result.body);
    return undefined;
  });

  r.post("/api/v1/recall-tasks/:taskId/exemptions", async (c) => {
    const result = await applyExemption(ctx, c.params["taskId"]!, await c.body());
    sendJson(c.res, result.status, result.body);
    return undefined;
  });

  r.post("/api/v1/exemptions/:exemptionId/review", async (c) => {
    const result = await reviewExemption(ctx, c.params["exemptionId"]!, await c.body());
    sendJson(c.res, result.status, result.body);
    return undefined;
  });

  r.post("/api/v1/recall-tasks/:taskId/close", async (c) => {
    const result = await closeTask(ctx, c.params["taskId"]!, await c.body());
    sendJson(c.res, result.status, result.body);
    return undefined;
  });

  r.get("/api/v1/brands/:brandId/recall-progress", async (c) =>
    getBrandProgress(ctx, c.params["brandId"]!),
  );

  r.get("/api/v1/recall-tasks/:taskId", async (c) => getTaskDetail(ctx, c.params["taskId"]!));

  r.get("/api/v1/stores/:storeCode/receipts", async (c) =>
    getStoreHistory(ctx, c.params["storeCode"]!, c.query),
  );

  r.get("/api/v1/todos", async (c) => getTodos(ctx, c.query));

  r.get("/api/v1/notice-templates", async (c) => getTemplates(ctx, c.query));

  return r;
}
