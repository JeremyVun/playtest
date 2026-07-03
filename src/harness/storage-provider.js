// Storage provider: the viewer/report layer reads run artifacts through this thin
// abstraction so a future remote backend (e.g. S3) can drop in behind the same
// interface. See docs/CONTRACTS.md.
// NOTE (reconstruction): the imports (line 1) and the tail from stat() onward
// (stat body, createReadStream, class close) were not legible in any video frame;
// they are inferred from the interface typedef below and standard node:fs usage.
// The typedef and the listDir/readText methods are transcribed from the frames.
import fs from "node:fs";
import path from "node:path";

/** @typedef {object} StorageProvider
 * @property {(rel: string) => {name: string, isFile: boolean, isDirectory: boolean}[] | null} listDir
 *   directory entries (null on an unreadable path; never throws)
 * @property {(rel: string) => string | null} readText
 *   file contents as text (null on any read error)
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
      const s = fs.statSync(path.join(this.root, rel));
      return { size: s.size, mtime: s.mtime, isFile: s.isFile() };
    } catch {
      return null;
    }
  }

  createReadStream(rel, opts) {
    return fs.createReadStream(path.join(this.root, rel), opts);
  }
}
