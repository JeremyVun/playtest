/**
 * Transitional boundary type for the control plane's route-local request bodies,
 * raw SQL projections, and model replies. T11 can replace these with per-route
 * and per-query schemas without changing this behavior-frozen migration.
 */
type HostedDynamic = any; // TODO(ts): Legacy hosted dynamic boundaries need named schemas after the behavior-frozen conversion.

interface String {
  /** JavaScript split always returns at least one element, including for an empty string. */
  split(separator: string | RegExp, limit?: number): [string, ...string[]];
}
