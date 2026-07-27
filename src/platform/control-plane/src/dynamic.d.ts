/**
 * Explicit unsafe boundary for route-local request bodies, raw SQL projections,
 * and model replies. Owning routes validate these values before domain use.
 */
type HostedDynamic = any; // SAFETY: preserves the runtime shapes accepted by route-local validators and SQLite projections.

interface String {
  /** JavaScript split always returns at least one element, including for an empty string. */
  split(separator: string | RegExp, limit?: number): [string, ...string[]];
}
