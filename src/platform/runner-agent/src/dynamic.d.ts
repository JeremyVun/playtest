/**
 * Explicit unsafe boundary for runner protocol payloads, engine results, and
 * user-authored configuration. Consumers validate the fields they own.
 */
type RunnerDynamic = any; // SAFETY: protocol compatibility includes historical payload shapes validated at their consumers.

interface String {
  /** JavaScript split always returns at least one element, including for an empty string. */
  split(separator: string | RegExp, limit?: number): [string, ...string[]];
}
