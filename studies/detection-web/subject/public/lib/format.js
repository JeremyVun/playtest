// Display formatting. Mirrors the server's presentation helpers.

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
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

/** 87690 -> "$876.90" */
export function money(cents) {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const remainder = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${remainder}`;
}

/** "2026-03-16" -> "Mon 16 Mar 2026" */
export function dateLong(date) {
  if (!date) return "—";
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "2026-03-16T17:00:00Z" -> "Mon 16 Mar 2026, 17:00" */
export function instant(iso) {
  if (!iso) return "—";
  return `${dateLong(iso.slice(0, 10))}, ${iso.slice(11, 16)}`;
}

/** 1 -> "1 unit"; 3 -> "3 units" */
export function units(count) {
  return `${count} ${count === 1 ? "unit" : "units"}`;
}

/** 1 -> "1 day"; 7 -> "7 days" */
export function days(count) {
  return `${count} ${count === 1 ? "day" : "days"}`;
}

/** 1 -> "1 item"; 4 -> "4 items" */
export function items(count) {
  return `${count} ${count === 1 ? "item" : "items"}`;
}

/** 1 -> "1 loan"; 4 -> "4 loans" */
export function loans(count) {
  return `${count} ${count === 1 ? "loan" : "loans"}`;
}
