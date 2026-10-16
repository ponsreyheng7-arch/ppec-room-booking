import test from 'node:test';
import assert from 'node:assert/strict';
import {
  localDateTimeToDate, minutesBetween, overlaps, fitsInSession,
  validateBookingWindow, validateCancellationWindow, calculateCommission,
  paymentStatus, csvEscape
} from '../src/domain.js';

test('Cambodia-local date-time is converted using UTC+07:00', () => {
  const actual = localDateTimeToDate('2026-10-20', '08:00');
  assert.equal(actual.toISOString(), '2026-10-20T01:00:00.000Z');
});

test('invalid calendar dates are rejected', () => {
  assert.throws(() => localDateTimeToDate('2026-02-31', '08:00'));
  assert.throws(() => localDateTimeToDate('2026-10-20', '25:00'));
  assert.throws(() => localDateTimeToDate('2026-10-20', '08:60'));
});

test('minute differences are rounded to a whole minute', () => {
  assert.equal(minutesBetween('2026-10-20T01:00:00Z', '2026-10-20T02:00:00Z'), 60);
});

test('booking overlaps use half-open intervals so adjacent cases are permitted', () => {
  assert.equal(overlaps('2026-10-20T01:00:00Z', '2026-10-20T02:00:00Z', '2026-10-20T02:00:00Z', '2026-10-20T03:00:00Z'), false);
  assert.equal(overlaps('2026-10-20T01:00:00Z', '2026-10-20T02:00:00Z', '2026-10-20T01:30:00Z', '2026-10-20T02:30:00Z'), true);
});

test('surgery duration must fit fully inside the permitted session', () => {
  assert.equal(fitsInSession('2026-10-20T08:00:00Z', '2026-10-20T10:00:00Z', '2026-10-20T08:00:00Z', '2026-10-20T11:00:00Z'), true);
  assert.equal(fitsInSession('2026-10-20T10:30:00Z', '2026-10-20T11:30:00Z', '2026-10-20T08:00:00Z', '2026-10-20T11:00:00Z'), false);
});

test('48-hour booking rule permits exactly 48 hours and rejects less', () => {
  const now = new Date('2026-10-15T00:00:00.000Z');
  assert.equal(validateBookingWindow({ start: '2026-10-17T00:00:00.000Z', end: '2026-10-17T01:00:00.000Z', now }).ok, true);
  const tooSoon = validateBookingWindow({ start: '2026-10-16T23:59:00.000Z', end: '2026-10-17T00:59:00.000Z', now });
  assert.equal(tooSoon.ok, false);
  assert.equal(tooSoon.code, 'ADVANCE_NOTICE');
});

test('24-hour cancellation rule permits exactly 24 hours and rejects less', () => {
  const now = new Date('2026-10-15T00:00:00.000Z');
  assert.equal(validateCancellationWindow({ start: '2026-10-16T00:00:00.000Z', now }).ok, true);
  const tooLate = validateCancellationWindow({ start: '2026-10-15T23:59:00.000Z', now });
  assert.equal(tooLate.ok, false);
  assert.equal(tooLate.code, 'CANCELLATION_DEADLINE');
});

test('commission uses percentage points and rounds to cents', () => {
  assert.equal(calculateCommission(1000, 20), 200);
  assert.equal(calculateCommission(99.99, 12.5), 12.5);
  assert.throws(() => calculateCommission(-1, 20));
  assert.throws(() => calculateCommission(100, 101));
});

test('payment status distinguishes pending, partial and fully paid', () => {
  assert.equal(paymentStatus(100, 0), 'Pending');
  assert.equal(paymentStatus(100, 30), 'Partially paid');
  assert.equal(paymentStatus(100, 100), 'Paid');
});

test('CSV escaping quotes fields and neutralizes formula injection', () => {
  assert.equal(csvEscape('Dr. "Y"'), '"Dr. ""Y"""');
  assert.equal(csvEscape('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvEscape(null), '""');
});
