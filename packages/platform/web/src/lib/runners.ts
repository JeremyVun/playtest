// Self-hosted runner helpers, kept DOM-free so the offline gate can assert the
// two things that matter about this surface without a browser: the exact
// command a person pastes, and that the credential is genuinely a one-time
// reveal rather than something the page can show twice.

export interface RunnerStartCommand {
  server: string;
  credential: string;
  labels?: string[];
  isolation?: string | null;
}

/**
 * The one line a person pastes into a terminal on the machine that can reach
 * the target. Two rules it exists to keep:
 *
 *   - the credential rides the ENVIRONMENT, never an argument, so it cannot be
 *     read out of `ps` by anyone else on that machine;
 *   - it runs from a Playtest checkout with no install step of its own —
 *     `node_modules/.bin/runner-agent` is there after `npm install`.
 */
export function startCommand({ server, credential, labels = [], isolation = null }: RunnerStartCommand): string {
  const parts = ["./node_modules/.bin/runner-agent", "pool", "--server", trimSlash(server)];
  if (labels.length) parts.push("--labels", labels.join(","));
  if (isolation) parts.push("--isolation", isolation);
  return `PLAYTEST_RUNNER_CREDENTIAL='${credential}' ${parts.join(" ")}`;
}

const trimSlash = (url: string) => String(url || "").replace(/\/+$/, "");

/** Mirrors the server's single label validator (`normalizeLabels`). */
const LABEL_CHARSET = /^[A-Za-z0-9._-]+$/;
const MAX_LABELS = 32;
const MAX_LABEL_LENGTH = 64;

/**
 * What is wrong with this label list, said under the field that typed it rather
 * than after a round trip. The charset is narrow for two concrete reasons the
 * message does not need to spell out: a comma inside a label would split into
 * two on the agent's `--labels`, and these labels are interpolated into the
 * start command a person pastes into a shell.
 */
export function labelProblem(labels: string[]): string | null {
  const bad = labels.find((l) => !LABEL_CHARSET.test(l));
  if (bad !== undefined) {
    return `“${bad}” can't be a label — use only letters, digits, “.”, “_” and “-”, as in ios-sim.`;
  }
  if (labels.length > MAX_LABELS) return `A runner advertises at most ${MAX_LABELS} labels.`;
  if (labels.some((l) => l.length > MAX_LABEL_LENGTH)) return `A label is at most ${MAX_LABEL_LENGTH} characters.`;
  return null;
}

/** A comma-separated label field, as the claim board reads it. */
export const parseLabels = (raw: string): string[] =>
  [...new Set(String(raw || "").split(",").map((l) => l.trim()).filter(Boolean))];

/**
 * A value that can be read exactly once. The credential is minted once and
 * stored hashed — the server cannot show it again — so the console must not
 * either: a re-render, a reopened dialog or a back button gets null, and the
 * copy says to register again rather than pretending the secret is retrievable.
 */
export function oneShot<T>(value: T): { take: () => T | null; spent: () => boolean } {
  let held: T | null = value;
  return {
    take: () => {
      const out = held;
      held = null;
      return out;
    },
    spent: () => held === null,
  };
}

/** What a listed runner reads as. Never carries a credential: the list has none. */
export function runnerLabelsText(labels: string[] | null | undefined): string {
  return labels && labels.length ? labels.join(", ") : "any job in this project";
}

// ---------- presence ----------

export interface RunnerRow {
  id?: string;
  name?: string;
  labels?: string[] | null;
  last_seen_at?: string | null;
  revoked_at?: string | null;
  expires_at?: string | null;
  claim?: { run_group_id?: string | null; kind?: string; claimed_at?: string | null } | null;
}

export interface RunnerPresence {
  state: "revoked" | "expired" | "working" | "online" | "offline" | "never";
  /** The word on the row. Never a colour alone. */
  label: string;
  /** Why, in a sentence a person can act on. */
  detail: string;
  /** Presence-dot tone: on (here), busy (here, working), off (not here). */
  tone: "on" | "busy" | "off";
}

/**
 * Is this runner here right now, and how do we know?
 *
 * Honestly, from one number the server publishes and the client does not
 * invent: `capabilities.runner_check_in_window_s`, the same silence at which
 * the platform itself stops believing in a runner. A runner checks in by
 * polling the board (every 25 s while idle) or by heartbeating its claim (while
 * busy), and both stamp `last_seen_at` — so "online" is arithmetic on a
 * timestamp, never a request this page makes. That is what lets the section
 * repaint on the feed's edges and still go quiet on its own when a laptop lid
 * closes and nothing tells anybody.
 */
export function runnerPresence(
  runner: RunnerRow,
  { now = Date.now(), windowS = 120 }: { now?: number; windowS?: number } = {},
): RunnerPresence {
  if (runner.revoked_at) {
    return { state: "revoked", label: "revoked", tone: "off", detail: "its credential no longer works" };
  }
  if (runner.expires_at && new Date(runner.expires_at).getTime() <= now) {
    return { state: "expired", label: "expired", tone: "off", detail: "this registration has run out" };
  }
  if (!runner.last_seen_at) {
    return {
      state: "never",
      label: "never started",
      tone: "off",
      detail: "it has not checked in yet — run the start command on that machine",
    };
  }
  const silentMs = now - new Date(runner.last_seen_at).getTime();
  if (silentMs > windowS * 1000) {
    return {
      state: "offline",
      label: "offline",
      tone: "off",
      // The window is stated so "offline" reads as a measurement rather than a
      // verdict: a runner is not gone, it simply has not been heard from.
      detail: `nothing heard for over ${Math.round(windowS / 60) >= 1 ? `${Math.round(windowS / 60)} min` : `${windowS}s`} — is the runner process still running?`,
    };
  }
  if (runner.claim) {
    return { state: "working", label: "running a job", tone: "busy", detail: "it is executing a run right now" };
  }
  return { state: "online", label: "online", tone: "on", detail: "checked in and waiting for work" };
}

/** Is every label this job wants advertised by that runner? (The claim board's
    subset rule, restated for a console that must not promise a placement SQL
    would refuse.) */
export function labelsMatch(want: string[] | null | undefined, have: string[] | null | undefined): boolean {
  const advertised = new Set(have || []);
  return (want || []).every((l) => advertised.has(l));
}

export interface PlacementReadiness {
  state: "ready" | "busy" | "asleep" | "unmatched" | "empty";
  /** Present tense, for a dialog that has not launched anything yet. */
  message: string;
  labels: string[];
  matching: RunnerRow[];
  live: RunnerRow[];
}

/**
 * Can this launch actually be placed — said BEFORE anyone spends money?
 *
 * The whole failure mode this answers is a run that sits on the board for ten
 * minutes and then fails with "no runner with the label `jeremys-mac` has
 * checked in". Everything needed to predict that is already on the page: the
 * labels the preview says this group needs, and the runner list's presence. So
 * the dialog says it up front, with the same words the failure would have used.
 */
export function placementReadiness(
  { labels = [], runners = [], now = Date.now(), windowS = 120 }:
  { labels?: string[]; runners?: RunnerRow[]; now?: number; windowS?: number },
): PlacementReadiness {
  const standing = runners.filter((r) => !r.revoked_at);
  const matching = standing.filter((r) => labelsMatch(labels, r.labels));
  const live = matching.filter((r) => {
    const p = runnerPresence(r, { now, windowS });
    return p.state === "online" || p.state === "working";
  });
  const named = labels.map((l) => `“${l}”`).join(", ");
  const wants = labels.length
    ? `runs here need ${labels.length === 1 ? "the label" : "the labels"} ${named}`
    : "this run can go to any runner in the project";
  if (!standing.length) {
    return {
      state: "empty", labels, matching, live,
      message: "This project has no runners registered, and runs are placed on self-hosted runners. "
        + "Register one under Settings → Runners and start it on the machine that can reach this target — "
        + "until then this run waits on the board and then fails.",
    };
  }
  if (!matching.length) {
    return {
      state: "unmatched", labels, matching, live,
      message: `No registered runner advertises ${labels.length === 1 ? "the label" : "all the labels"} ${named}. `
        + `This run waits on the board and then fails. Change the ring's runner labels, or start a runner advertising ${labels.length === 1 ? "it" : "them"}.`,
    };
  }
  if (!live.length) {
    const names = matching.map((r) => r.name).filter(Boolean).join(", ");
    return {
      state: "asleep", labels, matching, live,
      message: `${matching.length === 1 ? `${names} matches` : `${matching.length} runners match`}, but nothing has checked in recently — ${wants}. `
        + "Start the runner process on that machine, or this run waits on the board and then fails.",
    };
  }
  const idle = live.filter((r) => !r.claim);
  if (!idle.length) {
    return {
      state: "busy", labels, matching, live,
      message: `${live.length === 1 ? `${live[0]?.name} is` : `All ${live.length} matching runners are`} executing another run. `
        + "This one waits its turn — a runner takes one run at a time.",
    };
  }
  return {
    state: "ready", labels, matching, live,
    message: `${idle.map((r) => r.name).filter(Boolean).join(", ")} ${idle.length === 1 ? "is" : "are"} checked in and free`,
  };
}

/**
 * A placement failure, read back out of the message the platform wrote onto the
 * stories that never ran. The console does not re-derive the cause — it
 * recognises which of the four it is so it can offer the matching remedy
 * (the runner-setup link), and shows the server's own sentence for the detail.
 */
export function poolPlacementCause(error: string | null | undefined):
  { kind: "no-runners" | "unmatched" | "idle" | "lost"; labels: string[] } | null {
  const text = String(error || "");
  if (/no runner has checked in/.test(text)) return { kind: "no-runners", labels: [] };
  const unmatched = /no runner with the labels? ([^—]+?) has checked in/.exec(text);
  if (unmatched) {
    const named = [...String(unmatched[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
    return { kind: "unmatched", labels: named.filter(Boolean) };
  }
  if (/no runner claimed this run/.test(text)) return { kind: "idle", labels: [] };
  if (/claimed this run and stopped checking in/.test(text)) return { kind: "lost", labels: [] };
  return null;
}
