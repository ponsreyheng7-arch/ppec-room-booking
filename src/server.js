import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pool, query, withTransaction } from './db.js';
import {
  TIME_ZONE, localDateTimeToDate, calculateCommission, paymentStatus, csvEscape
} from './domain.js';
import { writeAudit, asyncRoute, requireAdmin, requirePasswordReady, safeUserRow, csvResponse } from './security.js';

globalThis.__ppecDomainForCsv = { csvEscape };
const app = express(); 
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PgSession = connectPgSimple(session);
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET must be set to at least 32 random characters in production.');
}

app.disable('x-powered-by');
app.set('trust proxy', isProduction ? 1 : false);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      styleSrcAttr: ["'unsafe-inline'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(express.json({ limit: '250kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(session({
  name: 'ppec.sid',
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-session-secret-now',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === 'true' || isProduction,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  }
}));

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'LOGIN_RATE_LIMIT', message: 'Too many login attempts. Try again in 15 minutes.' }
});

// Block cross-origin browser state changes (the app is deployed same-origin).
app.use('/api', (req, res, next) => {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).json({ message: 'Cross-origin request blocked.' });
    } catch { return res.status(403).json({ message: 'Invalid request origin.' }); }
  }
  next();
});

app.get('/api/health', asyncRoute(async (_req, res) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, database: 'connected', timeZone: TIME_ZONE });
  } catch {
    res.status(503).json({ ok: false, database: 'unavailable', timeZone: TIME_ZONE });
  }
}));

app.post('/api/auth/login', loginLimiter, asyncRoute(async (req, res) => {
  const phone = String(req.body?.phone || '').trim();
  const password = String(req.body?.password || '');
  if (!phone || !password || password.length > 200) return res.status(400).json({ message: 'Enter your registered phone number and password.' });
  const found = await query(
    `SELECT u.*, d.id AS doctor_id, d.doctor_code, d.doctor_type
     FROM users u LEFT JOIN doctors d ON d.user_id=u.id WHERE u.phone=$1 LIMIT 1`, [phone]
  );
  const user = found.rows[0];
  if (!user || user.status !== 'active' || !(await bcrypt.compare(password, user.password_hash))) {
    await query(`INSERT INTO audit_logs(actor_user_id,action,entity_type,ip_address,user_agent,details)
                 VALUES (NULL,'login_failed','authentication',$1,$2,$3::jsonb)`,
      [req.ip || null, String(req.get('user-agent') || '').slice(0, 400), JSON.stringify({ phoneAttempt: phone.slice(-4) })]).catch(() => {});
    return res.status(401).json({ message: 'Invalid phone number or password, or the account is not active.' });
  }

  await new Promise((resolve, reject) => {
    req.session.regenerate((err) => err ? reject(err) : resolve());
  });
  req.session.user = { id: user.id };
  await new Promise((resolve, reject) => {
    req.session.save((err) => err ? reject(err) : resolve());
  });
  await query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);

  await query(
    `INSERT INTO audit_logs (
       actor_user_id, action, entity_type, entity_id,
       ip_address, user_agent, details
     )
     VALUES ($1::uuid, 'login_success', 'user', $2::varchar, $3::inet, $4, '{}'::jsonb)`,
    [
      user.id,
      user.id,
      req.ip || null,
      String(req.get('user-agent') || '').slice(0, 400)
    ]
  );

  const fresh = await query(`SELECT u.id,u.phone,u.full_name,u.email,u.role,u.status,u.password_change_required,
                                    d.id AS doctor_id,d.doctor_code,d.doctor_type
                             FROM users u LEFT JOIN doctors d ON d.user_id=u.id WHERE u.id=$1`, [user.id]);
  res.json({ user: safeUserRow(fresh.rows[0]), timeZone: TIME_ZONE });
}));


async function requireSession(req, res, next) {
  if (!req.session?.user?.id) return res.status(401).json({ message: 'Please sign in to continue.' });
  try {
    const result = await query(
      `SELECT u.id,u.phone,u.full_name,u.email,u.role,u.status,u.password_change_required,
              d.id AS doctor_id,d.doctor_code,d.doctor_type,d.commission_percentage
       FROM users u LEFT JOIN doctors d ON d.user_id=u.id WHERE u.id=$1`, [req.session.user.id]
    );
    const user = result.rows[0];
    if (!user || user.status !== 'active') {
      req.session.destroy(() => {});
      return res.status(401).json({ message: 'This account is inactive. Contact the PPEC administrator.' });
    }
    req.currentUser = user;
    next();
  } catch (err) { next(err); }
}
app.use('/api', (req, res, next) => req.path === '/health' || req.path === '/auth/login' ? next() : requireSession(req, res, next));
app.use('/api', (req, res, next) => req.path === '/auth/change-password' || req.path === '/auth/me' || req.path === '/auth/logout' ? next() : requirePasswordReady(req, res, next));

app.get('/api/auth/me', asyncRoute(async (req, res) => {
  res.json({ user: safeUserRow(req.currentUser), timeZone: TIME_ZONE });
}));

app.post('/api/auth/change-password', asyncRoute(async (req, res) => {
  const oldPassword = String(req.body?.oldPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (newPassword.length < 12 || newPassword.length > 200 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return res.status(400).json({ message: 'Use at least 12 characters and include letters and numbers.' });
  }
  const check = await query('SELECT password_hash FROM users WHERE id=$1', [req.currentUser.id]);
  if (!check.rows[0] || !(await bcrypt.compare(oldPassword, check.rows[0].password_hash))) {
    return res.status(400).json({ message: 'Current password is not correct.' });
  }
  const hash = await bcrypt.hash(newPassword, 12);
  await query('UPDATE users SET password_hash=$1,password_change_required=false,updated_at=now() WHERE id=$2', [hash, req.currentUser.id]);
  await writeAudit(req, { action: 'password_changed', entityType: 'user', entityId: req.currentUser.id });
  res.json({ ok: true, message: 'Password updated. You can now continue.' });
}));

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  await writeAudit(req, { action: 'logout', entityType: 'user', entityId: req.currentUser.id }).catch(() => {});
  await new Promise((resolve) => req.session.destroy(() => resolve()));
  res.clearCookie('ppec.sid', { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true' || isProduction });
  res.json({ ok: true });
}));

app.get('/api/meta', asyncRoute(async (_req, res) => {
  const [rooms, types, hours] = await Promise.all([
    query('SELECT id,code,display_name FROM operating_rooms WHERE active=true ORDER BY code'),
    query('SELECT id,name,default_duration_minutes FROM surgery_types WHERE active=true ORDER BY name'),
    query('SELECT weekday,session_name,start_time,end_time FROM operating_hours WHERE active=true ORDER BY weekday,start_time')
  ]);
  res.json({ rooms: rooms.rows, surgeryTypes: types.rows, operatingHours: hours.rows, timeZone: TIME_ZONE });
}));

function localWeekday(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}
function minutesOf(time) {
  const [h, m] = String(time).slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}
function validateBasics(body) {
  const date = String(body.date || '');
  const time = String(body.startTime || '');
  const duration = Number(body.durationMinutes);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw Object.assign(new Error('Select a valid surgery date and start time.'), { status: 400 });
  if (!Number.isInteger(duration) || duration < 30 || duration % 30 !== 0 || duration > 360) throw Object.assign(new Error('Duration must be in 30-minute increments.'), { status: 400 });
  const start = localDateTimeToDate(date, time);
  const end = new Date(start.getTime() + duration * 60000);
  return { date, time, duration, start, end };
}
async function validateSlot(client, { date, start, end, roomId, durationMinutes, now = new Date(), overrideReason = null }) {
  if (!roomId) throw Object.assign(new Error('Select an operating room bed.'), { status: 400 });
  const room = await client.query('SELECT id FROM operating_rooms WHERE id=$1 AND active=true', [roomId]);
  if (!room.rowCount) throw Object.assign(new Error('The selected operating room bed is not available.'), { status: 400 });
  const advanceHours = (start.getTime() - now.getTime()) / 3600000;
  if (advanceHours < 48 && !overrideReason) throw Object.assign(new Error('Bookings must be made at least 48 hours in advance.'), { status: 400, code: 'ADVANCE_NOTICE' });
  const weekday = localWeekday(date);
  const slots = await client.query('SELECT start_time,end_time FROM operating_hours WHERE weekday=$1 AND active=true', [weekday]);
  const startTimeLocal = start.toLocaleTimeString('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });
  const endTimeLocal = end.toLocaleTimeString('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hour12: false });
  const sMinute = minutesOf(startTimeLocal), eMinute = minutesOf(endTimeLocal);
  const inSession = slots.rows.some(s => sMinute >= minutesOf(s.start_time) && eMinute <= minutesOf(s.end_time) && eMinute > sMinute);
  if (!inSession && !overrideReason) throw Object.assign(new Error('The entire surgery must fit within an operating session (08:00–11:00 or 14:00–17:00, Monday–Saturday).'), { status: 400, code: 'OUTSIDE_SESSION' });
  const blocked = await client.query(
    `SELECT 1 FROM blocked_periods WHERE active=true AND starts_at < $2 AND ends_at > $1 AND (operating_room_id IS NULL OR operating_room_id=$3) LIMIT 1`,
    [start.toISOString(), end.toISOString(), roomId]
  );
  if (blocked.rowCount && !overrideReason) throw Object.assign(new Error('This time overlaps a holiday, maintenance block, or temporary closure.'), { status: 409, code: 'BLOCKED_PERIOD' });
  // The database exclusion constraint is the final safeguard against concurrent bookings.
  return { startAt: start.toISOString(), endAt: end.toISOString(), durationMinutes: durationMinutes ?? (end - start) / 60000 };
}
function isAdmin(req) { return req.currentUser?.role === 'admin'; }
async function doctorIdForRequest(req, requestedDoctorId) {
  if (isAdmin(req)) {
    if (!requestedDoctorId) throw Object.assign(new Error('Select the surgeon for this booking.'), { status: 400 });
    return requestedDoctorId;
  }
  if (!req.currentUser.doctor_id) throw Object.assign(new Error('A surgeon profile is required to book an operating room.'), { status: 403 });
  return req.currentUser.doctor_id;
}
async function makeBooking(client, req, body, { forceOverride = false } = {}) {
  const { date, time, duration, start, end } = validateBasics(body);
  const surgeonId = await doctorIdForRequest(req, body.doctorId);
  const overrideRequested = isAdmin(req) && (forceOverride || body.overrideRules === true || body.overrideRules === 'on');
  const overrideReason = overrideRequested ? String(body.overrideReason || '').trim() : null;
  if (overrideRequested && !overrideReason) throw Object.assign(new Error('An administrator override requires a reason.'), { status: 400 });
  if (overrideRequested && overrideReason.length < 5) throw Object.assign(new Error('Please record a meaningful override reason (at least 5 characters).'), { status: 400 });
  const doctor = await client.query(`SELECT d.id,d.approved_surgery_types FROM doctors d JOIN users u ON u.id=d.user_id WHERE d.id=$1 AND u.status='active'`, [surgeonId]);
  if (!doctor.rowCount) throw Object.assign(new Error('The selected surgeon profile does not exist.'), { status: 404 });
  const surgeryType = await client.query('SELECT id,name,default_duration_minutes FROM surgery_types WHERE id=$1 AND active=true', [body.surgeryTypeId]);
  if (!surgeryType.rowCount) throw Object.assign(new Error('Select an active surgery type.'), { status: 400 });
  if (!isAdmin(req) && Array.isArray(doctor.rows[0].approved_surgery_types) && doctor.rows[0].approved_surgery_types.length && !doctor.rows[0].approved_surgery_types.includes(body.surgeryTypeId)) {
    throw Object.assign(new Error('This surgery type is not approved for your surgeon profile. Contact the administrator.'), { status: 403 });
  }
  const roomResult = body.operatingRoomId
    ? await client.query('SELECT id FROM operating_rooms WHERE id=$1 AND active=true', [body.operatingRoomId])
    : await client.query('SELECT id FROM operating_rooms WHERE code=$1 AND active=true', [String(body.bedCode || '')]);
  if (!roomResult.rowCount) throw Object.assign(new Error('Select an active operating room bed.'), { status: 400 });
  await validateSlot(client, { date, start, end, roomId: roomResult.rows[0].id, durationMinutes: duration, overrideReason });
  const patientName = String(body.patientName || '').trim();
  const patientPhone = String(body.patientPhone || '').trim();
  if (!patientName || patientName.length > 180) throw Object.assign(new Error('Patient full name is required (maximum 180 characters).'), { status: 400 });
  if (!patientPhone || patientPhone.length > 40) throw Object.assign(new Error('Patient phone number is required.'), { status: 400 });
  const eye = String(body.operatedEye || '');
  if (!['RE','LE','BE'].includes(eye)) throw Object.assign(new Error('Choose RE, LE, or BE for the operated eye.'), { status: 400 });
  const ppecPatientId = String(body.ppecPatientId || '').trim().slice(0, 80) || null;
  const recordUrl = String(body.patientRecordUrl || '').trim();
  if (recordUrl && !/^https:\/\//i.test(recordUrl)) throw Object.assign(new Error('Patient record links must use HTTPS.'), { status: 400 });
  const patient = await client.query(
    `INSERT INTO patients(ppec_patient_id,full_name,phone,external_record_url,created_by)
     VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [ppecPatientId, patientName, patientPhone, recordUrl || null, req.currentUser.id]
  );
  const code = `PPEC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
  const booking = await client.query(
    `INSERT INTO bookings(booking_code,doctor_id,patient_id,surgery_type_id,operating_room_id,start_at,end_at,status,operated_eye,notes,created_by,updated_by,override_reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,'confirmed',$8,$9,$10,$10,$11)
     RETURNING id,booking_code,start_at,end_at,status,operated_eye`,
    [code, surgeonId, patient.rows[0].id, body.surgeryTypeId, roomResult.rows[0].id,
      start.toISOString(), end.toISOString(), eye, String(body.notes || '').trim().slice(0, 2000) || null, req.currentUser.id, overrideReason]
  );
  return booking.rows[0];
}

app.get('/api/calendar', asyncRoute(async (req, res) => {
  const from = req.query.from, to = req.query.to;
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return res.status(400).json({ message: 'Provide from and to dates in YYYY-MM-DD format.' });
  if (from > to || new Date(`${to}T00:00:00Z`) - new Date(`${from}T00:00:00Z`) > 45 * 86400000) return res.status(400).json({ message: 'Choose a valid calendar range of 45 days or less.' });
  const params = [`${from}T00:00:00+07:00`, `${to}T23:59:59.999+07:00`];
  const result = await query(
    `SELECT b.id,b.booking_code,b.doctor_id,b.operating_room_id,b.surgery_type_id,b.operated_eye,b.start_at,b.end_at,b.status,b.notes,
            r.code AS bed_code,r.display_name AS bed_name,st.name AS surgery_type,
            p.full_name AS patient_name,p.phone AS patient_phone,p.ppec_patient_id,p.external_record_url,
            d.doctor_code,u.full_name AS doctor_name
     FROM bookings b JOIN operating_rooms r ON r.id=b.operating_room_id
     JOIN surgery_types st ON st.id=b.surgery_type_id JOIN patients p ON p.id=b.patient_id
     JOIN doctors d ON d.id=b.doctor_id JOIN users u ON u.id=d.user_id
     WHERE b.start_at <= $2 AND b.end_at >= $1 AND b.status NOT IN ('cancelled','rescheduled')
     ORDER BY b.start_at`, params
  );
  const bookings = result.rows.map(b => {
    const own = b.doctor_id === req.currentUser.doctor_id;
    if (isAdmin(req) || own) return { ...b, isMine: own };
    return { id: b.id, start_at: b.start_at, end_at: b.end_at,
      status: 'booked', bed_code: b.bed_code, bed_name: b.bed_name, isMine: false };
  });
  const [rooms, blocked] = await Promise.all([
    query('SELECT id,code,display_name FROM operating_rooms WHERE active=true ORDER BY code'),
    query(`SELECT id,title,starts_at,ends_at,operating_room_id FROM blocked_periods WHERE active=true AND starts_at <= $2 AND ends_at >= $1 ORDER BY starts_at`, params)
  ]);
  res.json({ bookings, rooms: rooms.rows, blockedPeriods: blocked.rows.map(x => ({ id:x.id,title:x.title,starts_at:x.starts_at,ends_at:x.ends_at,operating_room_id:x.operating_room_id })), timeZone: TIME_ZONE });
}));

app.get('/api/bookings', asyncRoute(async (req, res) => {
  const from = req.query.from || '2000-01-01'; const to = req.query.to || '2999-12-31';
  const params = [`${from}T00:00:00+07:00`, `${to}T23:59:59.999+07:00`];
  const where = isAdmin(req) ? 'b.start_at <= $2 AND b.end_at >= $1' : 'b.doctor_id=$3 AND b.start_at <= $2 AND b.end_at >= $1';
  if (!isAdmin(req)) params.push(req.currentUser.doctor_id || '00000000-0000-0000-0000-000000000000');
  const result = await query(
    `SELECT b.id,b.booking_code,b.start_at,b.end_at,b.status,b.operated_eye,b.notes,b.cancellation_reason,
            r.code AS bed_code,r.display_name AS bed_name,st.name AS surgery_type,st.id AS surgery_type_id,
            p.id AS patient_id,p.ppec_patient_id,p.full_name AS patient_name,p.phone AS patient_phone,p.external_record_url,
            d.id AS doctor_id,d.doctor_code,u.full_name AS doctor_name
     FROM bookings b JOIN operating_rooms r ON r.id=b.operating_room_id
     JOIN surgery_types st ON st.id=b.surgery_type_id JOIN patients p ON p.id=b.patient_id
     JOIN doctors d ON d.id=b.doctor_id JOIN users u ON u.id=d.user_id
     WHERE ${where} ORDER BY b.start_at DESC LIMIT 500`, params
  );
  res.json({ bookings: result.rows });
}));

app.get('/api/bookings/:id', asyncRoute(async (req, res) => {
  const result = await query(
    `SELECT b.*,r.code AS bed_code,r.display_name AS bed_name,st.name AS surgery_type,
            p.ppec_patient_id,p.full_name AS patient_name,p.phone AS patient_phone,p.external_record_url,
            d.doctor_code,u.full_name AS doctor_name
     FROM bookings b JOIN operating_rooms r ON r.id=b.operating_room_id JOIN surgery_types st ON st.id=b.surgery_type_id
     JOIN patients p ON p.id=b.patient_id JOIN doctors d ON d.id=b.doctor_id JOIN users u ON u.id=d.user_id WHERE b.id=$1`, [req.params.id]
  );
  const b = result.rows[0];
  if (!b) return res.status(404).json({ message: 'Booking not found.' });
  if (!isAdmin(req) && b.doctor_id !== req.currentUser.doctor_id) return res.status(404).json({ message: 'Booking not found.' });
  res.json({ booking: b });
}));

app.post('/api/bookings', asyncRoute(async (req, res) => {
  const booking = await withTransaction(async client => makeBooking(client, req, req.body || {}));
  await writeAudit(req, { action: 'booking_created', entityType: 'booking', entityId: booking.id, reason: (isAdmin(req) && req.body?.overrideReason) ? String(req.body.overrideReason).trim() : null, details: { bookingCode: booking.booking_code, overrideRequested: Boolean(isAdmin(req) && req.body?.overrideReason) } });
  res.status(201).json({ booking });
}));

app.patch('/api/bookings/:id', asyncRoute(async (req, res) => {
  const result = await query('SELECT * FROM bookings WHERE id=$1', [req.params.id]);
  const booking = result.rows[0];
  if (!booking) return res.status(404).json({ message: 'Booking not found.' });
  if (!isAdmin(req) && booking.doctor_id !== req.currentUser.doctor_id) return res.status(404).json({ message: 'Booking not found.' });
  if (!isAdmin(req) && booking.status !== 'confirmed') return res.status(400).json({ message: 'Only confirmed bookings can be edited.' });
  const notes = req.body?.notes === undefined ? booking.notes : String(req.body.notes).trim().slice(0, 2000) || null;
  const updated = await query('UPDATE bookings SET notes=$1,updated_by=$2,updated_at=now() WHERE id=$3 RETURNING id,booking_code,status,notes,updated_at', [notes, req.currentUser.id, booking.id]);
  await writeAudit(req, { action: 'booking_updated', entityType: 'booking', entityId: booking.id, details: { changedFields: ['notes'] } });
  res.json({ booking: updated.rows[0] });
}));

app.post('/api/bookings/:id/cancel', asyncRoute(async (req, res) => {
  const booking = await query('SELECT * FROM bookings WHERE id=$1', [req.params.id]);
  const current = booking.rows[0];
  if (!current) return res.status(404).json({ message: 'Booking not found.' });
  if (!isAdmin(req) && current.doctor_id !== req.currentUser.doctor_id) return res.status(404).json({ message: 'Booking not found.' });
  if (current.status !== 'confirmed') return res.status(400).json({ message: 'Only confirmed bookings can be cancelled.' });
  const reason = String(req.body?.reason || '').trim();
  const override = isAdmin(req) && Boolean(req.body?.override);
  if (override && reason.length < 5) return res.status(400).json({ message: 'An administrator override requires a reason of at least 5 characters.' });
  const hoursLeft = (new Date(current.start_at).getTime() - Date.now()) / 3600000;
  if (!isAdmin(req) && hoursLeft < 24) return res.status(400).json({ message: 'Bookings can only be cancelled at least 24 hours before their scheduled start time.' });
  if (isAdmin(req) && hoursLeft < 24 && !override) return res.status(400).json({ message: 'This booking is inside the 24-hour cancellation window. Use an authorized override with a reason.' });
  const updated = await query(`UPDATE bookings SET status='cancelled',cancellation_reason=$1,override_reason=COALESCE($2,override_reason),updated_by=$3,updated_at=now() WHERE id=$4 RETURNING id,booking_code,status`, [reason || null, override ? reason : null, req.currentUser.id, current.id]);
  await writeAudit(req, { action: 'booking_cancelled', entityType: 'booking', entityId: current.id, reason: override ? reason : (reason || null), details: { hoursUntilStart: Math.round(hoursLeft * 100) / 100, override } });
  res.json({ booking: updated.rows[0] });
}));

app.post('/api/bookings/:id/reschedule', asyncRoute(async (req, res) => {
  const response = await withTransaction(async client => {
    const found = await client.query('SELECT * FROM bookings WHERE id=$1 FOR UPDATE', [req.params.id]);
    const old = found.rows[0];
    if (!old) throw Object.assign(new Error('Booking not found.'), { status: 404 });
    if (!isAdmin(req) && old.doctor_id !== req.currentUser.doctor_id) throw Object.assign(new Error('Booking not found.'), { status: 404 });
    if (old.status !== 'confirmed') throw Object.assign(new Error('Only confirmed bookings can be rescheduled.'), { status: 400 });
    const reason = String(req.body?.reason || '').trim();
    const adminOverride = isAdmin(req) && Boolean(req.body?.overrideRules);
    const oldHoursLeft = (new Date(old.start_at).getTime() - Date.now()) / 3600000;
    if (oldHoursLeft < 24 && !adminOverride) throw Object.assign(new Error('A booking can only be rescheduled at least 24 hours before its existing start time. An administrator may override this with a reason.'), { status: 400 });
    if (adminOverride && reason.length < 5) throw Object.assign(new Error('An administrator override requires a reason of at least 5 characters.'), { status: 400 });
    // The old slot is released inside the same transaction before the replacement is validated.
    await client.query(`UPDATE bookings SET status='rescheduled',updated_by=$1,updated_at=now() WHERE id=$2`, [req.currentUser.id, old.id]);
    const body = {
      ...req.body, doctorId: isAdmin(req) ? (req.body.doctorId || old.doctor_id) : undefined,
      surgeryTypeId: req.body.surgeryTypeId || old.surgery_type_id,
      patientName: req.body.patientName || null,
      patientPhone: req.body.patientPhone || null,
      operatedEye: req.body.operatedEye || 'RE',
      durationMinutes: Number(req.body.durationMinutes || Math.round((new Date(old.end_at)-new Date(old.start_at))/60000)),
      operatingRoomId: req.body.operatingRoomId || old.operating_room_id,
      patientRecordUrl: req.body.patientRecordUrl || '',
      ppecPatientId: req.body.ppecPatientId || '',
      overrideReason: isAdmin(req) && req.body.overrideRules ? reason : (req.body.overrideReason || '')
    };
    const patient = await client.query('SELECT * FROM patients WHERE id=$1', [old.patient_id]);
    body.patientName = body.patientName || patient.rows[0]?.full_name;
    body.patientPhone = body.patientPhone || patient.rows[0]?.phone;
    body.ppecPatientId = body.ppecPatientId || patient.rows[0]?.ppec_patient_id;
    body.patientRecordUrl = body.patientRecordUrl || patient.rows[0]?.external_record_url;
    const fresh = await makeBooking(client, req, body);
    await client.query('UPDATE bookings SET rescheduled_to=$1 WHERE id=$2', [fresh.id, old.id]);
    return { oldId: old.id, newBooking: fresh, reason };
  });
  await writeAudit(req, { action: 'booking_rescheduled', entityType: 'booking', entityId: response.oldId, reason: response.reason || null, details: { newBookingId: response.newBooking.id } });
  res.status(201).json({ booking: response.newBooking, previousBookingId: response.oldId });
}));

app.post('/api/bookings/:id/status', requireAdmin, asyncRoute(async (req, res) => {
  const status = String(req.body?.status || '');
  if (!['completed','no_show'].includes(status)) return res.status(400).json({ message: 'Status must be completed or no_show.' });
  const found = await query('SELECT id,status FROM bookings WHERE id=$1', [req.params.id]);
  if (!found.rowCount) return res.status(404).json({ message: 'Booking not found.' });
  if (found.rows[0].status !== 'confirmed') return res.status(400).json({ message: 'Only confirmed bookings can be marked completed or no-show.' });
  const updated = await query('UPDATE bookings SET status=$1,updated_by=$2,updated_at=now() WHERE id=$3 RETURNING id,booking_code,status', [status, req.currentUser.id, req.params.id]);
  await writeAudit(req, { action: `booking_${status}`, entityType: 'booking', entityId: req.params.id });
  res.json({ booking: updated.rows[0] });
}));

app.get('/api/doctors/me', asyncRoute(async (req, res) => {
  if (!req.currentUser.doctor_id) return res.status(404).json({ message: 'No surgeon profile is linked to this account.' });
  const result = await query(
    `SELECT d.*,u.full_name,u.phone,u.email,u.status AS account_status,
      (SELECT count(*) FROM bookings b WHERE b.doctor_id=d.id AND b.status='completed') AS completed_surgeries,
      COALESCE((SELECT sum(sf.eligible_surgery_fee) FROM surgery_financials sf WHERE sf.doctor_id=d.id),0) AS total_revenue,
      COALESCE((SELECT sum(sf.commission_amount+sf.adjustment_amount) FROM surgery_financials sf WHERE sf.doctor_id=d.id),0) AS commission_earned
     FROM doctors d JOIN users u ON u.id=d.user_id WHERE d.id=$1`, [req.currentUser.doctor_id]
  );
  const doc = result.rows[0];
  const fin = await query(`SELECT COALESCE(sum(sf.commission_amount+sf.adjustment_amount),0) AS earned,
      COALESCE(sum(CASE WHEN p.status='recorded' THEN pa.amount ELSE 0 END),0) AS paid
      FROM surgery_financials sf LEFT JOIN payment_allocations pa ON pa.surgery_financial_id=sf.id LEFT JOIN payments p ON p.id=pa.payment_id WHERE sf.doctor_id=$1`, [doc.id]);
  res.json({ doctor: { ...doc, completed_surgeries: Number(doc.completed_surgeries), total_revenue: Number(doc.total_revenue), commission_earned: Number(fin.rows[0].earned), amount_paid: Number(fin.rows[0].paid), outstanding_balance: Math.round((Number(fin.rows[0].earned)-Number(fin.rows[0].paid))*100)/100 } });
}));

app.get('/api/doctors', requireAdmin, asyncRoute(async (_req, res) => {
  const result = await query(
    `SELECT d.id AS doctor_id,d.doctor_code,d.doctor_type,d.medical_license_number,d.licensing_authority,d.workplace,d.commission_percentage,d.payment_method,
            u.id AS user_id,u.full_name,u.phone,u.email,u.status,u.created_at,u.password_change_required
     FROM doctors d JOIN users u ON u.id=d.user_id ORDER BY u.full_name`
  );
  res.json({ doctors: result.rows });
}));

app.post('/api/doctors', requireAdmin, asyncRoute(async (req, res) => {
  const { fullName, phone, email, doctorCode, doctorType, temporaryPassword, medicalLicenseNumber, licensingAuthority, workplace, commissionPercentage, paymentMethod } = req.body || {};
  if (!String(fullName || '').trim() || !String(phone || '').trim() || !String(doctorCode || '').trim() || !['internal','external'].includes(doctorType)) return res.status(400).json({ message: 'Full name, phone, unique Doctor ID, and doctor category are required.' });
  if (temporaryPassword !== undefined && (String(temporaryPassword).length < 1 || String(temporaryPassword).length > 100)) return res.status(400).json({ message: 'Temporary password must contain 1–100 characters.' });
  const pct = Number(commissionPercentage ?? 0);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ message: 'Commission percentage must be between 0 and 100.' });
  const temp = temporaryPassword == null || temporaryPassword === '' ? `${cryptoRandom()}a9!` : String(temporaryPassword);
  const passwordHash = await bcrypt.hash(temp, 12);
  const created = await withTransaction(async client => {
    const user = await client.query(
      `INSERT INTO users(phone,full_name,email,role,password_hash,password_change_required,status,created_by)
       VALUES($1,$2,$3,$4,$5,true,'active',$6) RETURNING id,phone,full_name,email,role,status,created_at`,
      [String(phone).trim(), String(fullName).trim(), String(email || '').trim() || null, doctorType === 'internal' ? 'internal_doctor' : 'external_doctor', passwordHash, req.currentUser.id]
    );
    const doctor = await client.query(
      `INSERT INTO doctors(user_id,doctor_code,doctor_type,medical_license_number,licensing_authority,workplace,commission_percentage,payment_method)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [user.rows[0].id, String(doctorCode).trim(), doctorType, medicalLicenseNumber || null, licensingAuthority || null, workplace || null, pct, paymentMethod || null]
    );
    return { user: user.rows[0], doctor: doctor.rows[0] };
  });
  await writeAudit(req, { action: 'doctor_created', entityType: 'doctor', entityId: created.doctor.id, details: { doctorCode: created.doctor.doctor_code, doctorType } });
  res.status(201).json({ doctor: { ...created.doctor, full_name: created.user.full_name, phone: created.user.phone, email: created.user.email }, temporaryPassword: temp, message: 'Copy the temporary password now. It is not stored in readable form and will not be shown again.' });
}));
function cryptoRandom() { return randomBytes(18).toString('base64url'); }

app.patch('/api/doctors/:id', requireAdmin, asyncRoute(async (req, res) => {
  const body = req.body || {};
  const fields = ['doctor_code','doctor_type','medical_license_number','licensing_authority','workplace','commission_percentage','payment_method'];
  const doctorResult = await query('SELECT d.*,u.full_name,u.phone,u.email,u.id AS linked_user_id FROM doctors d JOIN users u ON u.id=d.user_id WHERE d.id=$1', [req.params.id]);
  const doctor = doctorResult.rows[0];
  if (!doctor) return res.status(404).json({ message: 'Surgeon profile not found.' });
  const next = {
    doctor_code: body.doctorCode ?? doctor.doctor_code,
    doctor_type: body.doctorType ?? doctor.doctor_type,
    medical_license_number: body.medicalLicenseNumber ?? doctor.medical_license_number,
    licensing_authority: body.licensingAuthority ?? doctor.licensing_authority,
    workplace: body.workplace ?? doctor.workplace,
    commission_percentage: body.commissionPercentage ?? doctor.commission_percentage,
    payment_method: body.paymentMethod ?? doctor.payment_method,
    full_name: String(body.fullName ?? doctor.full_name).trim(),
    phone: String(body.phone ?? doctor.phone).trim(),
    email: body.email === undefined ? doctor.email : (String(body.email || '').trim() || null)
  };
  if (!['internal','external'].includes(next.doctor_type) || Number(next.commission_percentage) < 0 || Number(next.commission_percentage) > 100) return res.status(400).json({ message: 'Check doctor category and commission percentage.' });
  if (!next.full_name || next.full_name.length > 160 || !next.phone || next.phone.length > 32 || (next.email && next.email.length > 254)) return res.status(400).json({ message: 'Check the doctor name, phone number and email length.' });
  const updated = await withTransaction(async client => {
    await client.query('UPDATE users SET full_name=$1,phone=$2,email=$3,role=$4,updated_at=now() WHERE id=$5', [next.full_name,next.phone,next.email,next.doctor_type === 'internal' ? 'internal_doctor' : 'external_doctor',doctor.linked_user_id]);
    const doctorUpdate = await client.query(`UPDATE doctors SET doctor_code=$1,doctor_type=$2,medical_license_number=$3,licensing_authority=$4,workplace=$5,commission_percentage=$6,payment_method=$7,updated_at=now() WHERE id=$8 RETURNING *`, [next.doctor_code,next.doctor_type,next.medical_license_number,next.licensing_authority,next.workplace,next.commission_percentage,next.payment_method,doctor.id]);
    return doctorUpdate.rows[0];
  });
  await writeAudit(req, { action: 'doctor_profile_updated', entityType: 'doctor', entityId: doctor.id, details: { changedFields: ['fullName','phone','email','doctorCode','doctorType','medicalLicenseNumber','licensingAuthority','workplace','commissionPercentage','paymentMethod'].filter(f => body[f] !== undefined) } });
  res.json({ doctor: { ...updated, full_name: next.full_name, phone: next.phone, email: next.email } });
}));

app.post('/api/doctors/:id/reset-password', requireAdmin, asyncRoute(async (req, res) => {
  const temp = req.body?.temporaryPassword == null || req.body.temporaryPassword === '' ? `${cryptoRandom()}a9!` : String(req.body.temporaryPassword);
  if (temp.length < 1 || temp.length > 100) return res.status(400).json({ message: 'Temporary password must contain 1–100 characters.' });
  const target = await query('SELECT user_id FROM doctors WHERE id=$1', [req.params.id]);
  if (!target.rowCount) return res.status(404).json({ message: 'Surgeon profile not found.' });
  const hash = await bcrypt.hash(temp, 12);
  await query('UPDATE users SET password_hash=$1,password_change_required=true,updated_at=now() WHERE id=$2', [hash, target.rows[0].user_id]);
  await writeAudit(req, { action: 'doctor_password_reset', entityType: 'doctor', entityId: req.params.id });
  res.json({ temporaryPassword: temp, message: 'Copy this temporary password now. The doctor must change it at first login.' });
}));

app.patch('/api/users/:id/status', requireAdmin, asyncRoute(async (req, res) => {
  const status = String(req.body?.status || '');
  if (!['active','suspended','inactive'].includes(status)) return res.status(400).json({ message: 'Status must be active, suspended, or inactive.' });
  if (req.params.id === req.currentUser.id && status !== 'active') return res.status(400).json({ message: 'You cannot deactivate your own active administrator account.' });
  const result = await query('UPDATE users SET status=$1,updated_at=now() WHERE id=$2 RETURNING id,phone,full_name,status,role', [status, req.params.id]);
  if (!result.rowCount) return res.status(404).json({ message: 'User not found.' });
  await writeAudit(req, { action: 'user_status_changed', entityType: 'user', entityId: req.params.id, reason: String(req.body?.reason || '').trim() || null, details: { status } });
  res.json({ user: result.rows[0] });
}));

app.get('/api/surgery-types', requireAdmin, asyncRoute(async (_req, res) => {
  const result = await query('SELECT * FROM surgery_types ORDER BY name'); res.json({ surgeryTypes: result.rows });
}));
app.post('/api/surgery-types', requireAdmin, asyncRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim(), duration = Number(req.body?.defaultDurationMinutes);
  if (!name || name.length > 120 || !Number.isInteger(duration) || duration < 30 || duration % 30 !== 0 || duration > 360) return res.status(400).json({ message: 'Enter a surgery name and a duration in 30-minute increments (30–360 minutes).' });
  const result = await query('INSERT INTO surgery_types(name,default_duration_minutes,active) VALUES($1,$2,true) RETURNING *', [name, duration]);
  await writeAudit(req, { action: 'surgery_type_created', entityType: 'surgery_type', entityId: result.rows[0].id });
  res.status(201).json({ surgeryType: result.rows[0] });
}));
app.patch('/api/surgery-types/:id', requireAdmin, asyncRoute(async (req, res) => {
  const current = await query('SELECT * FROM surgery_types WHERE id=$1', [req.params.id]);
  if (!current.rowCount) return res.status(404).json({ message: 'Surgery type not found.' });
  const name = String(req.body?.name ?? current.rows[0].name).trim();
  const duration = Number(req.body?.defaultDurationMinutes ?? current.rows[0].default_duration_minutes);
  const active = req.body?.active === undefined ? current.rows[0].active : Boolean(req.body.active);
  if (!name || !Number.isInteger(duration) || duration < 30 || duration % 30 !== 0 || duration > 360) return res.status(400).json({ message: 'Enter a name and duration in 30-minute increments.' });
  const result = await query('UPDATE surgery_types SET name=$1,default_duration_minutes=$2,active=$3,updated_at=now() WHERE id=$4 RETURNING *', [name,duration,active,req.params.id]);
  await writeAudit(req, { action: 'surgery_type_updated', entityType: 'surgery_type', entityId: req.params.id, details: { name,duration,active } });
  res.json({ surgeryType: result.rows[0] });
}));

app.get('/api/operating-hours', requireAdmin, asyncRoute(async (_req, res) => {
  const result = await query('SELECT * FROM operating_hours ORDER BY weekday,start_time'); res.json({ operatingHours: result.rows });
}));
app.put('/api/operating-hours', requireAdmin, asyncRoute(async (req, res) => {
  const entries = req.body?.operatingHours;
  if (!Array.isArray(entries) || entries.length > 14) return res.status(400).json({ message: 'Provide the operating hours array (up to 14 sessions).' });
  const result = await withTransaction(async client => {
    await client.query('UPDATE operating_hours SET active=false');
    for (const row of entries) {
      const weekday = Number(row.weekday), name = String(row.sessionName || '');
      if (!Number.isInteger(weekday) || weekday < 1 || weekday > 6 || !['morning','afternoon'].includes(name) || !/^\d{2}:\d{2}$/.test(row.startTime) || !/^\d{2}:\d{2}$/.test(row.endTime) || minutesOf(row.endTime) <= minutesOf(row.startTime)) throw Object.assign(new Error('Invalid working day or session time.'), { status: 400 });
      await client.query(`INSERT INTO operating_hours(weekday,session_name,start_time,end_time,active) VALUES($1,$2,$3,$4,true) ON CONFLICT(weekday,session_name) DO UPDATE SET start_time=EXCLUDED.start_time,end_time=EXCLUDED.end_time,active=true`, [weekday,name,row.startTime,row.endTime]);
    }
    return client.query('SELECT * FROM operating_hours ORDER BY weekday,start_time');
  });
  await writeAudit(req, { action: 'operating_hours_updated', entityType: 'operating_hours', details: { sessionCount: entries.length } });
  res.json({ operatingHours: result.rows });
}));

app.post('/api/blocked-periods', requireAdmin, asyncRoute(async (req, res) => {
  const title = String(req.body?.title || '').trim();
  const start = new Date(req.body?.startsAt), end = new Date(req.body?.endsAt);
  if (!title || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return res.status(400).json({ message: 'Enter a title and a valid start/end time.' });
  const result = await query(`INSERT INTO blocked_periods(title,starts_at,ends_at,operating_room_id,reason,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [title,start.toISOString(),end.toISOString(),req.body?.operatingRoomId || null,String(req.body?.reason || '').trim() || null,req.currentUser.id]);
  await writeAudit(req, { action: 'blocked_period_created', entityType: 'blocked_period', entityId: result.rows[0].id, reason: req.body?.reason || null });
  res.status(201).json({ blockedPeriod: result.rows[0] });
}));

app.get('/api/blocked-periods', requireAdmin, asyncRoute(async (req, res) => {
  const result = await query(`SELECT bp.*,r.display_name AS bed_name FROM blocked_periods bp LEFT JOIN operating_rooms r ON r.id=bp.operating_room_id WHERE bp.active=true ORDER BY bp.starts_at DESC LIMIT 500`);
  res.json({ blockedPeriods: result.rows });
}));
app.delete('/api/blocked-periods/:id', requireAdmin, asyncRoute(async (req, res) => {
  const result = await query(`UPDATE blocked_periods SET active=false WHERE id=$1 AND active=true RETURNING id,title`, [req.params.id]);
  if (!result.rowCount) return res.status(404).json({ message: 'Active blocked period not found.' });
  await writeAudit(req, { action: 'blocked_period_deactivated', entityType: 'blocked_period', entityId: req.params.id, details: { title: result.rows[0].title } });
  res.json({ ok: true });
}));

app.post('/api/bookings/:id/financials', requireAdmin, asyncRoute(async (req, res) => {
  const booking = await query(`SELECT b.*,d.commission_percentage,st.name AS surgery_name,p.ppec_patient_id
    FROM bookings b JOIN doctors d ON d.id=b.doctor_id JOIN surgery_types st ON st.id=b.surgery_type_id JOIN patients p ON p.id=b.patient_id WHERE b.id=$1`, [req.params.id]);
  const b = booking.rows[0];
  if (!b) return res.status(404).json({ message: 'Booking not found.' });
  if (b.status !== 'completed') return res.status(400).json({ message: 'Only completed surgeries can be added to surgeon payments.' });
  const fee = Number(req.body?.eligibleSurgeryFee);
  const pct = req.body?.commissionPercentageSnapshot === undefined ? Number(b.commission_percentage) : Number(req.body.commissionPercentageSnapshot);
  if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(pct) || pct < 0 || pct > 100) return res.status(400).json({ message: 'Enter a valid eligible surgery fee and commission rate.' });
  const comm = calculateCommission(fee, pct);
  const result = await query(
    `INSERT INTO surgery_financials(booking_id,doctor_id,patient_reference,surgery_type_name,completed_on,eligible_surgery_fee,commission_percentage_snapshot,commission_amount,notes,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [b.id,b.doctor_id,b.ppec_patient_id || null,b.surgery_name,new Date(new Date(b.start_at).getTime()+7*3600000).toISOString().slice(0,10),fee,pct,comm,String(req.body?.notes || '').trim() || null,req.currentUser.id]
  );
  await writeAudit(req, { action: 'surgery_financial_recorded', entityType: 'surgery_financial', entityId: result.rows[0].id, details: { bookingId: b.id, fee, commissionPercentage: pct, commission: comm } });
  res.status(201).json({ financial: result.rows[0] });
}));

app.post('/api/surgery-financials/:id/adjust', requireAdmin, asyncRoute(async (req, res) => {
  const amount = Number(req.body?.adjustmentAmount);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isFinite(amount) || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001 || !reason || reason.length < 5) return res.status(400).json({ message: 'Enter an adjustment amount (maximum two decimal places) and a reason of at least 5 characters.' });
  const updated = await withTransaction(async client => {
    const found = await client.query(`SELECT sf.*,COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.surgery_financial_id=sf.id AND p.status='recorded'),0) AS paid
      FROM surgery_financials sf WHERE sf.id=$1 FOR UPDATE`, [req.params.id]);
    if (!found.rowCount) throw Object.assign(new Error('Surgery financial record not found.'), { status: 404 });
    const nextAmount = Number(found.rows[0].commission_amount) + Number(found.rows[0].adjustment_amount) + amount;
    if (nextAmount < Number(found.rows[0].paid) - 0.00001) throw Object.assign(new Error('Adjustment would reduce the commission below payments already recorded. Reverse or reconcile the payment first.'), { status: 400 });
    const result = await client.query(
      'UPDATE surgery_financials SET adjustment_amount=adjustment_amount+$1,notes=concat_ws(chr(10),notes,$2),updated_at=now() WHERE id=$3 RETURNING *',
      [amount, `Adjustment ${amount >= 0 ? '+' : ''}${amount.toFixed(2)}: ${reason}`, req.params.id]
    );
    return result.rows[0];
  });
  await writeAudit(req, { action: 'surgery_financial_adjusted', entityType: 'surgery_financial', entityId: req.params.id, reason, details: { adjustmentAmount: amount } });
  res.json({ financial: updated });
}));

app.get('/api/surgeon-payments', asyncRoute(async (req, res) => {
  const doctorId = isAdmin(req) ? (req.query.doctorId || null) : req.currentUser.doctor_id;
  if (!doctorId && !isAdmin(req)) return res.json({ items: [], summary: {} });
  const params = [];
  let where = '1=1';
  if (doctorId) { params.push(doctorId); where += ` AND sf.doctor_id=$${params.length}`; }
  if (req.query.from) { params.push(req.query.from); where += ` AND sf.completed_on >= $${params.length}`; }
  if (req.query.to) { params.push(req.query.to); where += ` AND sf.completed_on <= $${params.length}`; }
  if (req.query.surgeryType) { params.push(req.query.surgeryType); where += ` AND sf.surgery_type_name=$${params.length}`; }
  if (req.query.status) {
    const status = String(req.query.status);
    if (['Pending','Partially paid','Paid'].includes(status)) {
      params.push(status);
      where += ` AND (CASE WHEN coalesce(paid.total_paid,0)<=0 THEN 'Pending' WHEN coalesce(paid.total_paid,0)+0.00001 < sf.commission_amount+sf.adjustment_amount THEN 'Partially paid' ELSE 'Paid' END)=$${params.length}`;
    }
  }
  if (req.query.unpaid === 'true') where += ' AND coalesce(paid.total_paid,0)+0.00001 < sf.commission_amount+sf.adjustment_amount';
  const result = await query(
    `SELECT sf.id,sf.booking_id,b.booking_code,sf.doctor_id,d.doctor_code,u.full_name AS doctor_name,
      sf.patient_reference,sf.surgery_type_name,sf.completed_on,sf.eligible_surgery_fee,sf.commission_percentage_snapshot,
      sf.commission_amount,sf.adjustment_amount,coalesce(paid.total_paid,0) AS total_paid,
      (sf.commission_amount+sf.adjustment_amount-coalesce(paid.total_paid,0)) AS outstanding,
      CASE WHEN coalesce(paid.total_paid,0)<=0 THEN 'Pending' WHEN coalesce(paid.total_paid,0)+0.00001 < sf.commission_amount+sf.adjustment_amount THEN 'Partially paid' ELSE 'Paid' END AS payment_status,
      paid.last_payment_date
     FROM surgery_financials sf JOIN doctors d ON d.id=sf.doctor_id JOIN users u ON u.id=d.user_id JOIN bookings b ON b.id=sf.booking_id
     LEFT JOIN (SELECT pa.surgery_financial_id,SUM(pa.amount) AS total_paid,MAX(p.paid_on) FILTER(WHERE p.status='recorded') AS last_payment_date
                FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='recorded' GROUP BY pa.surgery_financial_id) paid ON paid.surgery_financial_id=sf.id
     WHERE ${where} ORDER BY sf.completed_on DESC,sf.created_at DESC LIMIT 2000`, params
  );
  let items = result.rows;
  if (req.query.paymentFrom || req.query.paymentTo) {
    const filtered = await query(`SELECT DISTINCT pa.surgery_financial_id FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id
      WHERE p.status='recorded' ${req.query.paymentFrom ? 'AND p.paid_on >= $1' : ''} ${req.query.paymentTo ? `AND p.paid_on <= $${req.query.paymentFrom ? 2 : 1}` : ''}`,
      [req.query.paymentFrom, req.query.paymentTo].filter(Boolean));
    const ids = new Set(filtered.rows.map(r => r.surgery_financial_id)); items = items.filter(x => ids.has(x.id));
  }
  if (!isAdmin(req)) items = items.map(x => ({ ...x, doctor_name: undefined, doctor_code: undefined, patient_reference: undefined }));
  const summary = items.reduce((acc, x) => {
    acc.completedSurgeries += 1; acc.eligibleRevenue += Number(x.eligible_surgery_fee); acc.commissionEarned += Number(x.commission_amount) + Number(x.adjustment_amount); acc.totalPaid += Number(x.total_paid); acc.outstanding += Number(x.outstanding); return acc;
  }, { completedSurgeries: 0, eligibleRevenue: 0, commissionEarned: 0, totalPaid: 0, outstanding: 0 });
  res.json({ items, summary });
}));

app.post('/api/payments', requireAdmin, asyncRoute(async (req, res) => {
  const doctorId = String(req.body?.doctorId || '');
  const method = String(req.body?.paymentMethod || '').trim();
  const paidOn = String(req.body?.paidOn || '');
  const allocations = req.body?.allocations;
  if (!doctorId || !method || method.length > 40 || !/^\d{4}-\d{2}-\d{2}$/.test(paidOn) || !Array.isArray(allocations) || !allocations.length || allocations.length > 500) return res.status(400).json({ message: 'Choose a surgeon, payment date, method, and at least one allocation.' });
  const result = await withTransaction(async client => {
    const unique = new Set();
    let total = 0;
    const toAllocate = [];
    for (const item of allocations) {
      const financialId = String(item.financialId || ''); const amount = Number(item.amount);
      if (!financialId || unique.has(financialId) || !Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) throw Object.assign(new Error('Each payment allocation must reference a unique surgery and a positive amount with at most two decimal places.'), { status: 400 });
      unique.add(financialId);
      const current = await client.query(`SELECT sf.*,COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE pa.surgery_financial_id=sf.id AND p.status='recorded'),0) AS paid_so_far
        FROM surgery_financials sf WHERE sf.id=$1 AND sf.doctor_id=$2 FOR UPDATE`, [financialId,doctorId]);
      if (!current.rowCount) throw Object.assign(new Error('A selected surgery payment record does not belong to this surgeon.'), { status: 400 });
      const row = current.rows[0];
      const outstanding = Math.round((Number(row.commission_amount)+Number(row.adjustment_amount)-Number(row.paid_so_far))*100)/100;
      if (amount - outstanding > 0.00001) throw Object.assign(new Error(`Payment allocation exceeds the outstanding balance for ${row.booking_id}.`), { status: 400 });
      toAllocate.push({ financialId, amount }); total += amount;
    }
    total = Math.round(total*100)/100;
    const paymentCode = `PAY-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
    const payment = await client.query(`INSERT INTO payments(payment_code,doctor_id,amount,payment_method,paid_on,payment_reference,notes,recorded_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [paymentCode,doctorId,total,method,paidOn,String(req.body?.paymentReference || '').trim() || null,String(req.body?.notes || '').trim() || null,req.currentUser.id]);
    for (const item of toAllocate) await client.query('INSERT INTO payment_allocations(payment_id,surgery_financial_id,amount) VALUES($1,$2,$3)', [payment.rows[0].id,item.financialId,item.amount]);
    return { payment: payment.rows[0], allocations: toAllocate };
  });
  await writeAudit(req, { action: 'surgeon_payment_recorded', entityType: 'payment', entityId: result.payment.id, details: { paymentCode: result.payment.payment_code, amount: result.payment.amount, allocationCount: result.allocations.length } });
  res.status(201).json(result);
}));

app.post('/api/payments/:id/reverse', requireAdmin, asyncRoute(async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 5) return res.status(400).json({ message: 'Record a reversal reason of at least 5 characters.' });
  const updated = await query(`UPDATE payments SET status='reversed',reversed_reason=$1 WHERE id=$2 AND status='recorded' RETURNING *`, [reason,req.params.id]);
  if (!updated.rowCount) return res.status(404).json({ message: 'Recorded payment not found or already reversed.' });
  await writeAudit(req, { action: 'surgeon_payment_reversed', entityType: 'payment', entityId: req.params.id, reason, details: { paymentCode: updated.rows[0].payment_code, amount: updated.rows[0].amount } });
  res.json({ payment: updated.rows[0] });
}));

app.get('/api/payments/history', asyncRoute(async (req, res) => {
  const params = []; let where = '1=1';
  if (!isAdmin(req)) { params.push(req.currentUser.doctor_id || '00000000-0000-0000-0000-000000000000'); where += ` AND p.doctor_id=$${params.length}`; }
  else if (req.query.doctorId) { params.push(req.query.doctorId); where += ` AND p.doctor_id=$${params.length}`; }
  if (req.query.from) { params.push(req.query.from); where += ` AND p.paid_on >= $${params.length}`; }
  if (req.query.to) { params.push(req.query.to); where += ` AND p.paid_on <= $${params.length}`; }
  const result = await query(`SELECT p.*,u.full_name AS doctor_name,d.doctor_code,
    COALESCE(json_agg(json_build_object('financialId',sf.id,'bookingCode',b.booking_code,'amount',pa.amount) ORDER BY b.start_at) FILTER(WHERE sf.id IS NOT NULL),'[]'::json) AS allocations
    FROM payments p JOIN doctors d ON d.id=p.doctor_id JOIN users u ON u.id=d.user_id
    LEFT JOIN payment_allocations pa ON pa.payment_id=p.id LEFT JOIN surgery_financials sf ON sf.id=pa.surgery_financial_id LEFT JOIN bookings b ON b.id=sf.booking_id
    WHERE ${where} GROUP BY p.id,u.full_name,d.doctor_code ORDER BY p.paid_on DESC,p.created_at DESC LIMIT 2000`, params);
  res.json({ payments: result.rows.map(p => !isAdmin(req) ? { ...p, doctor_name: undefined, doctor_code: undefined } : p) });
}));

app.get('/api/dashboard', asyncRoute(async (req, res) => {
  const date = String(req.query.date || new Date().toLocaleDateString('en-CA', { timeZone: TIME_ZONE }));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ message: 'Date must be YYYY-MM-DD.' });
  if (!isAdmin(req)) {
    const [upcoming, completed, financial] = await Promise.all([
      query(`SELECT b.id,b.booking_code,b.start_at,b.end_at,b.status,r.code AS bed_code,st.name AS surgery_type,p.full_name AS patient_name,p.phone AS patient_phone
        FROM bookings b JOIN operating_rooms r ON r.id=b.operating_room_id JOIN surgery_types st ON st.id=b.surgery_type_id JOIN patients p ON p.id=b.patient_id
        WHERE b.doctor_id=$1 AND b.status='confirmed' AND b.start_at>=now() ORDER BY b.start_at LIMIT 10`, [req.currentUser.doctor_id]),
      query(`SELECT count(*)::int AS count FROM bookings WHERE doctor_id=$1 AND status='completed'`, [req.currentUser.doctor_id]),
      query(`SELECT COALESCE(sum(sf.commission_amount+sf.adjustment_amount),0) AS earned,
        COALESCE(sum(CASE WHEN p.status='recorded' THEN pa.amount ELSE 0 END),0) AS paid
        FROM surgery_financials sf LEFT JOIN payment_allocations pa ON pa.surgery_financial_id=sf.id LEFT JOIN payments p ON p.id=pa.payment_id WHERE sf.doctor_id=$1`, [req.currentUser.doctor_id])
    ]);
    return res.json({ doctor: true, upcoming: upcoming.rows, completedCount: Number(completed.rows[0].count), commissionEarned: Number(financial.rows[0].earned), amountPaid: Number(financial.rows[0].paid), outstanding: Number(financial.rows[0].earned)-Number(financial.rows[0].paid) });
  }

 const dayStart = `${date}T00:00:00+07:00`, dayEnd = `${date}T23:59:59.999+07:00`;
  const [counts, usage, upcoming, types, finances, trends] = await Promise.all([
    query(`SELECT count(*) FILTER(WHERE status='confirmed')::int AS confirmed_today,
      count(*) FILTER(WHERE status='cancelled')::int AS cancelled_today,
      count(*) FILTER(WHERE status='completed')::int AS completed_today,
      count(*) FILTER(WHERE status='no_show')::int AS no_show_today
      FROM bookings WHERE start_at BETWEEN $1 AND $2`, [dayStart, dayEnd]),
    query(`SELECT r.code AS bed_code,COALESCE(sum(extract(epoch FROM (least(b.end_at,$2::timestamptz)-greatest(b.start_at,$1::timestamptz)))/3600) FILTER(WHERE b.status NOT IN ('cancelled','rescheduled')),0)::numeric(8,2) AS hours
      FROM operating_rooms r LEFT JOIN bookings b ON b.operating_room_id=r.id AND b.start_at<$2 AND b.end_at>$1 WHERE r.active=true GROUP BY r.code ORDER BY r.code`, [dayStart, dayEnd]),
    query(`SELECT b.id,b.booking_code,b.start_at,b.end_at,b.status,r.code AS bed_code,r.display_name AS bed_name,st.name AS surgery_type,
      p.full_name AS patient_name,p.phone AS patient_phone,u.full_name AS doctor_name,d.doctor_code
      FROM bookings b JOIN operating_rooms r ON r.id=b.operating_room_id JOIN surgery_types st ON st.id=b.surgery_type_id JOIN patients p ON p.id=b.patient_id
      JOIN doctors d ON d.id=b.doctor_id JOIN users u ON u.id=d.user_id WHERE b.start_at >= $1 AND b.start_at <= $2 AND b.status='confirmed' ORDER BY b.start_at LIMIT 12`, [dayStart, dayEnd]),
    query(`SELECT st.name,count(*)::int AS count FROM bookings b JOIN surgery_types st ON st.id=b.surgery_type_id WHERE b.status='completed' AND b.start_at >= date_trunc('month',$1::timestamptz) AND b.start_at < date_trunc('month',$1::timestamptz)+interval '1 month' GROUP BY st.name ORDER BY count DESC`, [dayStart]),
    query(`SELECT COALESCE(sum(sf.eligible_surgery_fee),0) AS revenue,COALESCE(sum(sf.commission_amount+sf.adjustment_amount),0) AS commission,
      COALESCE((SELECT sum(p.amount) FROM payments p WHERE p.status='recorded' AND p.paid_on <= $1),0) AS paid
      FROM surgery_financials sf JOIN bookings b ON b.id=sf.booking_id WHERE sf.completed_on <= $1`, [date]),
    query(`SELECT to_char(date_trunc('month',completed_on),'Mon YYYY') AS month,COALESCE(sum(eligible_surgery_fee),0) AS revenue,
      COALESCE(sum(commission_amount+adjustment_amount),0) AS commission FROM surgery_financials WHERE completed_on >= current_date - interval '5 months' GROUP BY date_trunc('month',completed_on) ORDER BY date_trunc('month',completed_on)`)
  ]);


  const bookedHours = usage.rows.reduce((sum, x) => sum + Number(x.hours), 0);
  const bedCount = usage.rows.length || 2;
  const capacity = bedCount * 6;
  res.json({ date, timeZone: TIME_ZONE, counts: counts.rows[0], usage: usage.rows, bookedHours,
    capacityHours: capacity, remainingHours: Math.max(0, capacity-bookedHours), utilizationPct: capacity ? Math.round(bookedHours/capacity*100) : 0,
    upcoming: upcoming.rows, surgeryTypes: types.rows, finances: finances.rows[0], trends: trends.rows });
}));

app.get('/api/reports/:type.csv', requireAdmin, asyncRoute(async (req, res) => {
  const type = String(req.params.type);
  if (type === 'payments') {
    const result = await query(`SELECT p.payment_code,u.full_name AS doctor_name,d.doctor_code,p.amount,p.payment_method,p.paid_on,p.payment_reference,p.status,p.reversed_reason,p.notes
      FROM payments p JOIN doctors d ON d.id=p.doctor_id JOIN users u ON u.id=d.user_id ORDER BY p.paid_on DESC`);
    return csvResponse(res,'ppec-surgeon-payments.csv',[{key:'payment_code',label:'Payment ID'},{key:'doctor_name',label:'Surgeon'},{key:'doctor_code',label:'Doctor ID'},{key:'amount',label:'Amount USD'},{key:'payment_method',label:'Method'},{key:'paid_on',label:'Paid on'},{key:'payment_reference',label:'Reference'},{key:'status',label:'Status'},{key:'reversed_reason',label:'Reversal reason'},{key:'notes',label:'Notes'}],result.rows);
  }
  if (type === 'bookings') {
    const result = await query(`SELECT b.booking_code,b.start_at,b.end_at,b.status,r.display_name AS bed,u.full_name AS doctor_name,d.doctor_code,st.name AS surgery_type,p.ppec_patient_id,p.full_name AS patient_name,p.phone AS patient_phone,b.notes
      FROM bookings b JOIN operating_rooms r ON r.id=b.operating_room_id JOIN doctors d ON d.id=b.doctor_id JOIN users u ON u.id=d.user_id JOIN surgery_types st ON st.id=b.surgery_type_id JOIN patients p ON p.id=b.patient_id ORDER BY b.start_at DESC`);
    return csvResponse(res,'ppec-bookings.csv',[{key:'booking_code',label:'Booking ID'},{key:'start_at',label:'Start'},{key:'end_at',label:'End'},{key:'status',label:'Status'},{key:'bed',label:'Operating room'},{key:'doctor_name',label:'Surgeon'},{key:'doctor_code',label:'Doctor ID'},{key:'surgery_type',label:'Surgery type'},{key:'ppec_patient_id',label:'Patient ID'},{key:'patient_name',label:'Patient name'},{key:'patient_phone',label:'Patient phone'},{key:'notes',label:'Notes'}],result.rows);
  }
  if (type === 'surgeons') {
    const result = await query(`SELECT d.doctor_code,u.full_name,u.phone,u.email,d.doctor_type,d.medical_license_number,d.licensing_authority,d.workplace,d.commission_percentage,d.payment_method,u.status FROM doctors d JOIN users u ON u.id=d.user_id ORDER BY u.full_name`);
    return csvResponse(res,'ppec-surgeons.csv',[{key:'doctor_code',label:'Doctor ID'},{key:'full_name',label:'Name'},{key:'phone',label:'Phone'},{key:'email',label:'Email'},{key:'doctor_type',label:'Type'},{key:'medical_license_number',label:'License number'},{key:'licensing_authority',label:'Licensing authority'},{key:'workplace',label:'Workplace'},{key:'commission_percentage',label:'Commission %'},{key:'payment_method',label:'Payment method'},{key:'status',label:'Account status'}],result.rows);
  }
  return res.status(404).json({ message: 'Supported export types are bookings, payments, and surgeons.' });
}));

app.get('/api/audit-logs', requireAdmin, asyncRoute(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
  const result = await query(`SELECT a.*,u.full_name AS actor_name,u.phone AS actor_phone FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ORDER BY a.created_at DESC LIMIT $1`, [limit]);
  res.json({ auditLogs: result.rows });
}));

app.get('/api/reports/summary', requireAdmin, asyncRoute(async (req, res) => {
  const from = req.query.from || '2000-01-01'; const to = req.query.to || new Date().toLocaleDateString('en-CA',{timeZone:TIME_ZONE});
  const [byDoctor, byType, totals] = await Promise.all([
    query(`SELECT d.doctor_code,u.full_name,count(b.id) FILTER(WHERE b.status='completed')::int AS completed,
      COALESCE(sum(sf.eligible_surgery_fee),0) AS revenue,COALESCE(sum(sf.commission_amount+sf.adjustment_amount),0) AS commission
      FROM doctors d JOIN users u ON u.id=d.user_id LEFT JOIN bookings b ON b.doctor_id=d.id AND b.start_at >= $1::date AND b.start_at < ($2::date+1)
      LEFT JOIN surgery_financials sf ON sf.booking_id=b.id GROUP BY d.id,u.full_name,d.doctor_code ORDER BY completed DESC`, [from,to]),
    query(`SELECT st.name,count(*) FILTER(WHERE b.status='completed')::int AS completed,
      COALESCE(sum(sf.eligible_surgery_fee),0) AS revenue FROM surgery_types st LEFT JOIN bookings b ON b.surgery_type_id=st.id AND b.start_at >= $1::date AND b.start_at < ($2::date+1)
      LEFT JOIN surgery_financials sf ON sf.booking_id=b.id GROUP BY st.id ORDER BY completed DESC`, [from,to]),
    query(`SELECT count(*) FILTER(WHERE status='completed')::int AS completed,count(*) FILTER(WHERE status='cancelled')::int AS cancelled,
      count(*) FILTER(WHERE status='no_show')::int AS no_show FROM bookings WHERE start_at >= $1::date AND start_at < ($2::date+1)`,[from,to])
  ]);
  res.json({ from,to,byDoctor:byDoctor.rows,byType:byType.rows,totals:totals.rows[0] });
}));

// app.use('/api', (err, _req, res, _next) => {
//   console.error(err);
//   if (err.code === '23P01' || err.code === '23505') return res.status(409).json({ error: 'CONFLICT', message: 'This request conflicts with existing data. Refresh and try again.' });
//   if (err.code === '23503') return res.status(400).json({ message: 'The selected record is not valid.' });
//   const status = Number(err.status) || 500;
//   res.status(status).json({ error: err.code || 'SERVER_ERROR', message: status >= 500 ? 'An unexpected server error occurred. Contact the administrator if it continues.' : err.message });
// });

// app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
// app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// const server = app.listen(PORT, () => console.log(`PPEC Operating Room Platform listening on port ${PORT}`));
// async function shutdown(signal) {
//   console.log(`${signal} received. Shutting down gracefully.`);
//   server.close(async () => { await pool.end(); process.exit(0); });
//   setTimeout(() => process.exit(1), 10000).unref();
// }
// process.on('SIGTERM', () => shutdown('SIGTERM'));
// process.on('SIGINT', () => shutdown('SIGINT'));
app.use('/api', (err, _req, res, _next) => {
  console.error(err);
  if (err.code === '23P01' || err.code === '23505') return res.status(409).json({ error: 'CONFLICT', message: 'This request conflicts with existing data. Refresh and try again.' });
  if (err.code === '23503') return res.status(400).json({ message: 'The selected record is not valid.' });
  const status = Number(err.status) || 500;
  res.status(status).json({ error: err.code || 'SERVER_ERROR', message: status >= 500 ? 'An unexpected server error occurred. Contact the administrator if it continues.' : err.message });
});

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

export { app };

if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => console.log(`PPEC Operating Room Platform listening on port ${PORT}`));
  async function shutdown(signal) {
    console.log(`${signal} received. Shutting down gracefully.`);
    server.close(async () => { await pool.end(); process.exit(0); });
    setTimeout(() => process.exit(1), 10000).unref();
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
