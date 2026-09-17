import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { runMigrations } from '../migrate.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const applied = await runMigrations(pool);
  console.log(applied.length > 0 ? `applied migrations: ${applied.join(', ')}` : 'no pending migrations');
} finally {
  await pool.end();
}
