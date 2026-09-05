import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { AppError } from "../errors.ts";
import { validateKey, validateRange } from "./keys.ts";
import type { ObjectMetadata, ObjectStore } from "../types.ts";

export class FsStore implements ObjectStore {
  declare readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  #abs(key: string): string {
    validateKey(key);
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
    validateRange(start, end);
    const abs = this.#abs(key);
    try {
      if ((await fsp.stat(abs)).size <= start) throw new AppError("bad_request", "object range starts beyond the object", { status: 416 });
    } catch (error: any) {
      if (error.code === "ENOENT") throw new AppError("not_found", `object not found: ${key}`);
      throw error;
    }
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
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
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

  async *listPages(prefix = ""): AsyncGenerator<ObjectMetadata[]> {
    validateKey(prefix, true);
    const walk = async function* (dir: string, rel: string): AsyncGenerator<ObjectMetadata> {
      let entries: fs.Dirent[];
      try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
      catch (error: any) { if (error.code === "ENOENT") return; throw error; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const key = rel + entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* walk(abs, key + "/");
        else if (entry.isFile() && !entry.name.includes(".tmp-") && key.startsWith(prefix)) {
          const stat = await fsp.stat(abs);
          yield { key, size: stat.size, lastModified: stat.mtime };
        }
      }
    };
    let page: ObjectMetadata[] = [];
    for await (const item of walk(this.root, "")) {
      page.push(item);
      if (page.length === 1000) { yield page; page = []; }
    }
    if (page.length) yield page;
  }
  async list(prefix = ""): Promise<string[]> {
    const keys: string[] = [];
    for await (const page of this.listPages(prefix)) for (const item of page) keys.push(item.key);
    return keys.sort();
  }
  close(): void {}
}
