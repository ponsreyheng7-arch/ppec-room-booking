import { query } from './db.js';

export async function writeAudit(req, { action, entityType, entityId = null, reason = null, details = {} }) {
  const userId = req.currentUser?.id || req.session?.user?.id || null;
  await query(
    `INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, reason, ip_address, user_agent, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [userId, action, entityType, entityId == null ? null : String(entityId), reason,
      req.ip || null, String(req.get('user-agent') || '').slice(0, 400), JSON.stringify(details)]
  );
}

export function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function requirePasswordReady(req, res, next) {
  if (req.currentUser?.password_change_required && !['/api/auth/change-password', '/api/auth/me', '/api/auth/logout'].includes(req.originalUrl.split('?')[0])) {
    return res.status(428).json({ error: 'PASSWORD_CHANGE_REQUIRED', message: 'Change your temporary password before continuing.' });
  }
  next();
}

export function requireAdmin(req, res, next) {
  if (req.currentUser?.role !== 'admin') return res.status(403).json({ error: 'FORBIDDEN', message: 'Administrator permission is required.' });
  next();
}

export function safeUserRow(row) {
  return {
    id: row.id, phone: row.phone, fullName: row.full_name, email: row.email,
    role: row.role, status: row.status, passwordChangeRequired: row.password_change_required,
    doctorId: row.doctor_id || null, doctorCode: row.doctor_code || null,
    doctorType: row.doctor_type || null
  };
}

export function csvResponse(res, filename, columns, rows) {
  const { csvEscape } = globalThis.__ppecDomainForCsv || {};
  const escape = csvEscape || ((value) => `"${String(value ?? '').replaceAll('"', '""')}"`);
  const content = [columns.map((c) => escape(c.label)).join(','), ...rows.map((row) => columns.map((c) => escape(row[c.key])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + content);
}
