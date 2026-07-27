/**
 * Escape hatch for test fixtures that deliberately construct
 * partial or invalid runtime inputs. Prefer concrete types for normal test data.
 */
type LegacyTestValue = any; // SAFETY: tests deliberately pass malformed values through production validation boundaries.
