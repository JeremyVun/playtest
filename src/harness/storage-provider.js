// [UNREADABLE ~lines 1-8: file header and imports (fs, path) not captured in any frame]
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
// [UNREADABLE ~lines 49+: stat() body, createReadStream(), class close, and exports not captured in any frame]
