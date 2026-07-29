// The local CLI configuration / user-input failure type. A leaf module so the
// normalizers config resolution depends on (secrets, match, bindings, openapi,
// assertions) can throw it without importing the resolver back — the class is
// re-exported unchanged from ../config.ts, which stays the public import path.
export class DummyConfigError extends Error {
  declare availableEnvs?: string[];
}
