import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "./db.ts";
import type { ControlPlaneConfig } from "./config.ts";
import type { FeedWaker } from "./events/feed.ts";
import type { WriteRateLimiter } from "./rate-limit.ts";
import type { ClaimBoard } from "./dispatch/pool.ts";
import type { RunBundleCache } from "./run-storage.ts";

export type DynamicJson = Record<string, any>; // SAFETY: Route-specific validation narrows untyped JSON request and model response objects.
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(fields: LogFields): void;
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
  newRequestId(): string;
}

export interface Principal {
  kind: string;
  id?: string;
  userId?: string;
  tokenId?: string;
  role?: string;
  projectId?: string | null;
  isDevAdmin?: boolean;
  roles?: Map<string, string>;
  system?: string;
  memberships?: Record<string, string>;
  [key: string]: unknown;
}

export interface ObjectStore {
  put(key: string, data: Buffer | Uint8Array | string): Promise<{ key: string; size: number; sha256: string }>;
  get(key: string): Promise<Buffer>;
  getRange(key: string, start: number, end: number): Promise<Buffer>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}

export interface AppContext {
  db: Db;
  store: ObjectStore;
  config: ControlPlaneConfig;
  log: Logger;
  devUserId: string | null;
  feedWaker: FeedWaker;
  /** The one placement model: the runner claim board (`dispatch/pool.ts`). */
  board: ClaimBoard;
  runnerTokenKey: Buffer;
  writeLimiter: WriteRateLimiter;
  /** The app-owned run-bundle LRU (`run-storage.ts`); cleared on `app.close()`. */
  runBundleCache: RunBundleCache;
}

export interface RequestContext extends AppContext {
  req: IncomingMessage;
  res: ServerResponse;
  principal: Principal | null;
  params: Record<string, string>;
  query: URLSearchParams;
  requestId: string;
}
