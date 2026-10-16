import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.join(__dirname, '..', 'db', 'migrations');

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.');
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version varchar(160) PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const migrationFiles = (await (await import('node:fs/promises')).readdir(migrationDir))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
  for (const filename of migrationFiles) {
    const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [filename]);
    if (exists.rowCount) {
      console.log(`Already applied: ${filename}`);
      continue;
    }
    const sql = await readFile(path.join(migrationDir, filename), 'utf8');
    console.log(`Applying ${filename}…`);
    await pool.query(sql);
    await pool.query('INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [filename]);
    console.log(`Applied: ${filename}`);
  }
}

main().catch((error) => {
  console.error('Database migration failed:', error.message);
  process.exitCode = 1;
}).finally(async () => pool.end());
