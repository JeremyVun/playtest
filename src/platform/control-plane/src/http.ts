// Request/response plumbing shared by every handler. A handler returns either a
// plain JS value (→ 200 JSON) or an HttpResult (custom status/headers/redirect/raw
// bytes for tar downloads). Bodies are read on demand with a hard size cap so a
// giant upload can't exhaust memory (→ payload_too_large, never a crash).
import { AppError } from "./errors.ts";
import type { IncomingMessage } from "node:http";
import type { DynamicJson } from "./types.ts";

const JSON_LIMIT = 4 * 1024 * 1024; // 4 MiB — a suite file, not a bundle
const TAR_LIMIT = 64 * 1024 * 1024; // 64 MiB — a whole suite export

export class HttpResult {
  declare readonly status: number;
  declare readonly json: unknown;
  declare readonly buffer: Buffer | undefined;
  declare readonly contentType: string | undefined;
  declare readonly headers: Record<string, string>;
  declare readonly redirect: string | undefined;
  declare readonly cookies: string[];

  constructor({
    status = 200,
    json = undefined,
    buffer = undefined,
    contentType = undefined,
    headers = {},
    redirect = undefined,
    cookies = []
  }: {
    status?: number;
    json?: unknown;
    buffer?: Buffer;
    contentType?: string;
    headers?: Record<string, string>;
    redirect?: string;
    cookies?: string[];
  } = {}) {
    this.status = status;
    this.json = json;
    this.buffer = buffer;
    this.contentType = contentType;
    this.headers = headers;
    this.redirect = redirect;
    this.cookies = cookies; // array of Set-Cookie strings
  }
}

export const created = (json: unknown) => new HttpResult({ status: 201, json });
export const noContent = () => new HttpResult({ status: 204 });
export const redirect = (url: string, cookies: string[] = []) => new HttpResult({ status: 302, redirect: url, cookies });
export const tar = (buffer: Buffer, filename: string) =>
  new HttpResult({
    buffer,
    contentType: "application/x-tar",
    headers: { "content-disposition": `attachment; filename="${filename}"` },
  });

async function collect(req: IncomingMessage, limit: number): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new AppError("payload_too_large", `request body exceeds ${limit} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Parse a JSON request body; `{}` for an empty body. Throws bad_request on bad JSON. */
export async function readJsonBody(
  req: IncomingMessage,
  { limit = JSON_LIMIT }: { limit?: number } = {}
): Promise<DynamicJson> {
  const buf = await collect(req, limit);
  if (!buf.length) return {};
  try {
    const parsed = JSON.parse(buf.toString("utf8"));
    if (parsed === null || typeof parsed !== "object") {
      throw new AppError("bad_request", "request body must be a JSON object");
    }
    return parsed;
  } catch (e: any /* SAFETY: JSON parse failures expose Error.message at this boundary. */) {
    if (e instanceof AppError) throw e;
    throw new AppError("bad_request", `invalid JSON body: ${e.message}`);
  }
}

/** Read a raw (binary) body — for tar import. */
export async function readRawBody(req: IncomingMessage, { limit = TAR_LIMIT }: { limit?: number } = {}) {
  return await collect(req, limit);
}
