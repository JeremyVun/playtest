// Storage seam for the trajectory viewer's run-data access (docs/CONTRACTS.md §13).
// view-server.js routes its run-data reads through a StorageProvider so a future
// hosted viewer can swap LocalFsProvider for an S3/DB-backed one without touching
// the HTTP routing or the browser. All paths are relative to the provider's root.
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {object} StorageProvider
 * @property {(rel: string) => {name: string, isFile: boolean, isDirectory: boolean}[] | null} listDir
 *   directory entries (null on an unreadable path; never throws)
 * @property {(rel: string) => string | null} readText
 *   file contents as text (null on any error)
 * @property {(rel: string) => {size: number, mtime: Date, isFile: boolean} | null} stat
 *   file metadata (null if absent)
 * @property {(rel: string, opts?: {start?: number, end?: number}) => import("node:stream").Readable} createReadStream
 *   readable byte stream (opts matches fs.createReadStream's {start, end})
 *
 * A future S3 provider implements stat=HeadObject, createReadStream=GetObject(Range),
 * readText=GetObject, listDir=ListObjects.
 */

/** The default provider: the local filesystem rooted at `root`. */
export class LocalFsProvider {
  constructor(root) {
    this.root = path.resolve(root);
  }

  listDir(rel) {
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

  readText(rel) {
    try {
      return fs.readFileSync(path.join(this.root, rel), "utf8");
    } catch {
      return null;
    }
  }

  stat(rel) {
    try {
      const st = fs.statSync(path.join(this.root, rel));
      return { size: st.size, mtime: st.mtime, isFile: st.isFile() };
    } catch {
      return null;
    }
  }

  createReadStream(rel, opts) {
    return fs.createReadStream(path.join(this.root, rel), opts);
  }
}
