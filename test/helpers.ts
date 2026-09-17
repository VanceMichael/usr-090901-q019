import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type pg from 'pg';
import { createPool } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { buildServer } from '../src/server.js';

export interface TestApp {
  base: string;
  pool: pg.Pool;
  server: Server;
  close(): Promise<void>;
}

interface TestDb {
  url: string;
  stop(): Promise<void>;
}

let sharedDb: Promise<TestDb> | null = null;

/**
 * Test database strategy:
 *  - TEST_DATABASE_URL set (e.g. inside docker compose) → use it as-is;
 *  - otherwise boot a real, throwaway PostgreSQL 17 via embedded-postgres.
 */
function getTestDb(): Promise<TestDb> {
  sharedDb ??= (async (): Promise<TestDb> => {
    if (process.env.TEST_DATABASE_URL) {
      return { url: process.env.TEST_DATABASE_URL, stop: async () => undefined };
    }
    const port = 20000 + Math.floor(Math.random() * 20000);
    const embedded = new EmbeddedPostgres({
      databaseDir: mkdtempSync(join(tmpdir(), 'recall-pg-')),
      user: 'app',
      password: 'local-dev-only',
      port,
      persistent: false,
      onLog: () => undefined,
      onError: () => undefined,
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase('recall_test');
    return {
      url: `postgres://app:local-dev-only@127.0.0.1:${port}/recall_test`,
      stop: async () => embedded.stop(),
    };
  })();
  return sharedDb;
}

export async function stopTestDb(): Promise<void> {
  if (sharedDb !== null) {
    const db = await sharedDb;
    sharedDb = null;
    await db.stop();
  }
}

/** Start the HTTP service on an ephemeral port against the test database. */
export async function startApp(): Promise<TestApp> {
  const db = await getTestDb();
  const pool = createPool(db.url);
  await runMigrations(pool);
  const server = buildServer(pool);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  let closed = false;
  return {
    base: `http://127.0.0.1:${port}`,
    pool,
    server,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}

/** Deterministic fixture ids (distinct from the migration seed data). */
export const FIX = {
  batches: {
    b100: 'b0000000-0000-4000-8000-000000000100',
    b200: 'b0000000-0000-4000-8000-000000000200',
    v1: 'b0000000-0000-4000-8000-000000000301',
  },
  stores: {
    s1: '10000000-0000-4000-8000-000000000001',
    s2: '10000000-0000-4000-8000-000000000002',
    s3: '10000000-0000-4000-8000-000000000003',
    s4: '10000000-0000-4000-8000-000000000004',
    s5Inactive: '10000000-0000-4000-8000-000000000005',
    v1: '10000000-0000-4000-8000-000000000101',
    v2: '10000000-0000-4000-8000-000000000102',
  },
  templates: {
    std: '70000000-0000-4000-8000-000000000001',
    urgent: '70000000-0000-4000-8000-000000000002',
    velvetteStd: '70000000-0000-4000-8000-000000000003',
  },
} as const;

/** Truncate everything and reseed the deterministic fixtures. */
export async function resetDb(pool: pg.Pool): Promise<void> {
  await pool.query(`
    TRUNCATE coverage_snapshots, receipts, exemption_requests, recall_task_stores,
             recall_tasks, notification_templates, stores, batches, brands
    RESTART IDENTITY CASCADE
  `);
  await pool.query(`INSERT INTO brands (id, name) VALUES ('lumina', 'Lumina'), ('velvette', 'Velvette')`);
  await pool.query(
    `INSERT INTO batches (id, brand_id, batch_code, product_name, current_version, produced_at) VALUES
       ('${FIX.batches.b100}', 'lumina', 'B-100', '洁面乳', 3, '2026-08-20T00:00:00Z'),
       ('${FIX.batches.b200}', 'lumina', 'B-200', '精华露', 1, '2026-08-01T00:00:00Z'),
       ('${FIX.batches.v1}', 'velvette', 'V-1', '口红', 2, '2026-07-15T00:00:00Z')`,
  );
  await pool.query(
    `INSERT INTO stores (id, brand_id, store_code, name, region, active) VALUES
       ('${FIX.stores.s1}', 'lumina', 'S1', '门店一', '华东', TRUE),
       ('${FIX.stores.s2}', 'lumina', 'S2', '门店二', '华北', TRUE),
       ('${FIX.stores.s3}', 'lumina', 'S3', '门店三', '华南', TRUE),
       ('${FIX.stores.s4}', 'lumina', 'S4', '门店四', '西南', TRUE),
       ('${FIX.stores.s5Inactive}', 'lumina', 'S5', '门店五', '东北', FALSE),
       ('${FIX.stores.v1}', 'velvette', 'V1', '丝绒一店', '华东', TRUE),
       ('${FIX.stores.v2}', 'velvette', 'V2', '丝绒二店', '华中', TRUE)`,
  );
  await pool.query(
    `INSERT INTO notification_templates (id, brand_id, name, channel, body, rules) VALUES
       ('${FIX.templates.std}', 'lumina', 'std', 'app', '标准召回通知',
        '{"ackDeadlineHours": 72, "allowedChannels": ["app", "sms"], "exemptionReasonCodes": ["NO_STOCK", "STORE_CLOSED"], "minReasonTextLength": 8}'::jsonb),
       ('${FIX.templates.urgent}', 'lumina', 'urgent', 'sms', '紧急召回通知',
        '{"ackDeadlineHours": 24, "allowedChannels": ["sms"], "exemptionReasonCodes": ["NO_STOCK"], "minReasonTextLength": 8}'::jsonb),
       ('${FIX.templates.velvetteStd}', 'velvette', 'std', 'app', '标准召回通知',
        '{"ackDeadlineHours": 48, "allowedChannels": ["app"], "exemptionReasonCodes": ["NO_STOCK"], "minReasonTextLength": 10}'::jsonb)`,
  );
}

export interface ApiResponse {
  status: number;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  json: any;
  headers: Headers;
}

export async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, headers: res.headers };
}

/** Publish a standard lumina task (4 active stores) and return its taskId. */
export async function publishTask(
  app: TestApp,
  key: string,
  templateId: string = FIX.templates.std,
): Promise<string> {
  const res = await api(app.base, 'POST', '/api/recalls', {
    idempotencyKey: key,
    brandId: 'lumina',
    batchCode: 'B-100',
    batchVersion: 3,
    templateId,
  });
  if (res.status !== 201) {
    throw new Error(`publish failed: ${JSON.stringify(res.json)}`);
  }
  return res.json.taskId as string;
}

/** Acknowledge one store of a task; returns the per-item result. */
export async function ackStore(
  app: TestApp,
  taskId: string,
  storeId: string,
  receiptTime: Date = new Date(),
): Promise<{ ok: boolean; late?: boolean }> {
  const res = await api(app.base, 'POST', `/api/recalls/${taskId}/receipts`, {
    receipts: [{ storeId, receiptTime: receiptTime.toISOString(), channel: 'app' }],
  });
  return res.json.results[0] as { ok: boolean; late?: boolean };
}
