import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { AppContext, Principal } from "../types.ts";
import { forbidden } from "../errors.ts";
import { ensureUser } from "./users.ts";

function header(req: IncomingMessage, name: string, max: number): string | null {
  const value = req.headers[name];
  const count = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]?.toLowerCase() === name).length;
  if (count !== 1 || typeof value !== "string" || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) return null;
  return value;
}

export async function principalForProxy(ctx: AppContext, req: IncomingMessage): Promise<Principal | null> {
  const config = ctx.config.auth.proxy;
  if (!config) return null;
  const supplied = header(req, "x-playtest-proxy-key", 128);
  if (!supplied) return null;
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(config.secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const subject = header(req, "remote-user", 256);
  if (!subject || subject.trim() !== subject || /[,\s]/.test(subject)) return null;
  const email = header(req, "remote-email", 320);
  const name = header(req, "remote-name", 512);
  if ((req.headers["remote-email"] !== undefined && !email) || (req.headers["remote-name"] !== undefined && !name)) return null;
  const user = await ensureUser(ctx.db, { subject: `proxy:${subject}`, email: email || `${subject}@unknown`, name });
  if (!user || user.disabled) return null;
  return {
    kind: "user", userId: user.id, subject: user.subject,
    email: user.email, name: user.name, roles: new Map(), isSiteAdmin: true, authMethod: "proxy",
  };
}

export function requireProxyWriteOrigin(req: IncomingMessage, publicUrl: string): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method || "")) return;
  const origin = header(req, "origin", 2048);
  const referer = header(req, "referer", 8192);
  const source = req.headers.origin === undefined ? referer : origin;
  try {
    if (!source || new URL(source).origin !== new URL(publicUrl).origin) throw new Error();
  } catch {
    throw forbidden("Open Playtest in your browser and try again. This request came from an untrusted page.");
  }
}
