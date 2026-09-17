import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { withTx } from './db.js';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/**
 * Apply pending migrations from `dir` in filename order. Each file runs in
 * its own transaction and is recorded in `schema_migrations`. Idempotent —
 * safe to run on every service start.
 */
export async function runMigrations(pool: pg.Pool, dir: string = DEFAULT_DIR): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const existing = await pool.query('SELECT 1 FROM schema_migrations WHERE id = $1', [file]);
    if ((existing.rowCount ?? 0) > 0) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    await withTx(pool, async (tx) => {
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}
