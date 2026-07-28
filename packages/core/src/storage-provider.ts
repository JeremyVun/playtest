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
  /**
   * Optional bounded tail read: the last `maxBytes` of a file as text, plus
   * whether that is the whole file. The local viewer host uses it to decide a
   * run's liveness from the final line of events.jsonl without parsing the file
   * (docs/contracts/interfaces.md#viewer-server); the picker does this once per
   * run, synchronously. A provider that cannot serve a partial read omits it —
   * a provider without it is read as sealed, which is what a `.ptrun` bundle is
   * by construction. Never throws; null when the file is unreadable.
   */
  readTail?(rel: string, maxBytes: number): { text: string; complete: boolean } | null;
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

  readTail(rel: string, maxBytes: number) {
    let fd: number | null = null;
    try {
      fd = fs.openSync(path.join(this.root, rel), "r");
      const { size } = fs.fstatSync(fd);
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      const read = fs.readSync(fd, buf, 0, buf.length, start);
      // A truncated read can split a UTF-8 sequence and always splits a line;
      // callers drop the leading partial line, so hand back what was read and
      // say whether it is the whole file.
      return { text: buf.subarray(0, read).toString("utf8"), complete: start === 0 };
    } catch {
      return null;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch {}
      }
    }
  }
}
