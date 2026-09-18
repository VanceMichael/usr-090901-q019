/**
 * 键集（keyset）分页游标：不透明 base64url(JSON)。
 * 游标本身无状态，重启后仍然有效；格式非法时返回明确错误。
 */
import { badRequest } from "./errors.js";

export interface TodoCursor {
  /** deadline_at ISO 时间 */
  d: string;
  /** notice_id */
  n: number;
}

export interface HistoryCursor {
  /** recorded_at ISO 时间 */
  r: string;
  /** 行 id（receipt_id 或 exemption_id） */
  i: number;
}

function encode(payload: object): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decode<T extends object>(raw: string, shape: (v: unknown) => v is T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw badRequest("invalid_cursor", "游标格式非法，无法解析");
  }
  if (!shape(parsed)) {
    throw badRequest("invalid_cursor", "游标内容不完整或类型错误");
  }
  return parsed;
}

const isIso = (v: unknown): v is string =>
  typeof v === "string" && !Number.isNaN(Date.parse(v));

export const encodeTodoCursor = (c: TodoCursor): string => encode(c);
export const decodeTodoCursor = (raw: string): TodoCursor =>
  decode<TodoCursor>(
    raw,
    (v): v is TodoCursor =>
      typeof v === "object" &&
      v !== null &&
      isIso((v as TodoCursor).d) &&
      Number.isInteger((v as TodoCursor).n),
  );

export const encodeHistoryCursor = (c: HistoryCursor): string => encode(c);
export const decodeHistoryCursor = (raw: string): HistoryCursor =>
  decode<HistoryCursor>(
    raw,
    (v): v is HistoryCursor =>
      typeof v === "object" &&
      v !== null &&
      isIso((v as HistoryCursor).r) &&
      Number.isInteger((v as HistoryCursor).i),
  );
