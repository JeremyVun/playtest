// Minimal USTAR reader/writer for suite export/import:
// `GET /suites/:s/export` → tar of the tree, `POST /suites/:s/import` ← tar). Plain
// uncompressed tar so a developer can `tar xf suite.tar` and run the CLI directly —
// the export/import round-trip that keeps the hosted DB and a git repo interchangeable.
// In-repo because the control plane has no npm dependencies;
// this is the same in-family hand-roll as bundle.js's ZIP codec. Deterministic
// output (sorted names, zeroed mtime) so an exported tree hashes reproducibly.

const BLOCK = 512;
const enc = new TextEncoder();

function octal(n: number, len: number): string {
  // USTAR numeric fields: zero-padded octal, NUL-terminated, `len-1` digits.
  const s = n.toString(8).padStart(len - 1, "0");
  return s.slice(-(len - 1)) + "\0";
}

function writeField(buf: Uint8Array, offset: number, str: string, len: number): void {
  const bytes = enc.encode(str);
  buf.set(bytes.subarray(0, len), offset);
}

function header(name: string, size: number, mtime = 0): Uint8Array {
  const buf = new Uint8Array(BLOCK);
  // Split long names into prefix(155)/name(100) at a slash boundary (USTAR rule).
  let prefix = "";
  let short = name;
  if (name.length > 100) {
    const cut = name.lastIndexOf("/", 154);
    if (cut > 0 && name.length - cut - 1 <= 100) {
      prefix = name.slice(0, cut);
      short = name.slice(cut + 1);
    }
    if (short.length > 100 || prefix.length > 155) {
      throw new Error(`path too long for USTAR: ${name}`);
    }
  }
  writeField(buf, 0, short, 100);
  writeField(buf, 100, octal(0o644, 8), 8); // mode
  writeField(buf, 108, octal(0, 8), 8); // uid
  writeField(buf, 116, octal(0, 8), 8); // gid
  writeField(buf, 124, octal(size, 12), 12);
  writeField(buf, 136, octal(mtime, 12), 12);
  writeField(buf, 156, "0", 1); // typeflag: regular file
  writeField(buf, 257, "ustar\0", 6);
  writeField(buf, 263, "00", 2);
  writeField(buf, 345, prefix, 155);
  // checksum: sum of all bytes with the checksum field treated as spaces.
  for (let i = 148; i < 156; i++) buf[i] = 0x20;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i]!; // TODO(ts): The fixed-size header and loop bounds guarantee this byte exists.
  writeField(buf, 148, sum.toString(8).padStart(6, "0") + "\0 ", 8);
  return buf;
}

/**
 * Pack `{ path: content }` into a tar Buffer. Content may be string or Buffer.
 * Entries are emitted in sorted path order for deterministic output.
 */
export function writeTar(files: Record<string, string | Buffer>): Buffer {
  const chunks: Buffer[] = [];
  for (const name of Object.keys(files).sort()) {
    const data = Buffer.isBuffer(files[name]!) ? files[name]! : Buffer.from(files[name]!, "utf8"); // TODO(ts): Object.keys guarantees this indexed entry exists.
    chunks.push(Buffer.from(header(name, data.length)));
    chunks.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // two zero blocks = end of archive
  return Buffer.concat(chunks);
}

function parseOctal(bytes: Uint8Array): number {
  const s = Buffer.from(bytes).toString("latin1").replace(/\0.*$/, "").trim();
  return s ? parseInt(s, 8) : 0;
}

function fieldStr(buf: Buffer, off: number, len: number): string {
  return buf.subarray(off, off + len).toString("utf8").replace(/\0.*$/, "");
}

/**
 * Unpack a tar Buffer into `{ path: Buffer }`. Regular files only; directory,
 * symlink, and pax/gnu extension entries are skipped (a suite tree has none).
 * Throws on a corrupt header (bad checksum) so a truncated upload fails loudly.
 */
export function readTar(buffer: Buffer | Uint8Array): Record<string, Buffer> {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const out: Record<string, Buffer> = {};
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const head = buf.subarray(off, off + BLOCK);
    if (head.every((b) => b === 0)) break; // end-of-archive zero block
    // Verify checksum.
    const stored = parseOctal(head.subarray(148, 156));
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : head[i]!; // TODO(ts): The full-header loop guard guarantees this byte exists.
    if (sum !== stored) throw new Error("corrupt tar: header checksum mismatch");

    const name = fieldStr(head, 0, 100);
    const prefix = fieldStr(head, 345, 155);
    const full = prefix ? `${prefix}/${name}` : name;
    const size = parseOctal(head.subarray(124, 136));
    const typeflag = String.fromCharCode(head[156] || 0x30);
    off += BLOCK;
    if (typeflag === "0" || typeflag === "\0") {
      out[full] = Buffer.from(buf.subarray(off, off + size));
    }
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  return out;
}
