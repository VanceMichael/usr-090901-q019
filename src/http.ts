import type { IncomingMessage, ServerResponse } from "node:http";
import { ApiError, badRequest } from "./errors.js";

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  /** 已解析的 JSON 请求体（仅当有 body 时） */
  body(): Promise<unknown>;
}

type Handler = (ctx: Ctx) => Promise<unknown>;

interface Route {
  method: string;
  pattern: string;
  keys: string[];
  regex: RegExp;
  handler: Handler;
}

const MAX_BODY_BYTES = 1_048_576;

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    const keys: string[] = [];
    const regex = new RegExp(
      "^" +
        pattern
          .split("/")
          .map((seg) => {
            if (seg.startsWith(":")) {
              keys.push(seg.slice(1));
              return "([^/]+)";
            }
            return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          })
          .join("/") +
        "/?$",
    );
    this.routes.push({ method, pattern, keys, regex, handler });
  }

  get(pattern: string, h: Handler): void {
    this.add("GET", pattern, h);
  }
  post(pattern: string, h: Handler): void {
    this.add("POST", pattern, h);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const path = url.pathname;

    for (const route of this.routes) {
      if (route.method !== method) continue;
      const m = route.regex.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]!);
      });
      const ctx: Ctx = {
        req,
        res,
        params,
        query: url.searchParams,
        body: () => readJsonBody(req),
      };
      try {
        const result = await route.handler(ctx);
        if (result !== undefined && !res.headersSent) {
          sendJson(res, 200, result);
        }
      } catch (err) {
        sendError(res, err);
      }
      return;
    }
    sendError(res, new ApiError(404, "not_found", `路由不存在: ${method} ${path}`));
  }
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw badRequest("body_too_large", "请求体超过 1MB 限制");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest("invalid_json", "请求体不是合法 JSON");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof ApiError) {
    sendJson(res, err.status, err.toBody());
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: { code: "internal_error", message } });
}
