import { AppError } from "../errors.ts";

export function validateKey(key: string, prefix = false): void {
  const parts = (prefix ? key.replace(/\/$/, "") : key).split("/");
  if (prefix && key === "") return;
  if (!key || Buffer.byteLength(key) > 900 || /[\\\x00-\x1f\x7f#]/.test(key) || parts.some(p => !p || p === "." || p === "..")) {
    throw new AppError("storage_error", "invalid object key");
  }
}

export function validateRange(start: number, end: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new AppError("bad_request", "object range must have nonnegative inclusive byte offsets");
  }
}
