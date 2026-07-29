// Parse a scalar written the way a case author writes it in YAML-ish shorthand:
// quoted strings keep their quotes' contents, bare true/false/null and numbers
// become their JSON values, anything else stays a string. Shared by the gate's
// journey_data checks and the invariant evaluator so both read author input
// identically.
export type JsonLiteral = string | number | boolean | null;

export function parseLiteral(raw: unknown): JsonLiteral {
  const t = String(raw).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(t)) return Number(t);
  return t;
}
