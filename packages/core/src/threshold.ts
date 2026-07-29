// Perf-budget threshold grammar, shared by the perf gate and the deterministic
// budget anomaly signal so a case's threshold means the same thing to both.
export type ComparisonOperator = "<" | "<=" | ">" | ">=";

export interface ParsedThreshold {
  op: ComparisonOperator;
  limit: number;
}

/** "< 2500" / "<= 2500" / ">= 10" / "> 10"; a bare number means "<= n". */
export function parseThreshold(threshold: unknown): ParsedThreshold | null {
  if (typeof threshold === "number") return { op: "<=", limit: threshold };
  const m = String(threshold).trim().match(/^(<=|>=|<|>)\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  return { op: m[1] as ComparisonOperator, limit: Number(m[2]) };
}

export function compareThreshold(value: number, op: ComparisonOperator, limit: number): boolean {
  switch (op) {
    case "<": return value < limit;
    case "<=": return value <= limit;
    case ">": return value > limit;
    case ">=": return value >= limit;
  }
}
