import type { DynamicValue } from "./types.ts";

// The target authorization, and the execution license it grants
// (docs/contracts/scripts.md#target-authorization; DESIGN §4 step 2, N8).
//
// One recorded fact — "yes, it is safe to write test data to this environment" —
// scoped to one origin, naming who said so. It is what licenses an authoring job
// to execute anything at all, and what lifts a run out of `read-only`. It is
// never inferred, never widened by script content, and it does not travel: an
// origin change invalidates it, because the sentence was about that origin.
import { DummyConfigError } from "../config.ts";

/**
 * @param {{ base_url: string, authorization?: object, write_grant?: object }} target
 * @param {{ where?: string, require?: boolean }} [options] `require: false` allows
 *   an unauthorized target (replay of an approved script, which carries its own
 *   license); authoring always requires one.
 * @returns {{ origin, approved_by, approved_at, record?, write, write_grant }}
 */
export function resolveTargetAuthorization(target: DynamicValue = {}, { where = "script run", require: required = true }: DynamicValue = {}) {
  let baseOrigin;
  try {
    const url = new URL(String(target.base_url));
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
    baseOrigin = url.origin;
  } catch {
    throw new DummyConfigError(`${where}: target.base_url ${JSON.stringify(target.base_url ?? null)} is not an http(s) URL`);
  }

  const declaration = target.authorization ?? (target.write_grant ? { ...target.write_grant, write: true } : null);
  if (!declaration) {
    if (!required) return { origin: baseOrigin, approved_by: null, approved_at: null, write: false, expired: false, disposable: false, reset: null, write_grant: null };
    throw new DummyConfigError(
      `${where}: this target has no recorded authorization, so nothing may be executed against it.\n` +
        `  Authoring runs a program against ${baseOrigin}. Record the owner's answer to "safe to write test data to\n` +
        '  this environment?" as target.authorization = { origin, approved_by, approved_at, write: true|false }.',
    );
  }
  if (typeof declaration !== "object" || Array.isArray(declaration)) {
    throw new DummyConfigError(`${where}: target.authorization is the recorded declaration { origin, approved_by, approved_at, write }`);
  }
  let origin;
  try {
    origin = new URL(String(declaration.origin)).origin;
  } catch {
    throw new DummyConfigError(`${where}: target.authorization.origin ${JSON.stringify(declaration.origin ?? null)} is not an origin`);
  }
  if (origin !== baseOrigin) {
    throw new DummyConfigError(
      `${where}: the recorded authorization covers ${origin}, but this job resolves ${baseOrigin} —` +
        " an authorization covers exactly the origin it was given for, and an origin change invalidates it." +
        " Re-record it for the new origin before running against it.",
    );
  }
  if (typeof declaration.approved_by !== "string" || !declaration.approved_by.trim()) {
    throw new DummyConfigError(`${where}: target.authorization needs approved_by — an authorization records who gave it`);
  }
  // Expiry is one timestamp, not the start of a scope language: the scoped
  // authorization of DESIGN §10 stays a roadmap seam. What it buys is the
  // difference between "somebody said yes once" and "somebody says yes now".
  const expiresAt = declaration.expires_at ?? null;
  let expired = false;
  if (expiresAt) {
    const at = Date.parse(String(expiresAt));
    if (Number.isNaN(at)) throw new DummyConfigError(`${where}: target.authorization.expires_at ${JSON.stringify(expiresAt)} is not a timestamp`);
    expired = at <= Date.now();
  }
  const write = declaration.write !== false && !expired;
  const record: DynamicValue = {
    origin,
    approved_by: declaration.approved_by.trim(),
    approved_at: declaration.approved_at ?? null,
    ...(expiresAt ? { expires_at: String(expiresAt) } : {}),
    ...(declaration.record ? { record: String(declaration.record) } : {}),
  };
  return {
    ...record,
    write,
    expired,
    // A target the owner said may be rebuilt at will. It is what lets a PENDING
    // revision be validated before approval (docs/contracts/scripts.md#replay-and-drift).
    disposable: declaration.disposable === true,
    reset: declaration.reset ?? null,
    write_grant: write ? record : null,
  };
}
