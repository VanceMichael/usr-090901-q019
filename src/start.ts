import { createServer, type Server } from "node:http";
import { createApp } from "./app.js";
import { loadConfig, type AppConfig } from "./config.js";
import { Database } from "./db.js";
import { runMigrations } from "./migrate.js";
import { loadRulesFixture, syncRuleSet, type RulesFixture } from "./rules.js";

export interface RunningApp {
  server: Server;
  db: Database;
  port: number;
  close: () => Promise<void>;
}

/** 启动服务：先迁移 + 同步规则集，再监听端口 */
export async function startApp(cfg?: Partial<AppConfig>): Promise<RunningApp> {
  const config: AppConfig = { ...loadConfig(), ...cfg };
  const rules: RulesFixture = loadRulesFixture(config.rulesFile);
  const db = new Database(config.databaseUrl);

  await runMigrations(db, config.migrationsDir);
  await syncRuleSet(db, rules);

  const router = createApp({ db, rules, cfg: config });
  const server = createServer((req, res) => {
    router.handle(req, res).catch((err) => {
      console.error("unhandled error", err);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "internal_error", message: "internal error" } }));
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  console.log(JSON.stringify({ msg: "listening", port }));

  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        db.close().then(() => resolve(), () => resolve());
      });
    });

  return { server, db, port, close };
}
