// Case discovery and playtest.yaml inheritance — compatibility barrel.
// The implementation lives under config/: errors.ts (DummyConfigError),
// schema.ts (Ajv validators + the built-in criterion vocabulary), discovery.ts
// (directory traversal and fan-out), resolve.ts (inheritance and cross-field
// validation). This module stays the public import path, so every existing
// `from "./config.ts"` keeps working; new code inside config/ imports the
// specific leaf instead, which is what keeps the old import cycle broken.
// See docs/contracts/engine.md#discovery-and-configuration.
export { DummyConfigError } from "./config/errors.ts";
export { BUILTIN_SUCCESS_KINDS } from "./config/schema.ts";
export { discoverCases } from "./config/discovery.ts";
export {
  defaultModels,
  normalizeAllowedOrigins,
  normalizeRuntimeTarget,
  parseDuration,
  resolveViewport,
} from "./config/resolve.ts";
