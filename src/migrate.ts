import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Database } from "./db.js";

/**
 * 迁移执行器：按文件名排序逐个应用，记录在 schema_migrations。
 * 每个迁移在单事务中执行，可安全重复启动。
 */
export async function runMigrations(db: Database, migrationsDir: string): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const applied: string[] = [];
  for (const file of files) {
    const { rowCount } = await db.query("SELECT 1 FROM schema_migrations WHERE version = $1", [file]);
    if (rowCount && rowCount > 0) continue;
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    await db.withTx(async (client) => {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
    });
    applied.push(file);
  }
  return applied;
}
