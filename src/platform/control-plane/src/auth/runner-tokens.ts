import crypto from "node:crypto";
import { unauthenticated, forbidden } from "../errors.ts";
import type { ControlPlaneConfig } from "../config.ts";
import type { DynamicJson, RequestContext } from "../types.ts";

export function makeRunnerTokenKey(config: ControlPlaneConfig): Buffer {
  return config.kmsKey || crypto.randomBytes(32);
}

export function issueRunnerToken(
  key: Buffer,
  { executorId, runGroupId, ttlSeconds = 12 * 60 * 60 }: {
    executorId: string;
    runGroupId: string;
    ttlSeconds?: number;
  }
): string {
  const payload = {
    executor_id: executorId,
    run_group_id: runGroupId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = hmac(key, body);
  return `pr_${body}.${sig}`;
}

export function verifyRunnerToken(key: Buffer, token: unknown): DynamicJson {
  if (typeof token !== "string" || !token.startsWith("pr_")) throw unauthenticated("runner token is missing or invalid");
  const raw = token.slice(3);
  const dot = raw.lastIndexOf(".");
  if (dot < 0) throw unauthenticated("runner token is missing or invalid");
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  if (!safeEqual(sig, hmac(key, body))) throw unauthenticated("runner token is missing or invalid");
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw unauthenticated("runner token is missing or invalid");
  }
  if (!payload?.executor_id || !payload?.run_group_id || payload.exp < Math.floor(Date.now() / 1000)) {
    throw unauthenticated("runner token is missing or expired");
  }
  return payload;
}

export function requireRunner(ctx: RequestContext, runGroupId: string | null = null): DynamicJson {
  const auth = ctx.req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  const payload = verifyRunnerToken(ctx.runnerTokenKey, token);
  if (runGroupId && payload.run_group_id !== runGroupId) {
    throw forbidden("runner token is not scoped to this run group");
  }
  return payload;
}

function hmac(key: Buffer, body: string): string {
  return crypto.createHmac("sha256", key).update(body).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
