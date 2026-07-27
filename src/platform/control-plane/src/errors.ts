// The single error-code registry (docs/contracts/hosted.md#http-conventions-and-authorization).
// Every API error surfaces as `{ error: { code, message, details? } }` with a
// lower_snake `code` drawn from ERROR_CODES and an HTTP status from this table —
// the friendly, file/field-naming discipline of core's DummyConfigError, ported to
// HTTP. A raw stack trace or bare 500 body must never reach a client; server.js
// maps any uncaught throw to `internal`.

/** code -> default HTTP status. Codes are the contract; add here, never inline. */
export const ERROR_CODES = {
  // 400s
  bad_request: 400,
  validation_failed: 422, // Ajv/config validation; core messages ride in details
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  method_not_allowed: 405,
  conflict: 409, // snapshot/version conflict, duplicate key
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429, // write-route token bucket (Phase 7); Retry-After names the wait
  // An optional capability this deployment has not been given (the platform LLM
  // gateway). The request was well-formed and authorized, so it is not a 4xx,
  // and nothing crashed, so it must not be a 500: a deployment choice reported
  // as "Internal Server Error" sends people hunting a bug that does not exist.
  // The message names the environment variable that turns the capability on.
  not_configured: 503,
  // 500s
  internal: 500,
  not_implemented: 501,
  config_error: 500, // server misconfiguration surfaced at startup, not to clients
  storage_error: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * A client-facing API error. `code` must be a key of ERROR_CODES. `details` is an
 * optional array/object carried verbatim to the client (validation messages live
 * here). `status` defaults from the code but a caller may override.
 */
export class AppError extends Error {
  declare readonly code: ErrorCode;
  declare readonly status: number;
  declare readonly details: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    { details = undefined, status = undefined, cause = undefined }: {
      details?: unknown;
      status?: number;
      cause?: unknown;
    } = {}
  ) {
    super(message);
    this.name = "AppError";
    if (!(code in ERROR_CODES)) {
      // A typo'd code must fail loudly in dev, not ship a broken envelope.
      throw new Error(`AppError: unknown error code "${code}" (add it to ERROR_CODES)`);
    }
    this.code = code;
    this.status = status ?? ERROR_CODES[code];
    this.details = details;
    if (cause) this.cause = cause;
  }

  /** The wire envelope. */
  toEnvelope() {
    const error: { code: ErrorCode; message: string; details?: unknown } = {
      code: this.code,
      message: this.message
    };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

// Convenience constructors for the codes used all over the API — keeps call sites
// terse and the codes consistent.
export const badRequest = (msg: string, details?: unknown) => new AppError("bad_request", msg, { details });
export const notFound = (msg = "not found") => new AppError("not_found", msg);
export const forbidden = (msg = "you do not have permission to do that") =>
  new AppError("forbidden", msg);
export const unauthenticated = (msg = "sign in to continue") =>
  new AppError("unauthenticated", msg);
export const conflict = (msg: string, details?: unknown) => new AppError("conflict", msg, { details });

/**
 * A validation failure whose `details` carry the core validators' messages
 * verbatim, one entry per offending file/key. `details` is an array
 * of `{ path, message }`.
 */
export const validationFailed = (details: unknown, message = "the suite files did not validate") =>
  new AppError("validation_failed", message, { details });
