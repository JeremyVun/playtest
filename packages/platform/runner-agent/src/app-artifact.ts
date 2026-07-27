// The environment app artifact, turned back into a file on this machine.
//
// The control plane stores the app under test content-addressed and a launch
// pins its hash (docs/contracts/hosted.md, "Environments, secrets, and target
// authentication"). This module is the other end: download the pinned bytes,
// prove they are the pinned bytes, and lay them out so core receives exactly
// what the engine contract already promises — `app:` as an absolute path to a
// binary on the local disk. Core never learns where it came from.
//
// An iOS `.app` is a DIRECTORY, so it can only travel zipped. Unpacking it is
// therefore part of materialization rather than a convenience: the file mode of
// the Mach-O executable and any framework symlinks have to survive the round
// trip, or `simctl install` puts a broken bundle on the simulator. That is why
// this reads the ZIP central directory itself instead of shelling out — no new
// dependency, and unix modes and symlinks are preserved deliberately rather
// than by luck.
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EXTRA_ZIP64 = 0x0001;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MADE_BY_UNIX = 3;
const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;
const UINT32_MAX = 0xffffffff;

interface ZipEntry {
  name: string;
  mode: number | null;
  isDirectory: boolean;
  isSymlink: boolean;
  data: Buffer;
}

/**
 * Fetch, verify and lay out this group's pinned app artifact.
 * @returns the absolute path core should see as `app:`.
 */
export async function materializeAppArtifact(
  { api, artifact, root }: RunnerDynamic,
): Promise<string> {
  const filename = safeName(artifact?.filename);
  const bytes = await api.bytes(`/runner/artifacts/${artifact.sha256}`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== artifact.sha256) {
    // Integrity is checked HERE, on the machine that will install it: a
    // corrupted or substituted object must stop the run with a sentence a
    // person can act on, never install a binary nobody chose.
    throw new Error(
      `the app artifact "${filename}" does not match the hash this run pinned ` +
        `(expected ${artifact.sha256.slice(0, 12)}, downloaded ${actual.slice(0, 12)}) — ` +
        `the stored object is corrupt; upload the build to the environment again and relaunch`,
    );
  }
  const dir = path.join(root, "app");
  await fsp.mkdir(dir, { recursive: true });
  if (!filename.toLowerCase().endsWith(".zip")) {
    const file = path.join(dir, filename);
    await fsp.writeFile(file, bytes);
    return file;
  }
  const unpacked = path.join(dir, "unpacked");
  await unzipInto(bytes, unpacked);
  return await pickUnpackedApp(unpacked);
}

/**
 * The bundle inside an unpacked archive. A zipped `.app` normally carries one
 * top-level directory, which IS the bundle; anything ambiguous falls back to the
 * unpack directory rather than guessing, so core reports a real path either way.
 */
async function pickUnpackedApp(dir: string): Promise<string> {
  const entries = (await fsp.readdir(dir)).filter((e) => e !== "__MACOSX" && e !== ".DS_Store");
  const bundle = entries.find((e) => /\.(app|apk|ipa|aab)$/i.test(e));
  if (bundle) return path.join(dir, bundle);
  if (entries.length === 1) return path.join(dir, entries[0]!); // SAFETY: length checked
  return dir;
}

/** Extract every entry of a ZIP buffer under `dest`, preserving modes and symlinks. */
export async function unzipInto(buf: Buffer, dest: string): Promise<void> {
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of readZipEntries(buf)) {
    // macOS `ditto` sequesters resource forks into __MACOSX/; they are not part
    // of the bundle and writing them back adds noise, not fidelity.
    if (entry.name.startsWith("__MACOSX/") || path.basename(entry.name) === ".DS_Store") continue;
    const abs = safeJoin(dest, entry.name);
    if (entry.isDirectory) {
      await fsp.mkdir(abs, { recursive: true });
      continue;
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (entry.isSymlink) {
      const target = entry.data.toString("utf8");
      // A link out of the bundle is either a mistake or an attack; either way it
      // is not something to recreate on the runner's disk.
      if (path.isAbsolute(target)) {
        throw new Error(`the app artifact contains an absolute symlink that escapes its own directory: ${entry.name} -> ${target}`);
      }
      safeJoin(dest, path.join(path.dirname(entry.name), target));
      await fsp.rm(abs, { force: true });
      await fsp.symlink(target, abs);
      continue;
    }
    await fsp.writeFile(abs, entry.data);
    // The executable bit is load-bearing for a `.app`: without it the installed
    // bundle has no runnable binary.
    if (entry.mode != null) await fsp.chmod(abs, entry.mode & 0o7777);
  }
}

/** Every entry of a ZIP archive, read through its central directory. */
function readZipEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === UINT32_MAX || count === 0xffff) {
    const locator = eocd - 20;
    if (locator < 0 || buf.readUInt32LE(locator) !== SIG_ZIP64_LOCATOR) {
      throw new Error("the app artifact is not a readable ZIP archive: its ZIP64 locator is missing");
    }
    const z64 = Number(buf.readBigUInt64LE(locator + 8));
    if (buf.readUInt32LE(z64) !== SIG_ZIP64_EOCD) {
      throw new Error("the app artifact is not a readable ZIP archive: its ZIP64 directory is missing");
    }
    count = Number(buf.readBigUInt64LE(z64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
  }

  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== SIG_CENTRAL) {
      throw new Error("the app artifact is not a readable ZIP archive: its central directory is malformed");
    }
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const method = buf.readUInt16LE(p + 10);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const externalAttr = buf.readUInt32LE(p + 38);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    let localOffset = buf.readUInt32LE(p + 42);
    if (csize === UINT32_MAX || usize === UINT32_MAX || localOffset === UINT32_MAX) {
      const z = readZip64Extra(buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
      let n = 0;
      if (usize === UINT32_MAX) usize = z[n++] ?? usize;
      if (csize === UINT32_MAX) csize = z[n++] ?? csize;
      if (localOffset === UINT32_MAX) localOffset = z[n++] ?? localOffset;
    }
    p += 46 + nameLen + extraLen + commentLen;

    // Only a UNIX-made archive carries a meaningful mode; anything else leaves
    // the default the filesystem gives us.
    const mode = madeBy === MADE_BY_UNIX ? externalAttr >>> 16 : null;
    const isDirectory = name.endsWith("/") || (mode != null && (mode & S_IFMT) === S_IFDIR);
    entries.push({
      name: name.replace(/\/+$/, ""),
      mode,
      isDirectory,
      isSymlink: mode != null && (mode & S_IFMT) === S_IFLNK,
      data: isDirectory ? Buffer.alloc(0) : readLocalData(buf, localOffset, method, csize, usize),
    });
  }
  return entries;
}

function readLocalData(buf: Buffer, offset: number, method: number, csize: number, usize: number): Buffer {
  if (buf.readUInt32LE(offset) !== SIG_LOCAL) {
    throw new Error("the app artifact is not a readable ZIP archive: a local file header is missing");
  }
  // The local header's own name/extra lengths — they may legitimately differ
  // from the central directory's, so they cannot be reused from there.
  const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
  const raw = buf.subarray(start, start + csize);
  if (method === METHOD_STORE) return Buffer.from(raw);
  if (method === METHOD_DEFLATE) return zlib.inflateRawSync(raw, { maxOutputLength: Math.max(usize, 1) });
  throw new Error(`the app artifact uses unsupported ZIP compression method ${method} (expected store or deflate)`);
}

function readZip64Extra(extra: Buffer): number[] {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const size = extra.readUInt16LE(p + 2);
    if (id === EXTRA_ZIP64) {
      const out: number[] = [];
      for (let q = p + 4; q + 8 <= p + 4 + size; q += 8) out.push(Number(extra.readBigUInt64LE(q)));
      return out;
    }
    p += 4 + size;
  }
  return [];
}

function findEocd(buf: Buffer): number {
  // The comment may be up to 64 KiB, so scan backwards over that window only.
  const from = Math.max(0, buf.length - (22 + 0xffff));
  for (let i = buf.length - 22; i >= from; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error("the app artifact is not a ZIP archive (no end-of-central-directory record) — an iOS .app must be uploaded zipped");
}

function safeJoin(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`the app artifact contains an entry that escapes its own directory: ${rel}`);
  }
  return abs;
}

/** A plain base name, never a traversal — the server validates this too, and
 *  neither end gets to be the only one that does. */
function safeName(name: unknown): string {
  const clean = String(name ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);
  return /^\.+$/.test(clean) || !clean ? "app" : clean;
}
