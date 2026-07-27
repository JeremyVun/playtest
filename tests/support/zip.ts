// A minimal ZIP writer for tests.
//
// Tests need to BUILD the archives the product only ever reads: an iOS `.app`
// is a directory, so an environment app artifact travels zipped, and the runner
// unpacks it preserving unix modes and symlinks
// (packages/platform/runner-agent/src/app-artifact.ts). Nothing in the shipped
// product writes a ZIP of arbitrary files, so this lives with the tests that do.
//
// Stored (uncompressed) entries only — deterministic bytes, no dependency, and
// the reader under test handles both methods either way.
import zlib from "node:zlib";

export interface ZipInput {
  /** Archive-relative path. A trailing "/" or `dir: true` makes it a directory. */
  name: string;
  content?: Buffer | string;
  /** Unix permission bits (the file type is added from `dir`/`symlink`). */
  mode?: number;
  dir?: boolean;
  /** Link target; makes this entry a symlink whose content is the target. */
  symlink?: string;
  /** Deflate this entry instead of storing it. */
  deflate?: boolean;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const MADE_BY_UNIX_45 = (3 << 8) | 45;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** Build a ZIP archive from a list of entries. */
export function writeZip(entries: ZipInput[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const isDir = entry.dir === true || entry.name.endsWith("/");
    const isLink = typeof entry.symlink === "string";
    const name = isDir ? entry.name.replace(/\/*$/, "/") : entry.name;
    const raw = isLink
      ? Buffer.from(entry.symlink!, "utf8") // SAFETY: isLink narrows symlink to a string
      : isDir
        ? Buffer.alloc(0)
        : Buffer.isBuffer(entry.content)
          ? entry.content
          : Buffer.from(entry.content ?? "", "utf8");
    const method = entry.deflate && raw.length ? 8 : 0;
    const body = method === 8 ? zlib.deflateRawSync(raw, { level: 9 }) : raw;
    const crc = crc32(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const perms = entry.mode ?? (isLink ? 0o777 : isDir ? 0o755 : 0o644);
    const mode = perms | (isLink ? S_IFLNK : isDir ? S_IFDIR : S_IFREG);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(MADE_BY_UNIX_45, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE((mode >>> 0) * 0x10000, 38); // external attributes: unix mode in the high word
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8); // SAFETY: index masked into the 256-entry table
  return ~c >>> 0;
}
