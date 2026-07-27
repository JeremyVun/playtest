/**
 * Escape hatch for behavior-frozen test fixtures that deliberately construct
 * partial or invalid runtime inputs. Prefer concrete types for normal test data.
 */
type LegacyTestValue = any; // TODO(ts): T7 preserves intentionally malformed legacy fixtures for runtime validation tests
