import { badRequest } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

export function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

export function reqString(
  obj: Record<string, unknown>,
  field: string,
  opts: { min?: number; max?: number } = {},
): string {
  const value = obj[field];
  if (typeof value !== 'string') throw badRequest(`field "${field}" must be a string`);
  const min = opts.min ?? 1;
  if (value.length < min) throw badRequest(`field "${field}" must have at least ${min} character(s)`);
  if (opts.max !== undefined && value.length > opts.max) {
    throw badRequest(`field "${field}" must have at most ${opts.max} characters`);
  }
  return value;
}

export function optString(
  obj: Record<string, unknown>,
  field: string,
  opts: { max?: number } = {},
): string | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`field "${field}" must be a string`);
  if (opts.max !== undefined && value.length > opts.max) {
    throw badRequest(`field "${field}" must have at most ${opts.max} characters`);
  }
  return value;
}

export function reqInt(obj: Record<string, unknown>, field: string, opts: { min?: number } = {}): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw badRequest(`field "${field}" must be an integer`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw badRequest(`field "${field}" must be >= ${opts.min}`);
  }
  return value;
}

export function parseIsoDate(value: string, field: string): Date {
  if (!ISO_DATE_RE.test(value)) {
    throw badRequest(`field "${field}" must be an ISO-8601 timestamp`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw badRequest(`field "${field}" is not a valid timestamp`);
  }
  return date;
}

export function reqIsoDate(obj: Record<string, unknown>, field: string): Date {
  return parseIsoDate(reqString(obj, field), field);
}

export function optIsoDate(obj: Record<string, unknown>, field: string): Date | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest(`field "${field}" must be an ISO-8601 timestamp`);
  return parseIsoDate(value, field);
}

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function reqUuid(obj: Record<string, unknown>, field: string): string {
  const value = reqString(obj, field);
  if (!isUuid(value)) throw badRequest(`field "${field}" must be a UUID`);
  return value.toLowerCase();
}

export function optUuidArray(obj: Record<string, unknown>, field: string): string[] | undefined {
  const value = obj[field];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 1000) {
    throw badRequest(`field "${field}" must be an array of 1..1000 UUIDs`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || !isUuid(item)) {
      throw badRequest(`field "${field}" must contain only UUIDs`);
    }
  }
  return (value as string[]).map((v) => v.toLowerCase());
}

export function reqEnum<T extends string>(
  obj: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = reqString(obj, field);
  if (!(allowed as readonly string[]).includes(value)) {
    throw badRequest(`field "${field}" must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Parse a `?limit` query param with bounds. */
export function queryLimit(query: URLSearchParams, def = 50, max = 200): number {
  const raw = query.get('limit');
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw badRequest(`query param "limit" must be an integer between 1 and ${max}`);
  }
  return n;
}

/** Parse a `?offset` query param. */
export function queryOffset(query: URLSearchParams): number {
  const raw = query.get('offset');
  if (raw === null) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw badRequest('query param "offset" must be a non-negative integer');
  }
  return n;
}
