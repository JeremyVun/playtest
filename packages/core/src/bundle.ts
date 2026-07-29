// .ptrun bundle codec for serialized run directories.
// Contract: docs/contracts/artifacts.md#ptrun-format.
import { sha256Hex } from "./hash.ts";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import zlib from "node:zlib";

export interface ReadRange {
  (start: number, end: number): Buffer;
  size: number;
  path?: string;
}

export interface BundleIndexEntry {
  offset: number;
  csize: number;
  usize: number;
  method: number;
  crc32: string;
}

export interface BundleIndex {
  ptrun_version: number;
  bundle_sha256: string;
  bundle_size: number;
  entries: Record<string, BundleIndexEntry>;
}

interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  usize: number;
  body: Buffer;
}

interface ArtifactEntry extends ZipEntry {
  path: string;
  size: number;
  crc32: string;
  sha256: string;
}

interface PtrunEntry {
  path: string;
  size: number;
  crc32: string;
  sha256: string;
}

interface PtrunMetadata {
  ptrun_version: number;
  run_id: string | null;
  case_id: string | null;
  created_at: string;
  tier: string;
  entries: PtrunEntry[];
  totals: { count: number; bytes: number };
  source: Record<string, unknown>;
  [key: string]: unknown;
}

interface BundleManifest {
  finished_at?: string;
  started_at?: string;
  run_id?: string;
  case?: { id?: string };
  pins?: { harness_version?: string };
}

type KeepPaths = ((rel: string) => boolean) | Iterable<string>;
type DirectoryEntry = { name: string; isFile: boolean; isDirectory: boolean };
interface BundleProviderOptions {
  readRange: ReadRange;
  index?: BundleIndex | null;
  size?: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const EXTRA_ZIP64 = 0x0001;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;
const EOCD_MAX = 22 + UINT16_MAX;
const EPOCH = "1970-01-01T00:00:00.000Z";

const STORE_RE = /^(video|clip)\.[^.]+$|\.png$|^trace\.zip$/;
const DEFLATE_RE = /\.(json|jsonl|txt|vtt|mhtml)$/;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function isBundlePath(file: unknown): boolean {
  return String(file).endsWith(".ptrun");
}

/**
 * What a run-directory entry IS, as a media type
 * (docs/contracts/artifacts.md#run-directory). One vocabulary, so a consumer
 * deciding "may I rewrite these bytes?" never has to guess from where the entry
 * lives: `steps/` holds both screenshots and accessibility text, and only the
 * entry itself says which is which.
 *
 * `null` means the run vocabulary does not name this entry. A caller decides
 * what to do with an unknown — this function does not guess.
 */
export function artifactMediaType(rel: string): string | null {
  const ext = path.extname(String(rel)).toLowerCase();
  return ARTIFACT_MEDIA_TYPES[ext] ?? null;
}

/**
 * A stageable step-artifact path — one entry directly under `steps/`, the shape
 * both live-staging peers accept (docs/contracts/hosted.md "Live staging
 * routes"): the runner's uploader decides what to ship with it, and the control
 * plane's ingest decides what to store with it, so the vocabulary lives here
 * rather than drifting as two copies. Traversal, absolute paths, nested
 * directories and dot-files all fail the shape rather than being sanitized.
 */
const STEP_ENTRY_SHAPE = /^steps\/[0-9A-Za-z][0-9A-Za-z._-]{0,119}$/;

export function isStepEntryPath(entry: unknown): boolean {
  if (typeof entry !== "string" || !STEP_ENTRY_SHAPE.test(entry)) return false;
  return !entry.split("/").some((seg) => seg === "." || seg === "..");
}

/** Is this media type text a reader (or a redactor) may treat as characters? */
export function isTextualMediaType(mediaType: string | null | undefined): boolean {
  if (!mediaType) return false;
  const type = mediaType.replace(/;.*$/, "").trim();
  return type.startsWith("text/") || TEXTUAL_MEDIA_TYPES.has(type) || type.endsWith("+json") || type.endsWith("+xml");
}

const ARTIFACT_MEDIA_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".txt": "text/plain; charset=utf-8",
  ".vtt": "text/vtt",
  ".mhtml": "multipart/related",
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".zip": "application/zip",
};

const TEXTUAL_MEDIA_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/javascript",
  "multipart/related",
]);

/**
 * The `core` RETENTION tier's keep filter — what survives when a finished
 * bundle is aged down (docs/contracts/hosted.md#retention). Not to be confused
 * with the `artifacts: core` RECORDING profile
 * (docs/contracts/artifacts.md#artifact-profiles), which decides what a run
 * writes in the first place. They are deliberately different sets and compose
 * one way: this tier is strictly smaller (it also drops screenshots, video, and
 * HAR), so a core-profile run tiered to core loses exactly what a debug-profile
 * one does. Being a filter, it needs no change when an artifact was never
 * recorded — an absent path simply never appears.
 */
export function coreBundleKeepPath(rel: string): boolean {
  return (
    rel === "manifest.json" ||
    rel === "trajectory.jsonl" ||
    rel === "grade.json" ||
    // The heal's drift report: the whole point of a "core" bundle is that a
    // reviewer can decide about a changed journey from it, and on an API heal
    // that decision is exactly what this file explains.
    rel === "drift-report.json" ||
    rel === "video.vtt" ||
    /^steps\/[^/]+\.a11y\.txt$/.test(rel)
  );
}

export function writeBundle(
  runDir: string,
  outPath: string,
  { tier = "full", source = null }: { tier?: string; source?: Record<string, unknown> | null } = {}
) {
  const root = path.resolve(runDir);
  const files = walkFiles(root);
  const manifest = readManifest(root);
  const artifactEntries = files.map((rel) => makeFileEntry(root, rel));
  const ptrun = buildPtrun(manifest, artifactEntries, { tier, source });
  const ptrunData = Buffer.from(JSON.stringify(ptrun, null, 2) + "\n");
  const entries = [
    makeBufferedEntry("ptrun.json", ptrunData, METHOD_STORE),
    ...artifactEntries,
  ];
  return writeZipToFile(entries, outPath);
}

export function rewriteBundle(
  srcPath: string,
  outPath: string,
  keepPaths: KeepPaths = coreBundleKeepPath
) {
  const source = bundleSourceFromFile(srcPath);
  const ptrun: PtrunMetadata = JSON.parse(readEntryBuffer(source.readRange, source.index.entries["ptrun.json"]).toString("utf8"));
  const keep = keepPredicate(keepPaths);
  const oldEntries = new Map((ptrun.entries ?? []).map((e): [string, PtrunEntry] => [e.path, e]));
  const kept = Object.keys(source.index.entries)
    .filter((name) => name !== "ptrun.json" && keep(name))
    .sort()
    .map((name) => {
      const idx = source.index.entries[name]!; // SAFETY: name comes from Object.keys on this entries object
      const raw = source.readRange(idx.offset, idx.offset + idx.csize - 1);
      return {
        name,
        method: idx.method,
        crc: Number.parseInt(idx.crc32, 16) >>> 0,
        usize: idx.usize,
        body: raw,
        sha256: oldEntries.get(name)?.sha256 ?? sha256Hex(readEntryBuffer(source.readRange, idx)),
      };
    });
  const nextPtrun = {
    ...ptrun,
    tier: "core",
    entries: kept.map((e) => ({
      path: e.name,
      size: e.usize,
      crc32: hex32(e.crc),
      sha256: e.sha256,
    })),
    totals: { count: kept.length, bytes: kept.reduce((n, e) => n + e.usize, 0) },
  };
  const ptrunData = Buffer.from(JSON.stringify(nextPtrun, null, 2) + "\n");
  return writeZipToFile([
    makeBufferedEntry("ptrun.json", ptrunData, METHOD_STORE),
    ...kept,
  ], outPath);
}

export function rebuildIndex(readRange: ReadRange, size = readRange.size): BundleIndex {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("bundle size is required to rebuild the index");
  const tailStart = Math.max(0, size - EOCD_MAX);
  const tail = readRange(tailStart, size - 1);
  const eocdInTail = findEocd(tail);
  if (eocdInTail < 0) throw new Error("invalid .ptrun: ZIP end-of-central-directory not found");
  const eocdAbs = tailStart + eocdInTail;
  const eocd = tail.subarray(eocdInTail, eocdInTail + 22);
  let count = eocd.readUInt16LE(10);
  let cdSize = eocd.readUInt32LE(12);
  let cdOffset = eocd.readUInt32LE(16);
  if (count === UINT16_MAX || cdSize === UINT32_MAX || cdOffset === UINT32_MAX) {
    const locator = readRange(eocdAbs - 20, eocdAbs - 1);
    if (locator.readUInt32LE(0) !== SIG_ZIP64_LOCATOR) throw new Error("invalid .ptrun: ZIP64 locator missing");
    const zip64Offset = readUInt64(locator, 8);
    const zip64 = readRange(zip64Offset, zip64Offset + 55);
    if (zip64.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new Error("invalid .ptrun: ZIP64 central directory missing");
    count = readUInt64(zip64, 32);
    cdSize = readUInt64(zip64, 40);
    cdOffset = readUInt64(zip64, 48);
  }
  const central = readRange(cdOffset, cdOffset + cdSize - 1);
  let cursor = 0;
  const entries: Record<string, BundleIndexEntry> = {};
  for (let i = 0; i < count; i++) {
    if (central.readUInt32LE(cursor) !== SIG_CENTRAL) throw new Error("invalid .ptrun: central directory entry corrupt");
    const flags = central.readUInt16LE(cursor + 8);
    const method = central.readUInt16LE(cursor + 10);
    const crc = central.readUInt32LE(cursor + 16);
    let csize = central.readUInt32LE(cursor + 20);
    let usize = central.readUInt32LE(cursor + 24);
    const nameLen = central.readUInt16LE(cursor + 28);
    const extraLen = central.readUInt16LE(cursor + 30);
    const commentLen = central.readUInt16LE(cursor + 32);
    let localOffset = central.readUInt32LE(cursor + 42);
    const name = central.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");
    const extra = central.subarray(cursor + 46 + nameLen, cursor + 46 + nameLen + extraLen);
    if (flags & 1) throw new Error(`invalid .ptrun: encrypted entry ${name} is not supported`);
    if (method !== METHOD_STORE && method !== METHOD_DEFLATE) throw new Error(`invalid .ptrun: unsupported method ${method} for ${name}`);
    ({ usize, csize, localOffset } = applyZip64Extra({ usize, csize, localOffset }, extra));
    validateEntryName(name);
    if (!name.endsWith("/")) {
      const local = readRange(localOffset, localOffset + 29);
      if (local.readUInt32LE(0) !== SIG_LOCAL) throw new Error(`invalid .ptrun: local header missing for ${name}`);
      const localNameLen = local.readUInt16LE(26);
      const localExtraLen = local.readUInt16LE(28);
      entries[name] = {
        offset: localOffset + 30 + localNameLen + localExtraLen,
        csize,
        usize,
        method,
        crc32: hex32(crc),
      };
    }
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return {
    ptrun_version: 1,
    bundle_sha256: sha256Hex(readRange(0, size - 1)),
    bundle_size: size,
    entries,
  };
}

export class BundleProvider {
  declare readRange: ReadRange;
  declare index: BundleIndex;
  declare entries: Record<string, BundleIndexEntry>;
  declare mtime: Date;

  constructor({
    readRange,
    index = null,
    size = readRange.size
  }: BundleProviderOptions = {} as BundleProviderOptions) { // SAFETY: the runtime guard preserves the historical missing-readRange error
    if (typeof readRange !== "function") throw new Error("BundleProvider requires readRange(start, end)");
    this.readRange = readRange;
    this.index = index ?? rebuildIndex(readRange, size);
    this.entries = this.index.entries ?? {};
    this.mtime = this.#createdAt();
  }

  static fromFile(file: string): BundleProvider {
    const source = bundleSourceFromFile(file);
    return new BundleProvider(source);
  }

  listDir(rel: unknown): DirectoryEntry[] | null {
    const dir = providerRel(rel);
    if (dir === null) return null;
    const prefix = dir ? `${dir}/` : "";
    const seen = new Map<string, DirectoryEntry>();
    for (const name of Object.keys(this.entries)) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        seen.set(rest, { name: rest, isFile: true, isDirectory: false });
      } else {
        const child = rest.slice(0, slash);
        seen.set(child, { name: child, isFile: false, isDirectory: true });
      }
    }
    if (dir && !seen.size && !Object.keys(this.entries).some((name) => name.startsWith(prefix))) return null;
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  readText(rel: unknown): string | null {
    try {
      const entry = this.#entry(rel);
      if (!entry) return null;
      return readEntryBuffer(this.readRange, entry).toString("utf8");
    } catch {
      return null;
    }
  }

  stat(rel: unknown): { size: number; mtime: Date; isFile: true } | null {
    const entry = this.#entry(rel);
    if (!entry) return null;
    return { size: entry.usize, mtime: this.mtime, isFile: true };
  }

  createReadStream(
    rel: unknown,
    opts: { start?: number; end?: number } = {}
  ): Readable {
    try {
      const entry = this.#entry(rel);
      if (!entry) return Readable.from(Buffer.alloc(0));
      const start = Math.max(0, opts.start ?? 0);
      const end = Math.min(opts.end ?? entry.usize - 1, entry.usize - 1);
      if (entry.usize === 0 || start > end) return Readable.from(Buffer.alloc(0));
      if (entry.method === METHOD_STORE) {
        return Readable.from(this.readRange(entry.offset + start, entry.offset + end));
      }
      return Readable.from(readEntryBuffer(this.readRange, entry).subarray(start, end + 1));
    } catch (e) {
      // @ts-expect-error -- Node accepts a rejected Promise although @types/node omits it from Readable.from's input union.
      return Readable.from(Promise.reject(e));
    }
  }

  #entry(rel: unknown): BundleIndexEntry | null {
    const name = providerRel(rel);
    return name === null ? null : this.entries[name] ?? null;
  }

  #createdAt(): Date {
    try {
      const ptrun = JSON.parse(readEntryBuffer(this.readRange, this.entries["ptrun.json"]).toString("utf8"));
      const d = new Date(ptrun.created_at);
      if (!Number.isNaN(d.valueOf())) return d;
    } catch {}
    return new Date(0);
  }
}

export function fileReadRange(file: string): ReadRange {
  const abs = path.resolve(file);
  const size = fs.statSync(abs).size;
  const readRange: ReadRange = (start: number, end: number) => {
    if (size === 0) return Buffer.alloc(0);
    const s = Math.max(0, Number(start));
    const e = Math.min(Number(end), size - 1);
    if (!Number.isSafeInteger(s) || !Number.isSafeInteger(e) || s > e) return Buffer.alloc(0);
    const len = e - s + 1;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(abs, "r");
    try {
      fs.readSync(fd, buf, 0, len, s);
    } finally {
      fs.closeSync(fd);
    }
    return buf;
  };
  readRange.size = size;
  readRange.path = abs;
  return readRange;
}

function bundleSourceFromFile(
  file: string
): { readRange: ReadRange; index: BundleIndex; size: number } {
  const readRange = fileReadRange(file);
  const sidecar = `${path.resolve(file)}.idx.json`;
  const index = loadUsableSidecar(sidecar, readRange) ?? rebuildIndex(readRange);
  writeIndexSidecar(sidecar, index);
  return { readRange, index, size: readRange.size };
}

function loadUsableSidecar(sidecar: string, readRange: ReadRange): BundleIndex | null {
  try {
    const index = JSON.parse(fs.readFileSync(sidecar, "utf8"));
    if (index.ptrun_version !== 1 || index.bundle_size !== readRange.size) return null;
    const current = sha256Hex(readRange(0, readRange.size - 1));
    return index.bundle_sha256 === current ? index : null;
  } catch {
    return null;
  }
}

function writeZipToFile(
  entries: ZipEntry[],
  outPath: string
): { sha256: string; size: number; index: BundleIndex } {
  const { buffer, entries: indexEntries } = buildZip(entries);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, buffer);
  const index = {
    ptrun_version: 1,
    bundle_sha256: sha256Hex(buffer),
    bundle_size: buffer.length,
    entries: indexEntries,
  };
  writeIndexSidecar(`${path.resolve(outPath)}.idx.json`, index);
  return { sha256: index.bundle_sha256, size: index.bundle_size, index };
}

function buildZip(
  entries: ZipEntry[]
): { buffer: Buffer; entries: Record<string, BundleIndexEntry> } {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  const indexEntries: Record<string, BundleIndexEntry> = {};
  let cursor = 0;
  for (const entry of entries) {
    validateEntryName(entry.name);
    const localOffset = cursor;
    const local = localHeader(entry);
    const dataOffset = localOffset + local.length;
    chunks.push(local, entry.body);
    cursor += local.length + entry.body.length;
    indexEntries[entry.name] = {
      offset: dataOffset,
      csize: entry.body.length,
      usize: entry.usize,
      method: entry.method,
      crc32: hex32(entry.crc),
    };
    central.push(centralHeader(entry, localOffset));
  }
  const cdOffset = cursor;
  const cd = Buffer.concat(central);
  chunks.push(cd);
  cursor += cd.length;
  const needsZip64 = entries.length > UINT16_MAX || cd.length > UINT32_MAX || cdOffset > UINT32_MAX;
  if (needsZip64) {
    chunks.push(zip64Eocd(entries.length, cd.length, cdOffset));
    chunks.push(zip64Locator(cursor));
    cursor += 76;
  }
  chunks.push(eocd(entries.length, cd.length, cdOffset, needsZip64));
  return { buffer: Buffer.concat(chunks), entries: indexEntries };
}

function localHeader(entry: ZipEntry): Buffer {
  const name = Buffer.from(entry.name);
  const zip64 = entry.usize > UINT32_MAX || entry.body.length > UINT32_MAX;
  const extra = zip64 ? zip64Extra([entry.usize, entry.body.length]) : Buffer.alloc(0);
  const buf = Buffer.alloc(30 + name.length + extra.length);
  buf.writeUInt32LE(SIG_LOCAL, 0);
  buf.writeUInt16LE(zip64 ? 45 : 20, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(entry.method, 8);
  buf.writeUInt16LE(0, 10);
  buf.writeUInt16LE(0, 12);
  buf.writeUInt32LE(entry.crc, 14);
  buf.writeUInt32LE(zip64 ? UINT32_MAX : entry.body.length, 18);
  buf.writeUInt32LE(zip64 ? UINT32_MAX : entry.usize, 22);
  buf.writeUInt16LE(name.length, 26);
  buf.writeUInt16LE(extra.length, 28);
  name.copy(buf, 30);
  extra.copy(buf, 30 + name.length);
  return buf;
}

function centralHeader(entry: ZipEntry, localOffset: number): Buffer {
  const name = Buffer.from(entry.name);
  const size64 = entry.usize > UINT32_MAX || entry.body.length > UINT32_MAX;
  const offset64 = localOffset > UINT32_MAX;
  const extra = zip64Extra([
    ...(entry.usize > UINT32_MAX ? [entry.usize] : []),
    ...(entry.body.length > UINT32_MAX ? [entry.body.length] : []),
    ...(offset64 ? [localOffset] : []),
  ]);
  const zip64 = size64 || offset64;
  const buf = Buffer.alloc(46 + name.length + extra.length);
  buf.writeUInt32LE(SIG_CENTRAL, 0);
  buf.writeUInt16LE(zip64 ? 45 : 20, 4);
  buf.writeUInt16LE(zip64 ? 45 : 20, 6);
  buf.writeUInt16LE(0, 8);
  buf.writeUInt16LE(entry.method, 10);
  buf.writeUInt16LE(0, 12);
  buf.writeUInt16LE(0, 14);
  buf.writeUInt32LE(entry.crc, 16);
  buf.writeUInt32LE(entry.body.length > UINT32_MAX ? UINT32_MAX : entry.body.length, 20);
  buf.writeUInt32LE(entry.usize > UINT32_MAX ? UINT32_MAX : entry.usize, 24);
  buf.writeUInt16LE(name.length, 28);
  buf.writeUInt16LE(extra.length, 30);
  buf.writeUInt16LE(0, 32);
  buf.writeUInt16LE(0, 34);
  buf.writeUInt16LE(0, 36);
  buf.writeUInt32LE(0, 38);
  buf.writeUInt32LE(offset64 ? UINT32_MAX : localOffset, 42);
  name.copy(buf, 46);
  extra.copy(buf, 46 + name.length);
  return buf;
}

function eocd(count: number, cdSize: number, cdOffset: number, zip64: boolean): Buffer {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(SIG_EOCD, 0);
  buf.writeUInt16LE(0, 4);
  buf.writeUInt16LE(0, 6);
  buf.writeUInt16LE(zip64 ? UINT16_MAX : count, 8);
  buf.writeUInt16LE(zip64 ? UINT16_MAX : count, 10);
  buf.writeUInt32LE(zip64 ? UINT32_MAX : cdSize, 12);
  buf.writeUInt32LE(zip64 ? UINT32_MAX : cdOffset, 16);
  buf.writeUInt16LE(0, 20);
  return buf;
}

function zip64Eocd(count: number, cdSize: number, cdOffset: number): Buffer {
  const buf = Buffer.alloc(56);
  buf.writeUInt32LE(SIG_ZIP64_EOCD, 0);
  writeUInt64(buf, 44, 4);
  buf.writeUInt16LE(45, 12);
  buf.writeUInt16LE(45, 14);
  buf.writeUInt32LE(0, 16);
  buf.writeUInt32LE(0, 20);
  writeUInt64(buf, count, 24);
  writeUInt64(buf, count, 32);
  writeUInt64(buf, cdSize, 40);
  writeUInt64(buf, cdOffset, 48);
  return buf;
}

function zip64Locator(zip64EocdOffset: number): Buffer {
  const buf = Buffer.alloc(20);
  buf.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
  buf.writeUInt32LE(0, 4);
  writeUInt64(buf, zip64EocdOffset, 8);
  buf.writeUInt32LE(1, 16);
  return buf;
}

function zip64Extra(values: number[]): Buffer {
  if (!values.length) return Buffer.alloc(0);
  const buf = Buffer.alloc(4 + values.length * 8);
  buf.writeUInt16LE(EXTRA_ZIP64, 0);
  buf.writeUInt16LE(values.length * 8, 2);
  values.forEach((v, i) => writeUInt64(buf, v, 4 + i * 8));
  return buf;
}

function applyZip64Extra(
  fields: { usize: number; csize: number; localOffset: number },
  extra: Buffer
): { usize: number; csize: number; localOffset: number } {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const len = extra.readUInt16LE(pos + 2);
    pos += 4;
    if (id === EXTRA_ZIP64) {
      let z = pos;
      const readNext = () => {
        const v = readUInt64(extra, z);
        z += 8;
        return v;
      };
      return {
        usize: fields.usize === UINT32_MAX ? readNext() : fields.usize,
        csize: fields.csize === UINT32_MAX ? readNext() : fields.csize,
        localOffset: fields.localOffset === UINT32_MAX ? readNext() : fields.localOffset,
      };
    }
    pos += len;
  }
  return fields;
}

function makeFileEntry(root: string, rel: string): ArtifactEntry {
  const data = fs.readFileSync(path.join(root, ...rel.split("/")));
  const method = methodFor(rel);
  const body = method === METHOD_DEFLATE ? zlib.deflateRawSync(data, { level: 9 }) : data;
  return {
    name: rel,
    path: rel,
    size: data.length,
    method,
    crc: crc32(data),
    crc32: hex32(crc32(data)),
    sha256: sha256Hex(data),
    usize: data.length,
    body,
  };
}

function makeBufferedEntry(name: string, data: Buffer, method: number): ZipEntry {
  const body = method === METHOD_DEFLATE ? zlib.deflateRawSync(data, { level: 9 }) : data;
  return { name, method, crc: crc32(data), usize: data.length, body };
}

function buildPtrun(
  manifest: BundleManifest,
  entries: ArtifactEntry[],
  { tier, source }: { tier: string; source: Record<string, unknown> | null }
): PtrunMetadata {
  const createdAt = manifest.finished_at ?? manifest.started_at ?? EPOCH;
  const src = source ?? (manifest.pins?.harness_version ? { harness_version: manifest.pins.harness_version } : {});
  return {
    ptrun_version: 1,
    run_id: manifest.run_id ?? null,
    case_id: manifest.case?.id ?? null,
    created_at: createdAt,
    tier,
    entries: entries.map((e) => ({ path: e.path, size: e.size, crc32: e.crc32, sha256: e.sha256 })),
    totals: { count: entries.length, bytes: entries.reduce((n, e) => n + e.size, 0) },
    source: src,
  };
}

function readManifest(root: string): BundleManifest {
  const file = path.join(root, "manifest.json");
  if (!fs.existsSync(file)) throw new Error(`${root} is not a run directory (no manifest.json)`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix = ""): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(abs, rel);
      } else if (ent.isFile()) {
        if (rel === "ptrun.json") throw new Error("run directory may not contain reserved ptrun.json");
        validateEntryName(rel);
        out.push(rel);
      } else {
        throw new Error(`unsupported run artifact ${rel}: only regular files are bundleable`);
      }
    }
  };
  walk(root);
  return out.sort();
}

function methodFor(rel: string): number {
  if (rel === "ptrun.json" || STORE_RE.test(rel)) return METHOD_STORE;
  if (DEFLATE_RE.test(rel)) return METHOD_DEFLATE;
  return METHOD_STORE;
}

function readEntryBuffer(readRange: ReadRange, entry: BundleIndexEntry | undefined): Buffer {
  if (!entry) throw new Error("bundle entry missing");
  const raw = readRange(entry.offset, entry.offset + entry.csize - 1);
  if (entry.method === METHOD_STORE) return raw;
  if (entry.method === METHOD_DEFLATE) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported ZIP method ${entry.method}`);
}

function writeIndexSidecar(sidecar: string, index: BundleIndex): void {
  fs.mkdirSync(path.dirname(sidecar), { recursive: true });
  fs.writeFileSync(sidecar, JSON.stringify(index, null, 2) + "\n");
}

function keepPredicate(keepPaths: KeepPaths): (rel: string) => boolean {
  if (typeof keepPaths === "function") return keepPaths;
  const set = new Set([...keepPaths].map((p) => String(p).replaceAll(path.sep, "/")));
  return (p: string) => set.has(p);
}

function providerRel(rel: unknown): string | null {
  const text = String(rel ?? "").replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!text || text === ".") return "";
  if (text.split("/").some((p) => !p || p === "." || p === "..")) return null;
  return text;
}

function validateEntryName(name: string): void {
  if (
    !name ||
    name.startsWith("/") ||
    name.startsWith("./") ||
    name.includes("\\") ||
    name.split("/").some((p) => !p || p === "." || p === "..") ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new Error(`invalid bundle entry path: ${name}`);
  }
}

function findEocd(tail: Buffer): number {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== SIG_EOCD) continue;
    const commentLen = tail.readUInt16LE(i + 20);
    if (i + 22 + commentLen === tail.length) return i;
  }
  return -1;
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8); // SAFETY: masking to one byte bounds the lookup to the 256-entry table
  return (crc ^ 0xffffffff) >>> 0;
}

function hex32(n: number): string {
  return (n >>> 0).toString(16).padStart(8, "0");
}

function writeUInt64(buf: Buffer, value: number, offset: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`ZIP64 value is outside JavaScript's safe integer range: ${value}`);
  buf.writeBigUInt64LE(BigInt(value), offset);
}

function readUInt64(buf: Buffer, offset: number): number {
  const value = buf.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ZIP64 value is outside JavaScript's safe integer range");
  return Number(value);
}
