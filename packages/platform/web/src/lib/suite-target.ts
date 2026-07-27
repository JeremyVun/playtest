// "Where does this app run?" — the model behind the card a new suite opens on.
//
// The platform's own answer is that a suite has an identity (a name and a
// transport) and a RING answers where its app lives: an environment carries the
// credentials, the runner pool and the discovery permission, and the suite
// declares its own address inside that ring. So the New suite dialog asks
// identity only, and this is what the empty suite page then offers — pick a
// ring, or make one, in the words of the driver that was chosen.
//
// It is skippable on purpose. Nothing here is a gate: the launch dialog states
// the resolved target and its source, and a launch with no resolvable app is
// refused server-side with the three sources named. Deferring is safe; a
// dead-end configuration is not reachable.
//
// DOM-free, so the offline gate can assert the choices, the collision rule and
// the writes each choice produces without a browser.

import { DEFAULT_ENV_NAME, ENV_NAME_RE } from "./defaults-form.js";

export interface BinarySource {
  id: "runner-path" | "artifact" | "suite-file";
  name: string;
  gist: string;
  /** The one sentence that decides whether this is the right one. */
  when: string;
}

/**
 * The three places a mobile binary can come from (hosted.md, § The app binary:
 * three sources, one precedence), as a choice rather than a field a person has
 * to already know the rules for. Order is how often the answer is each one.
 */
export const BINARY_SOURCES: BinarySource[] = [
  {
    id: "runner-path",
    name: "On the runner's disk",
    gist: "a path on the machine that runs it",
    when: "The build is already on the machine you run tests from — your laptop, a build box. Nothing is uploaded.",
  },
  {
    id: "artifact",
    name: "Uploaded here",
    gist: "one build, pinned by hash",
    when: "The runner is not where the build is. Upload it once; every run installs exactly those bytes until you replace them.",
  },
  {
    id: "suite-file",
    name: "Committed in the suite",
    gist: "a small fixture app",
    when: "A tiny sample app that belongs with the stories. Real builds are far past what a suite may hold.",
  },
];

/** What the card asks, given the transport the suite was created with. */
export function targetQuestion(driver: string): { title: string; sub: string; kind: "url" | "binary" } {
  if (driver === "mobile") {
    return {
      title: "Where does this app run?",
      sub: "A mobile run installs a build on a device or simulator. Say where that build comes from and which machine holds the device.",
      kind: "binary",
    };
  }
  if (driver === "api") {
    return {
      title: "Where does this API run?",
      sub: "The address these stories call. You can add more environments later — each one keeps its own URL for this suite.",
      kind: "url",
    };
  }
  return {
    title: "Where does this app run?",
    sub: "The address these stories open. You can add more environments later — each one keeps its own URL for this suite.",
    kind: "url",
  };
}

/**
 * Is this name available? Environment names are unique per project across BOTH
 * scopes, because the name is the `app.envs.<name>` overlay key and the CLI's
 * `--env` argument — one name must mean one target inside a project. So the
 * inline form has to say which one is in the way, not merely refuse.
 */
export function ringNameProblem(
  name: string,
  envs: { name?: string; suite_id?: string | null; suite?: { name?: string | null } | null }[] = [],
): string | null {
  const value = String(name || "").trim();
  if (!value) return "Give this environment a name — it is how it reads at launch and in the CLI.";
  if (!ENV_NAME_RE.test(value)) {
    return "A name is letters, digits, dots and dashes — no spaces, and it can't start with a dash.";
  }
  const taken = envs.find((e) => (e.name || "").toLowerCase() === value.toLowerCase());
  if (!taken) return null;
  return taken.suite_id
    ? `“${value}” is already taken by ${taken.suite?.name ? `the suite “${taken.suite.name}”` : "another suite"}. Names are unique across the whole project, so pick another.`
    : `“${value}” is already a shared environment in this project — pick it above instead of creating a second one.`;
}

export interface RingDraft {
  driver: string;
  name: string;
  /** Suite-owned by default: a ring made for one suite is that suite's business
      until someone says otherwise. */
  scope: "suite" | "project";
  url?: string;
  labels?: string[];
  source?: BinarySource["id"];
  /** The runner path, or the suite-relative path, depending on `source`. */
  path?: string;
  platform?: string;
  appiumUrl?: string;
}

/** Where the chosen answer is written. Exactly one of these per plan. */
export type TargetWrite =
  | { kind: "suite-default-url"; value: string }
  | { kind: "suite-env-url"; env: string; value: string }
  | { kind: "suite-app"; value: string }
  | { kind: "none" };

export interface TargetPlan {
  /** The environment to create, or null when an existing one was chosen. */
  environment: { name: string; suite_id?: string; runner_labels: string[]; config: Record<string, unknown> } | null;
  /** What to write into the suite's playtest.yaml. */
  write: TargetWrite;
  /** Whether the card still owes an app-artifact upload after creating it. */
  upload: boolean;
}

/**
 * What choosing this answer does, in full, before anything is created — one
 * object the card can execute and a test can read.
 *
 * The split is the platform's own: an address or a device is the RING's
 * (`config.app`), while the URL a given suite uses inside a ring is the SUITE's
 * (`app.envs.<name>.base_url`, or the top-level `app.base_url` for the
 * project's `default` ring, which carries no URL of its own).
 */
export function ringPlan(draft: RingDraft, { suiteId }: { suiteId?: string } = {}): TargetPlan {
  const name = String(draft.name || "").trim();
  const labels = (draft.labels || []).map((l) => l.trim()).filter(Boolean);
  const owned = draft.scope !== "project" && suiteId ? { suite_id: suiteId } : {};
  if (draft.driver === "mobile") {
    const config: Record<string, unknown> = {};
    const app: Record<string, string> = {};
    if (draft.platform) app.platform = draft.platform;
    if (draft.appiumUrl?.trim()) app.appium_url = draft.appiumUrl.trim();
    // A runner-local build is the ring's: it describes that machine's disk.
    if (draft.source === "runner-path" && draft.path?.trim()) app.app = draft.path.trim();
    if (Object.keys(app).length) config.app = app;
    return {
      environment: { name, ...owned, runner_labels: labels, config },
      // A committed fixture app is the SUITE's file, so it goes in the suite's
      // own defaults, where core resolves it against playtest.yaml.
      write: draft.source === "suite-file" && draft.path?.trim()
        ? { kind: "suite-app", value: draft.path.trim() }
        : { kind: "none" },
      upload: draft.source === "artifact",
    };
  }
  const url = String(draft.url || "").trim();
  return {
    environment: { name, ...owned, runner_labels: labels, config: {} },
    write: url ? { kind: "suite-env-url", env: name, value: url } : { kind: "none" },
    upload: false,
  };
}

// ---------- what a launch would install ----------

export interface AppTarget {
  resolved?: string | null;
  source?: "suite-env" | "environment-artifact" | "environment" | "suite" | null;
  artifact?: { filename?: string | null; size?: number } | null;
}

const APP_SOURCE_WORDS: Record<string, string> = {
  "suite-env": "this suite's own value for this environment",
  "environment-artifact": "uploaded to this environment",
  environment: "a path on the runner's own disk",
  suite: "committed in this suite",
};

/** Which of the three sources won, in words — the `base_url` rule applied to
    the binary, so a launch never installs something nobody named. */
export const appSourceWords = (source: string | null | undefined): string =>
  (source && APP_SOURCE_WORDS[source]) || "unresolved";

/**
 * What is wrong with the binary this launch resolved, before anyone launches.
 *
 * Two shapes, and they are not the same severity. Nothing resolved at all is
 * fatal — the runner would have no file to install. A suite-RELATIVE path is
 * only fatal when the pinned snapshot does not contain it, which the browser
 * cannot know and the launch itself checks, so that one is a warning carrying
 * the three sources rather than a refusal the console invents.
 */
export function appTargetProblem(app: AppTarget | null | undefined, driver: string):
  { severity: "blocking" | "warning"; message: string } | null {
  if (driver !== "mobile") return null;
  const three = "A hosted mobile run gets its binary from one of three places: a small fixture app committed in the suite, "
    + "a build uploaded to the environment, or an absolute path on the runner's own disk.";
  if (!app?.source || !app.resolved) {
    return { severity: "blocking", message: `Nothing says which app to install for this environment. ${three}` };
  }
  if (app.source !== "environment-artifact" && !app.resolved.startsWith("/")) {
    return {
      severity: "warning",
      message: `“${app.resolved}” is a path relative to this suite, so it only runs if that file is committed in the suite — `
        + `real builds are far past the suite upload cap. ${three}`,
    };
  }
  return null;
}

/** Pointing this suite at a ring that already exists: only the suite's own URL
    is written, and the `default` ring's URL is the suite's top-level one. */
export function existingRingPlan(envName: string, url: string): TargetWrite {
  const value = String(url || "").trim();
  if (!value) return { kind: "none" };
  return envName === DEFAULT_ENV_NAME
    ? { kind: "suite-default-url", value }
    : { kind: "suite-env-url", env: envName, value };
}
