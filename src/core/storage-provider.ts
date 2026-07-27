// Storage seam for viewer run-data access.
// See docs/contracts/artifacts.md#storage-providers-and-run-bundles.
// view-server.js routes its run-data reads through a StorageProvider so a future
// hosted viewer can swap LocalFsProvider for an S3/DB-backed one without touching
// the HTTP routing or the browser. All paths are relative to the provider's root.
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

export interface StorageProvider {
  /** Directory entries (null on an unreadable path; never throws). */
  listDir(rel: string): Array<{ name: string; isFile: boolean; isDirectory: boolean }> | null;
  /** File contents as text (null on any error). */
  readText(rel: string): string | null;
  /** File metadata (null if absent). */
  stat(rel: string): { size: number; mtime: Date; isFile: boolean } | null;
  /** Readable byte stream (opts matches fs.createReadStream's {start, end}). */
  createReadStream(rel: string, opts?: { start?: number; end?: number }): Readable;
}

/**
 * A future S3 provider implements stat=HeadObject, createReadStream=GetObject(Range),
 * readText=GetObject, listDir=ListObjects.
 */

/** The default provider: the local filesystem rooted at `root`. */
export class LocalFsProvider implements StorageProvider {
  declare readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  listDir(rel: string) {
    try {
      return fs.readdirSync(path.join(this.root, rel), { withFileTypes: true }).map((e) => ({
        name: e.name,
        isFile: e.isFile(),
        isDirectory: e.isDirectory(),
      }));
    } catch {
      return null;
    }
  }

  readText(rel: string) {
    try {
      return fs.readFileSync(path.join(this.root, rel), "utf8");
    } catch {
      return null;
    }
  }

  stat(rel: string) {
    try {
      const st = fs.statSync(path.join(this.root, rel));
      return { size: st.size, mtime: st.mtime, isFile: st.isFile() };
    } catch {
      return null;
    }
  }

  createReadStream(rel: string, opts?: { start?: number; end?: number }) {
    return fs.createReadStream(path.join(this.root, rel), opts);
  }
}
