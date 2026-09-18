import { loadConfig } from "./config.js";
import { Database } from "./db.js";
import { runMigrations } from "./migrate.js";
import { loadRulesFixture, syncRuleSet } from "./rules.js";

/** 独立迁移入口：docker compose 中可在启动 app 前执行 */
const cfg = loadConfig();
const db = new Database(cfg.databaseUrl);
try {
  const applied = await runMigrations(db, cfg.migrationsDir);
  await syncRuleSet(db, loadRulesFixture(cfg.rulesFile));
  console.log(JSON.stringify({ msg: "migrations applied", applied }));
} finally {
  await db.close();
}
