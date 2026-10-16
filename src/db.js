import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;
if (!process.env.DATABASE_URL) {
  console.warn('DATABASE_URL is not set. API requests requiring PostgreSQL will fail until configured.');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.SSL_MODE === 'require' ? { rejectUnauthorized: false } : undefined,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 8000
});

pool.on('error', (err) => console.error('Unexpected PostgreSQL pool error:', err.message));

export async function query(text, params = []) {
  return pool.query(text, params);
}

export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL TIME ZONE 'Asia/Phnom_Penh'");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
