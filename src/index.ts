import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';
import { buildServer } from './server.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);

const applied = await runMigrations(pool);
if (applied.length > 0) {
  console.log(`applied migrations: ${applied.join(', ')}`);
}

const server = buildServer(pool);
server.listen(config.port, () => {
  console.log(`recall service listening on :${config.port}`);
});

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  console.log(`received ${signal}, shutting down`);
  server.close();
  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
