// Shared helpers for the minibank ledger script suite.
// No I/O of its own: everything here is pure or takes the injected client.

export const ADMIN = "LEDGER_ADMIN_TOKEN";
export const CUST_A = "LEDGER_CUSTOMER_TOKEN";
export const CUST_B = "LEDGER_CUSTOMER_B_TOKEN";

export const SYNTHETIC = Object.freeze({
  ref: null,
  status: 0,
  statusText: "",
  headers: Object.freeze({}),
  text: "",
  json: null,
  ok: false,
  synthetic: true,
});

/** fee = 25 + round_half_away_from_zero(amount * 15 / 10000), integer minor units. */
export function expectedFee(amount) {
  if (!Number.isInteger(amount)) return NaN;
  const sign = amount < 0 ? -1 : 1;
  const n = Math.abs(amount) * 15;
  const q = Math.floor(n / 10000);
  const rem = n - q * 10000;
  const bps = rem * 2 >= 10000 ? q + 1 : q;
  return 25 + sign * bps;
}

/** Drop null-valued keys and sort keys so "absent" and "null" compare equal. */
export function normalize(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === null || value[key] === undefined) continue;
    out[key] = normalize(value[key]);
  }
  return out;
}

export function sameResource(a, b) {
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

export function diffKeys(a, b) {
  const na = normalize(a) ?? {};
  const nb = normalize(b) ?? {};
  const keys = new Set([...Object.keys(na), ...Object.keys(nb)]);
  const out = [];
  for (const k of keys) {
    if (JSON.stringify(na[k]) !== JSON.stringify(nb[k])) {
      out.push(`${k}: ${JSON.stringify(na[k])} vs ${JSON.stringify(nb[k])}`);
    }
  }
  return out;
}

export function qs(pairs) {
  const parts = [];
  for (const [k, v] of pairs) {
    if (v === undefined || v === null) continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Collect integer HAR refs from response records (or raw ints); drops synthetics. */
export function refs(...args) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (Number.isInteger(v)) { out.push(v); return; }
    if (v && Number.isInteger(v.ref)) out.push(v.ref);
  };
  walk(args);
  return [...new Set(out)];
}

export function short(res) {
  if (!res) return "no response";
  if (res.synthetic) return "request not made (mode or budget guard)";
  if (res.transportError) return `transport error: ${res.transportError}`;
  const code = res.json && res.json.error && res.json.error.code;
  return `${res.status}${code ? ` ${code}` : ""}`;
}

export function bodySnippet(res, max = 220) {
  if (!res) return "none";
  if (res.synthetic) return "not made";
  const t = typeof res.text === "string" ? res.text : JSON.stringify(res.json);
  return (t || "").slice(0, max);
}

/** Structural test of the documented error envelope. */
export function errorShapeProblem(res) {
  if (!res || res.synthetic) return "not made";
  if (res.transportError) return `transport error: ${res.transportError}`;
  if (res.parseError) return "body did not parse as JSON";
  const j = res.json;
  if (j === null || typeof j !== "object" || Array.isArray(j)) return "body is not a JSON object";
  const top = Object.keys(j);
  if (top.length !== 1 || top[0] !== "error") return `top-level keys ${JSON.stringify(top)} (expected exactly ["error"])`;
  const e = j.error;
  if (e === null || typeof e !== "object" || Array.isArray(e)) return "error is not an object";
  if (typeof e.code !== "string") return `error.code is ${JSON.stringify(e.code)} (expected string)`;
  if (typeof e.message !== "string") return `error.message is ${JSON.stringify(e.message)} (expected string)`;
  const extra = Object.keys(e).filter((k) => k !== "code" && k !== "message" && k !== "details");
  if (extra.length) return `error carries undocumented keys ${JSON.stringify(extra)}`;
  if ("details" in e && (e.details === null || typeof e.details !== "object" || Array.isArray(e.details))) {
    return `error.details is ${JSON.stringify(e.details)} (expected object when present)`;
  }
  return null;
}

/** Page-level discipline over one cursor enumeration. */
export function pageDiscipline(pages, limit) {
  const ids = [];
  const seen = new Set();
  const duplicates = [];
  const oversize = [];
  const shortWithNext = [];
  pages.forEach((page, index) => {
    const items = Array.isArray(page && page.json && page.json.items) ? page.json.items : [];
    const next = page && page.json ? page.json.next_cursor ?? null : null;
    if (items.length > limit) oversize.push(`page ${index}: ${items.length} items > limit ${limit}`);
    if (items.length < limit && next) shortWithNext.push(`page ${index}: ${items.length} items < limit ${limit} but next_cursor is not null`);
    for (const item of items) {
      const id = item && item.id;
      ids.push(id);
      if (seen.has(id)) duplicates.push(String(id));
      else seen.add(id);
    }
  });
  return { ids, seen, duplicates, oversize, shortWithNext };
}

export function sumAmounts(entries) {
  let total = 0;
  for (const e of entries) {
    const a = e && e.amount;
    if (!Number.isInteger(a)) return NaN;
    total += a;
  }
  return total;
}
