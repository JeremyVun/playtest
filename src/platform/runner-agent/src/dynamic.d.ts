/**
 * Transitional boundary type for runner protocol payloads, engine results, and
 * user-authored configuration. T11 can replace these with shared wire schemas.
 */
type RunnerDynamic = any; // TODO(ts): Runner protocol and engine boundaries need shared validated types after the behavior-frozen conversion.

interface String {
  /** JavaScript split always returns at least one element, including for an empty string. */
  split(separator: string | RegExp, limit?: number): [string, ...string[]];
}
