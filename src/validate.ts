import { badRequest, unprocessable } from "./errors.js";

/** 从请求体中取必填字符串字段 */
export function reqString(body: Record<string, unknown>, field: string, maxLen = 200): string {
  const v = body[field];
  if (typeof v !== "string" || v.trim() === "") {
    throw unprocessable("invalid_field", `字段 ${field} 必须为非空字符串`, { field });
  }
  const s = v.trim();
  if (s.length > maxLen) {
    throw unprocessable("invalid_field", `字段 ${field} 长度超过 ${maxLen}`, { field });
  }
  return s;
}

export function optString(body: Record<string, unknown>, field: string, maxLen = 2000): string | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length > maxLen) {
    throw unprocessable("invalid_field", `字段 ${field} 必须为长度不超过 ${maxLen} 的字符串`, { field });
  }
  return v;
}

/** 必填正整数 */
export function reqInt(body: Record<string, unknown>, field: string, min = 1): number {
  const v = body[field];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    throw unprocessable("invalid_field", `字段 ${field} 必须为不小于 ${min} 的整数`, { field });
  }
  return v;
}

/** 必填 RFC3339 时间 */
export function reqTime(body: Record<string, unknown>, field: string): Date {
  const v = body[field];
  if (typeof v !== "string") {
    throw unprocessable("invalid_field", `字段 ${field} 必须为 RFC3339 时间字符串`, { field });
  }
  return parseTime(v, field);
}

export function optTime(body: Record<string, unknown>, field: string): Date | undefined {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") {
    throw unprocessable("invalid_field", `字段 ${field} 必须为 RFC3339 时间字符串`, { field });
  }
  return parseTime(v, field);
}

export function parseTime(v: string, field: string): Date {
  const t = Date.parse(v);
  if (Number.isNaN(t)) {
    throw unprocessable("invalid_field", `字段 ${field} 不是合法的 RFC3339 时间`, { field });
  }
  return new Date(t);
}

export function reqObject(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw badRequest("invalid_body", "请求体必须为 JSON 对象");
  }
  return v as Record<string, unknown>;
}

export function reqArray(body: Record<string, unknown>, field: string, min = 1, max = 500): unknown[] {
  const v = body[field];
  if (!Array.isArray(v) || v.length < min || v.length > max) {
    throw unprocessable("invalid_field", `字段 ${field} 必须为长度 ${min}..${max} 的数组`, { field });
  }
  return v;
}

export function requireRole(role: string, allowed: readonly string[]): void {
  if (!allowed.includes(role)) {
    throw unprocessable("forbidden_role", `角色 ${role} 无权执行该操作`, {
      field: "actor_role",
      allowed,
    });
  }
}

/** 分页 limit 解析 */
export function parseLimit(raw: string | undefined, def: number, max: number): number {
  if (raw === undefined) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw unprocessable("invalid_field", `limit 必须为 1..${max} 的整数`, { field: "limit" });
  }
  return n;
}
