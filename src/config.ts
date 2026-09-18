import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface AppConfig {
  port: number;
  databaseUrl: string;
  rulesFile: string;
  migrationsDir: string;
  /** 回执 received_at 允许的未来时钟偏移（毫秒） */
  futureSkewMs: number;
  /** 单批回执最大条数 */
  maxBatchReceipts: number;
  /** 待办/历史分页默认与上限 */
  defaultPageSize: number;
  maxPageSize: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/src/config.js -> 仓库根（Docker 镜像内为 /app）
const repoRoot = path.resolve(here, "..", "..");

function resolveExisting(candidates: string[]): string {
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0]!;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number.parseInt(env.PORT ?? "8080", 10),
    databaseUrl:
      env.DATABASE_URL ?? "postgres://app:local-dev-only@localhost:5432/app",
    rulesFile: resolveExisting([
      env.RULES_FILE ?? "",
      path.join(repoRoot, "fixtures", "rules.json"),
      "/workspace/fixtures/rules.json",
    ].filter(Boolean)),
    migrationsDir: resolveExisting([
      env.MIGRATIONS_DIR ?? "",
      path.join(repoRoot, "migrations"),
      "/workspace/migrations",
    ].filter(Boolean)),
    futureSkewMs: Number.parseInt(env.FUTURE_SKEW_MS ?? "300000", 10),
    maxBatchReceipts: Number.parseInt(env.MAX_BATCH_RECEIPTS ?? "500", 10),
    defaultPageSize: Number.parseInt(env.DEFAULT_PAGE_SIZE ?? "50", 10),
    maxPageSize: Number.parseInt(env.MAX_PAGE_SIZE ?? "200", 10),
  };
}
