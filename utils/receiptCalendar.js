/**
 * Calendar day keys in an IANA timezone (matches frontend Intl usage).
 */

const MONTH_NAMES = [
  'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
];

function sanitizeTimeZone(raw) {
  const s = String(raw || '').trim();
  if (!s || s.length > 80) return 'UTC';
  if (!/^[A-Za-z0-9_/+\-]+$/.test(s)) return 'UTC';
  return s;
}

function dayKeyFromInstant(dateValue, timeZone) {
  if (!dateValue) return null;
  const z = sanitizeTimeZone(timeZone);
  try {
    return new Date(dateValue).toLocaleDateString('en-CA', { timeZone: z });
  } catch {
    return new Date(dateValue).toISOString().slice(0, 10);
  }
}

/** Sunday = 0 … Saturday = 6 for the first calendar day of month in `timeZone`. */
function startWeekdaySundayFirst(year, month, timeZone) {
  const z = sanitizeTimeZone(timeZone);
  const inst = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0, 0));
  try {
    const wd = inst.toLocaleDateString('en-US', { timeZone: z, weekday: 'short' });
    const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const n = map[wd];
    return typeof n === 'number' ? n : inst.getUTCDay();
  } catch {
    return inst.getUTCDay();
  }
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthTitleUpper(year, month) {
  const m = Math.min(12, Math.max(1, month));
  return MONTH_NAMES[m - 1];
}

module.exports = {
  sanitizeTimeZone,
  dayKeyFromInstant,
  startWeekdaySundayFirst,
  daysInMonth,
  monthTitleUpper,
  MONTH_NAMES,
};
