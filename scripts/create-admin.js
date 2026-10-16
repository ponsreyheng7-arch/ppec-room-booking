import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { pool, withTransaction } from '../src/db.js';

async function main() {
  const fullName = String(process.env.INITIAL_ADMIN_NAME || '').trim();
  const phone = String(process.env.INITIAL_ADMIN_PHONE || '').trim();
  const password = String(process.env.INITIAL_ADMIN_PASSWORD || '');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  if (!fullName || !phone) throw new Error('Set INITIAL_ADMIN_NAME and INITIAL_ADMIN_PHONE in .env.');
  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('INITIAL_ADMIN_PASSWORD must be at least 12 characters and contain letters and numbers.');
  }
  const existing = await pool.query("SELECT id,role FROM users WHERE role='admin' LIMIT 1");
  if (existing.rowCount) throw new Error('An administrator already exists. For safety this script never creates a second initial admin.');
  const hash = await bcrypt.hash(password, 12);
  const user = await withTransaction(async (client) => {
    const result = await client.query(
      `INSERT INTO users(phone,full_name,role,password_hash,password_change_required,status)
       VALUES($1,$2,'admin',$3,false,'active') RETURNING id,phone,full_name,role`,
      [phone, fullName, hash]
    );
    return result.rows[0];
  });
  console.log('Initial administrator created:', { id: user.id, phone: user.phone, fullName: user.full_name, role: user.role });
  console.log('For security, remove or rotate INITIAL_ADMIN_PASSWORD in the deployment environment after setup.');
}

main().catch((error) => {
  console.error('Administrator creation failed:', error.message);
  process.exitCode = 1;
}).finally(async () => pool.end());
