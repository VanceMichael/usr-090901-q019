import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { RunningApp } from "../src/start.js";

/**
 * 测试上下文：
 * - APP_BASE_URL 设置时：黑盒模式，直接打 HTTP（容器验收用）
 * - 否则：进程内模式，启动真实服务；DATABASE_URL 未设置时引导 embedded-postgres
 */
export interface TestCtx {
  mode: "in-process" | "black-box";
  baseUrl: string;
  /** 仅进程内模式：关闭并在同一数据库上重启应用（重启恢复测试） */
  restart: () => Promise<void>;
  close: () => Promise<void>;
}

interface EmbeddedPg {
  initialise(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  createDatabase(name: string): Promise<void>;
}

let cached: Promise<TestCtx> | null = null;

export function getCtx(): Promise<TestCtx> {
  if (!cached) cached = createCtx();
  return cached;
}

async function freePort(): Promise<number> {
  const srv = createServer();
  srv.listen(0, "127.0.0.1");
  await new Promise<void>((r) => srv.once("listening", r));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

async function createCtx(): Promise<TestCtx> {
  const baseUrl = process.env.APP_BASE_URL;
  if (baseUrl) {
    return {
      mode: "black-box",
      baseUrl,
      restart: async () => {
        throw new Error("黑盒模式不支持进程内重启，请使用 RESTART_PHASE 两阶段验收");
      },
      close: async () => undefined,
    };
  }

  let databaseUrl = process.env.DATABASE_URL;
  let pg: EmbeddedPg | null = null;
  if (!databaseUrl) {
    const { default: EmbeddedPostgres } = await import("embedded-postgres");
    const port = await freePort();
    const databaseDir = mkdtempSync(path.join(tmpdir(), "epg-recall-"));
    pg = new EmbeddedPostgres({
      databaseDir,
      user: "app",
      password: "test-pw",
      port,
      persistent: false,
      // 沙箱/最小镜像缺少 en_US.UTF-8 locale，覆盖为 C
      initdbFlags: ["--lc-messages=C", "--locale=C"],
    }) as EmbeddedPg;
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("app");
    databaseUrl = `postgres://app:test-pw@127.0.0.1:${port}/app`;
  }

  const { startApp } = await import("../src/start.js");
  let app: RunningApp;
  try {
    app = await startApp({ databaseUrl, port: 0 });
  } catch (err) {
    // 启动失败时务必停掉 PG 子进程，避免测试进程挂起
    if (pg) await pg.stop().catch(() => undefined);
    throw err;
  }

  return {
    mode: "in-process",
    get baseUrl() {
      return `http://127.0.0.1:${app.port}`;
    },
    restart: async () => {
      await app.close();
      app = await startApp({ databaseUrl: databaseUrl!, port: 0 });
    },
    close: async () => {
      await app.close();
      if (pg) await pg.stop();
    },
  };
}

let counter = 0;
/** 测试内唯一 id 前缀，避免用例间相互污染 */
export function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${process.pid.toString(36)}-${Date.now().toString(36)}-${counter}`;
}

export interface ApiResponse {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

export async function api(
  ctx: TestCtx,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(ctx.baseUrl + path, init);
  const json = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, json };
}

export const iso = (d: Date): string => d.toISOString();
export const hoursFromNow = (h: number): string => new Date(Date.now() + h * 3_600_000).toISOString();
export const hoursAgo = (h: number): string => hoursFromNow(-h);
