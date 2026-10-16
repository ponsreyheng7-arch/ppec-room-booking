export const TIME_ZONE = 'Asia/Phnom_Penh';
export const CAMBODIA_OFFSET = '+07:00';

export function localDateTimeToDate(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error('Date must be YYYY-MM-DD and time must be HH:mm.');
  }
  const [hour, minute] = time.split(':').map(Number);
  if (hour > 23 || minute > 59) throw new Error('Invalid date or time.');
  const value = new Date(`${date}T${time}:00${CAMBODIA_OFFSET}`);
  if (Number.isNaN(value.getTime())) throw new Error('Invalid date or time.')
  // Reject impossible dates that JavaScript might normalize, such as February 31.
  if (value.toLocaleDateString('en-CA', { timeZone: TIME_ZONE }) !== date) {
    throw new Error('Invalid calendar date.');
  }
  return value;
}

export function minutesBetween(start, end) {
  return Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60000);
}

export function overlaps(startA, endA, startB, endB) {
  const a0 = new Date(startA).getTime();
  const a1 = new Date(endA).getTime();
  const b0 = new Date(startB).getTime();
  const b1 = new Date(endB).getTime();
  return a0 < b1 && b0 < a1;
}

export function fitsInSession(start, end, sessionStart, sessionEnd) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  return startMs >= new Date(sessionStart).getTime() && endMs <= new Date(sessionEnd).getTime() && endMs > startMs;
}

export function validateBookingWindow({ start, end, now = new Date(), hoursAdvance = 48 }) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
    return { ok: false, code: 'INVALID_TIME', message: 'End time must be after start time.' };
  }
  if ((startDate.getTime() - new Date(now).getTime()) < hoursAdvance * 60 * 60 * 1000) {
    return { ok: false, code: 'ADVANCE_NOTICE', message: `Bookings must be made at least ${hoursAdvance} hours in advance.` };
  }
  return { ok: true };
}

export function validateCancellationWindow({ start, now = new Date(), hoursBefore = 24 }) {
  const hoursLeft = (new Date(start).getTime() - new Date(now).getTime()) / 3600000;
  if (hoursLeft < hoursBefore) {
    return { ok: false, code: 'CANCELLATION_DEADLINE', message: `Bookings can only be cancelled at least ${hoursBefore} hours before the scheduled start time.` };
  }
  return { ok: true };
}

export function calculateCommission(fee, percentage) {
  const f = Number(fee);
  const p = Number(percentage);
  if (!Number.isFinite(f) || f < 0) throw new Error('Fee must be a non-negative number.');
  if (!Number.isFinite(p) || p < 0 || p > 100) throw new Error('Commission percentage must be between 0 and 100.');
  return Math.round((f * (p / 100) + Number.EPSILON) * 100) / 100;
}

export function paymentStatus(commission, paid) {
  const owed = Math.round((Number(commission) || 0) * 100) / 100;
  const sent = Math.round((Number(paid) || 0) * 100) / 100;
  if (sent <= 0) return 'Pending';
  if (sent + 0.00001 < owed) return 'Partially paid';
  return 'Paid';
}

export function csvEscape(value) {
  let text = value == null ? '' : String(value);
  // Prevent spreadsheet formula injection from untrusted text.
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
