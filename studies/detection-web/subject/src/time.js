// Desk clock and calendar helpers.
//
// The application never reads the machine clock. "Now" comes from the
// SUBJECT_NOW environment variable (an ISO instant) with a fixed default, so
// every date-dependent value in the product is reproducible.

const DEFAULT_NOW = "2026-03-16T09:00:00Z";

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** The frozen desk clock as an ISO instant, e.g. "2026-03-16T09:00:00Z". */
export function nowIso() {
  const raw = process.env.SUBJECT_NOW || DEFAULT_NOW;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`SUBJECT_NOW is not a valid ISO instant: ${raw}`);
  }
  return parsed.toISOString().replace(".000Z", "Z");
}

/** Milliseconds since epoch for the frozen desk clock. */
export function nowMs() {
  return new Date(nowIso()).getTime();
}

/** The desk's calendar date, "YYYY-MM-DD". */
export function today() {
  return nowIso().slice(0, 10);
}

/** True when the string is a well-formed calendar date. */
export function isCalendarDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms)) return false;
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/** Calendar date shifted by whole days. */
export function addDays(date, days) {
  const ms = Date.parse(`${date}T00:00:00Z`) + days * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** 0 = Sunday .. 6 = Saturday. */
export function dayOfWeek(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Monday to Friday are business days; the desk is closed at weekends. */
export function isBusinessDay(date) {
  const day = dayOfWeek(date);
  return day !== 0 && day !== 6;
}

/** Saturday rolls forward to Monday (+2); Sunday rolls forward to Monday (+1). */
export function nextBusinessDay(date) {
  const day = dayOfWeek(date);
  if (day === 6) return addDays(date, 2);
  if (day === 0) return addDays(date, 1);
  return date;
}

/** Business days d with `after < d <= through`. Never negative. */
export function businessDaysBetween(after, through) {
  if (Date.parse(`${through}T00:00:00Z`) <= Date.parse(`${after}T00:00:00Z`)) return 0;
  let count = 0;
  let cursor = addDays(after, 1);
  while (Date.parse(`${cursor}T00:00:00Z`) <= Date.parse(`${through}T00:00:00Z`)) {
    if (isBusinessDay(cursor)) count += 1;
    cursor = addDays(cursor, 1);
  }
  return count;
}

/** "2026-03-16" -> "Mon 16 Mar 2026" (day of month has no leading zero). */
export function formatDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAY_NAMES[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Sleep for a fixed number of milliseconds (simulated desk-system latency). */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
