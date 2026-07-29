// The platform evidence boundary: ONE place that decides what a run's bytes
// look like once they leave this machine.
//
// A run directory is the runner's own diagnostic record and stays exactly as
// core wrote it — the raw wdio error, the raw HAR, the local paths. Nothing here
// mutates it. What crosses to the platform is a SANITIZED COPY, and both routes
// that carry run bytes take it from here:
//
//   * the sealed `.ptrun` bundle, built from a staging tree so its index, sizes
//     and hashes describe the bytes actually sent rather than the bytes on
//     disk; and
//   * the live staging stream, entry by entry and line by line.
//
// One sanitizer for both is not tidiness, it is a correctness requirement: the
// platform verifies staged trajectory lines against the sealed bundle's and
// refuses the stream as `divergent` if they disagree. Same needles, same
// deterministic markers, same bytes.
//
// Classification is by what an entry IS (`artifactMediaType`, core's run
// vocabulary), never by where it lives: `steps/` holds screenshots and
// accessibility text side by side, and a screenshot must come out byte-for-byte
// identical. An entry the vocabulary does not name is decided by its own bytes —
// anything that is not valid UTF-8, or that holds a NUL, is treated as binary
// and left alone; everything else is sanitized, because an unrecognized text
// artifact is exactly where a secret would hide.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { artifactMediaType, isTextualMediaType } from "@playtest/core/artifacts";

export interface PlatformEvidence {
  /** A textual payload as the platform may receive it. */
  text(input: string): string;
  /** Are these bytes text this boundary rewrites, or a payload it leaves alone? */
  isTextual(rel: string, bytes: Buffer): boolean;
  /** One run-relative entry's bytes as the platform must receive them. */
  entry(rel: string, bytes: Buffer): Buffer;
  /**
   * A sanitized copy of `runDir`, ready to seal. The caller owns the returned
   * directory and removes it; the original is never touched.
   */
  stage(runDir: string): Promise<string>;
}

/** The sanitizer for one group, built from that group's composed redactor. */
export function platformEvidence(redact: (input: unknown) => string): PlatformEvidence {
  const text = (input: string): string => redact(input);

  const isTextual = (rel: string, bytes: Buffer): boolean => {
    const media = artifactMediaType(rel);
    if (media) return isTextualMediaType(media);
    return looksTextual(bytes);
  };

  const entry = (rel: string, bytes: Buffer): Buffer => {
    if (!isTextual(rel, bytes)) return bytes;
    const before = bytes.toString("utf8");
    const after = text(before);
    // An entry with nothing to mask keeps its own bytes, so a run that carries
    // no needle produces the byte-identical bundle it always did.
    return after === before ? bytes : Buffer.from(after, "utf8");
  };

  const stage = async (runDir: string): Promise<string> => {
    const root = path.resolve(runDir);
    const out = await fsp.mkdtemp(path.join(os.tmpdir(), "playtest-evidence-"));
    for (const rel of walkFiles(root)) {
      const from = path.join(root, ...rel.split("/"));
      const to = path.join(out, ...rel.split("/"));
      await fsp.mkdir(path.dirname(to), { recursive: true });
      const bytes = await fsp.readFile(from);
      const sanitized = entry(rel, bytes);
      // Binary payloads are hard-linked rather than copied: a debug-profile run
      // carries video and traces, and the seal reads the same bytes either way.
      if (sanitized === bytes && (await link(from, to))) continue;
      await fsp.writeFile(to, sanitized);
    }
    return out;
  };

  return { text, isTextual, entry, stage };
}

/** Hard-link when the filesystem allows it; the caller falls back to a copy. */
async function link(from: string, to: string): Promise<boolean> {
  try {
    await fsp.link(from, to);
    return true;
  } catch {
    return false; // a different device, or a filesystem without links
  }
}

/**
 * Every regular file under `root`, as sorted run-relative paths. Anything that
 * is neither a file nor a directory is refused rather than dropped, which is the
 * same answer the bundle writer gives: a run directory holding a symlink or a
 * device node is a run directory nobody can seal honestly.
 */
function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix = ""): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(path.join(dir, ent.name), rel);
      else if (ent.isFile()) out.push(rel);
      else throw new Error(`unsupported run artifact ${rel}: only regular files are bundleable`);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Do these bytes decode as text? A NUL byte or an invalid UTF-8 sequence is the
 * one reliable signal that rewriting them would corrupt a payload.
 */
function looksTextual(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  const decoded = bytes.toString("utf8");
  return Buffer.byteLength(decoded, "utf8") === bytes.length && !decoded.includes("�");
}
