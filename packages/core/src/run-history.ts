import fs from "node:fs";
import path from "node:path";

export interface RunManifest {
  run_id?: string | null;
  started_at?: string | null;
  mode?: string | null;
  healed?: boolean;
  duration_ms?: number | null;
  case?: {
    id?: string;
  };
  result?: {
    status?: string | null;
  };
  totals?: {
    steps?: number | null;
    lcp_ms?: number | null;
  };
  pins?: Record<string, unknown> | null;
}

export interface RunHistoryEntry {
  run_id: string | null;
  started_at: string | null;
  status: string | null;
  mode: string | null;
  healed: boolean;
  duration_ms: number | null;
  steps: number | null;
  score: number | null;
  lcp_ms: number | null;
  pins: Record<string, unknown> | null;
  [key: string]: unknown;
}

/** All run dirs under a runs root: every manifest.json at any depth (bounded). */
export function findManifests(root: string, maxDepth = 6): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.isFile() && entry.name === "manifest.json")) {
      out.push(dir);
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "steps") {
        walk(path.join(dir, entry.name), depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

/** Direct-fs JSON read: null on a missing or unparseable file. */
export function readJsonFile<T = RunManifest>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Project a run manifest into the stable history shape used by analysis and viewers. */
export function manifestToHistoryEntry(
  manifest: RunManifest,
  score: number | null = null,
  extra: Record<string, unknown> = {}
): RunHistoryEntry {
  return {
    run_id: manifest.run_id ?? null,
    started_at: manifest.started_at ?? null,
    status: manifest.result?.status ?? null,
    mode: manifest.mode ?? null,
    healed: manifest.healed ?? false,
    duration_ms: manifest.duration_ms ?? null,
    steps: manifest.totals?.steps ?? null,
    score: score ?? null,
    lcp_ms: manifest.totals?.lcp_ms ?? null,
    pins: manifest.pins ?? null,
    ...extra,
  };
}
