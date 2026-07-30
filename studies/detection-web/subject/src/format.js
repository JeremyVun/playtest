// Presentation helpers used in server-generated messages.

/** 87690 -> "$876.90"; 40200 -> "$402.00"; 900000 -> "$9,000.00". */
export function formatMoney(cents) {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  const remainder = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${remainder}`;
}

/** 1 -> "1 unit"; 2 -> "2 units". */
export function formatUnits(count) {
  return `${count} ${count === 1 ? "unit" : "units"}`;
}

/** 1 -> "is"; anything else -> "are". */
export function verbFor(count) {
  return count === 1 ? "is" : "are";
}
