// Filesystem-backed object store (Phase 1 default). Keys are "/"-joined logical
// paths; they map to files under `root`, with traversal refused. Deterministic,
// dependency-free, and exercised by every offline test in place of S3/MinIO.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "../errors.ts";

export class FsStore {
  declare readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  #abs(key: string): string {
    const abs = path.resolve(this.root, key);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new AppError("storage_error", `refusing object key outside the store: ${key}`);
    }
    return abs;
  }

  async put(key: string, data: Buffer | Uint8Array | string) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as string, "utf8"); // SAFETY: Buffer.from accepts the runtime Uint8Array branch despite this overload selecting the string form.
    const abs = this.#abs(key);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    // Write via a temp sibling + rename so a concurrent reader never sees a
    // half-written blob (content-addressed writes may race on the same key).
    const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await fsp.writeFile(tmp, buf, { mode: 0o600 });
    await fsp.rename(tmp, abs);
    return { key, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await fsp.readFile(this.#abs(key));
    } catch (e: any /* SAFETY: Filesystem errors expose the Node errno code. */) {
      if (e.code === "ENOENT") throw new AppError("not_found", `object not found: ${key}`);
      throw e;
    }
  }

  async getRange(key: string, start: number, end: number): Promise<Buffer> {
    const abs = this.#abs(key);
    return await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const s = fs.createReadStream(abs, { start, end });
      s.on("data", (c) => chunks.push(c as Buffer));
      s.on("end", () => resolve(Buffer.concat(chunks)));
      s.on("error", (e: any /* SAFETY: Filesystem stream errors expose the Node errno code. */) =>
        reject(e.code === "ENOENT" ? new AppError("not_found", `object not found: ${key}`) : e),
      );
    });
  }

  async has(key: string): Promise<boolean> {
    try {
      await fsp.access(this.#abs(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fsp.unlink(this.#abs(key));
    } catch (e: any /* SAFETY: Filesystem errors expose the Node errno code. */) {
      if (e.code !== "ENOENT") throw e; // idempotent
    }
  }

  async list(prefix = ""): Promise<string[]> {
    const base = this.#abs(prefix);
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), childRel);
        else if (!e.name.endsWith(".tmp") && !e.name.includes(".tmp-")) out.push(childRel);
      }
    };
    // Resolve the prefix relative to root for the returned keys.
    const relBase = path.relative(this.root, base);
    await walk(base, relBase === "" ? "" : relBase.split(path.sep).join("/"));
    return out.sort();
  }
}
