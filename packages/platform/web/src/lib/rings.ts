// Applications and rings, as the console models them.
//
// An APPLICATION is one executable test surface — a web app, an HTTP API, or a
// mobile build for one platform. A RING is an application-owned deployment
// target (`local`, `staging`, `prod`) holding a URL, routing labels, a discovery
// permission and a logical overlay. A suite belongs to exactly one application
// and launches against exactly one of its rings.
//
// Two rules run through everything here, and both are the server's:
//
//   * Keys are IMMUTABLE. Runner configuration and run evidence address an
//     application and a ring by key, so the form presents a key as identity —
//     asked once, never editable, delete-and-recreate as the stated remedy.
//   * A ring holds LOGICAL policy plus, for web/API, one base URL. The five
//     physical fields — `base_url`, `app`, `platform`, `device`, `appium_url` —
//     are unrepresentable in its overlay, because the claiming runner resolves
//     them. The console refuses them here so a person reads the reason while
//     typing rather than after a 400.
//
// DOM-free on purpose: the hermetic gate holds these rules without a browser.

export const DRIVERS = ["web", "api", "mobile"] as const;
export const PLATFORMS = ["ios", "android"] as const;

/** Lowercase letters, digits and hyphens — the server's own `KEY_RE`. */
export const KEY_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const DRIVER_WORDS: Record<string, { label: string; gist: string }> = {
  web: { label: "Web", gist: "A browser app, driven by Chromium." },
  api: { label: "API", gist: "An HTTP API, driven by fetch." },
  mobile: { label: "Mobile", gist: "A native app, driven by Appium on the runner that holds the device." },
};

export const driverLabel = (driver: string): string => DRIVER_WORDS[driver]?.label ?? driver;
export const driverGist = (driver: string): string => DRIVER_WORDS[driver]?.gist ?? "";

/** How an application reads in one line: `Todo Web · todo-web · web`. */
export function applicationLine(application: { key?: string; driver?: string; platform?: string | null }): string {
  return [application?.key, application?.driver, application?.platform].filter(Boolean).join(" · ");
}

/** Turn a typed name into a candidate key, so nobody has to invent one twice. */
export const keyFromName = (name: string): string =>
  String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);

/**
 * Why this key can't be used — shape first, then a collision NAMED, because a
 * key is permanent and a person deserves to hear that before pressing Create.
 */
export function keyProblem(
  value: string,
  taken: { key?: string }[] = [],
  { kind = "application", scope = "this project" }: { kind?: string; scope?: string } = {},
): string | null {
  const key = String(value || "").trim();
  if (!key) return `Give this ${kind} a key — it is what runner configuration and run evidence call it, for good.`;
  if (!KEY_RE.test(key)) {
    return "A key is lowercase letters, digits and hyphens — no spaces or capitals, and it can't start with a hyphen.";
  }
  if (taken.some((t) => t.key === key)) return `${scope} already has ${kind === "ring" ? "a ring" : "an application"} keyed “${key}”.`;
  return null;
}

/**
 * Is this a usable ring URL? Required for web/API, refused for mobile — the
 * server's rule, checked here so the form can say it beside the field.
 */
export function ringUrlProblem(value: string, driver: string): string | null {
  const url = String(value || "").trim();
  if (driver === "mobile") {
    return url
      ? "A mobile ring holds no URL — the claiming runner supplies the build, the device and the Appium endpoint from its own configuration file."
      : null;
  }
  if (!url) return "Add the URL this ring's runs point at. It is read from the claiming runner's network position, so a loopback URL means that runner's own machine.";
  let parsed;
  try { parsed = new URL(url); } catch { return "That isn't a URL — it needs a scheme and a host, e.g. https://staging.example.com."; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "The URL must start with http:// or https://.";
  return null;
}

/** The five physical fields a runtime target owns; a ring may hold none of them. */
export const PHYSICAL_APP_KEYS = ["base_url", "app", "platform", "device", "appium_url"];

/** The logical `config.app` keys a ring may set — the server's allowlist. */
export const LOGICAL_APP_KEYS = [
  "init", "storage_state", "auth", "auth_states", "preserve_session", "openapi",
  "allowed_origins", "headers", "viewport", "device_scale_factor", "settle", "cookies",
];

const CONFIG_KEYS = ["app", "auth", "secret_env"];

/**
 * Why this ring overlay is refused, in the server's own words — an ALLOWLIST at
 * the two positions core reads (`config.app`, `config.auth`), never a
 * property-name blacklist at every depth, which would reject the logical `app`
 * container itself and legitimate data merely named `device`.
 */
export function ringConfigProblem(config: unknown): string | null {
  if (config == null) return null;
  if (typeof config !== "object" || Array.isArray(config)) return "The overlay must be a JSON object.";
  const doc = config as Record<string, unknown>;
  for (const key of Object.keys(doc)) {
    if (!CONFIG_KEYS.includes(key)) {
      return `“${key}” is not part of a ring's configuration — a ring holds ${CONFIG_KEYS.join(", ")}.`;
    }
    if (doc[key] != null && (typeof doc[key] !== "object" || Array.isArray(doc[key]))) {
      return `“config.${key}” must be an object.`;
    }
  }
  const app = (doc.app ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(app)) {
    if (LOGICAL_APP_KEYS.includes(key)) continue;
    if (key === "base_url") return "A ring's URL is its own URL field, not an overlay key — set it above.";
    if (PHYSICAL_APP_KEYS.includes(key)) {
      return `“${key}” is a physical target the claiming runner resolves, not ring configuration. A mobile build's path, `
        + "its device and its Appium endpoint live in the runner's own configuration file, keyed by application and ring key.";
    }
    if (key === "compose") {
      return "“compose” would boot a different application under this ring's name, and hosted execution clears it — point the ring's URL at the deployment instead.";
    }
    if (key === "driver") return "“driver” is the application's, not the ring's — create a separate application for another surface.";
    if (key === "envs") return "“envs” is the suite's own overlay map; a ring IS one entry in it and cannot nest another.";
    return `“${key}” is not a ring overlay key (allowed: ${LOGICAL_APP_KEYS.join(", ")}).`;
  }
  const auth = (doc.auth ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(auth)) {
    if (key !== "identities" && key !== "default") {
      return `“config.auth.${key}” is not part of a ring's authorization (expected "identities", "default").`;
    }
  }
  return null;
}

// ---------- the launch dialog's ring picker ----------

export interface RingLike {
  id?: string;
  key?: string;
  name?: string | null;
  base_url?: string | null;
  discovery_allowed?: boolean;
  runner_labels?: string[];
}

/** The part of a URL worth reading in a dropdown: host, and port when it carries
    the meaning (two local services differ only there). */
export function hostOf(url: string | null | undefined): string {
  if (!url) return "";
  try { return new URL(url).host; } catch { return String(url); }
}

/**
 * One ring option: `staging · staging.acme.test · discovery`. The host is not
 * decoration — picking "production" when you meant localhost was the
 * silent-wrong-target trap, and a key alone never carried enough to notice it.
 * A mobile ring has no URL to name, so it says who supplies the build instead.
 */
export function ringOptionLabel(ring: RingLike, driver = "web"): string {
  const parts: string[] = [String(ring.key ?? "")];
  if (driver === "mobile") parts.push("build from the runner");
  else if (ring.base_url) parts.push(hostOf(ring.base_url));
  if (ring.discovery_allowed) parts.push("discovery");
  return parts.filter(Boolean).join(" · ");
}

/** True for a ring keyed or named like production. Substring, deliberately
    broad — "prod", "prod-eu", "Production" all mean the same thing to a person. */
export const isProdRing = (ring: RingLike): boolean =>
  /prod|live/i.test(`${ring?.key ?? ""} ${ring?.name ?? ""}`);

/**
 * Which ring opens selected.
 *
 * Opening on whichever ring came first meant a project with `prod` and
 * `staging` opened on production — the one place a discovery agent really
 * clicks buy, delete and submit. Order of preference: where this suite last ran
 * · one that allows discovery · one that isn't named like production · the
 * first there is. Never a production ring unless it is the only choice.
 */
export function defaultRingId(
  rings: RingLike[],
  { suiteId = null, groups = [] }: { suiteId?: string | null; groups?: { suite_id?: string; ring_id?: string }[] } = {},
): string {
  if (!rings.length) return "";
  const ids = new Set(rings.map((r) => r.id));
  const lastHere = groups.find((g) => String(g.suite_id) === String(suiteId) && ids.has(g.ring_id));
  if (lastHere?.ring_id) return lastHere.ring_id;
  const safe = rings.filter((r) => !isProdRing(r));
  return (safe.find((r) => r.discovery_allowed) || safe[0] || rings[0])?.id ?? "";
}

/**
 * What the launch preview's target block says, in words. Web and API resolve to
 * a URL; mobile deliberately does not — the platform never inspects a binary,
 * so the honest sentence is who supplies it.
 */
export function launchTargetWords(target: {
  application?: { key?: string; driver?: string; platform?: string | null };
  ring?: { key?: string };
  resolved_base_url?: string | null;
  build_supplied_by_runner?: boolean;
} | null | undefined): { where: string; source: string } {
  const application = target?.application?.key ?? "";
  const ring = target?.ring?.key ?? "";
  const pair = [application, ring].filter(Boolean).join(" / ");
  if (target?.build_supplied_by_runner) {
    return {
      where: "the build the claiming runner supplies",
      source: [pair, target?.application?.platform].filter(Boolean).join(" · "),
    };
  }
  return {
    where: target?.resolved_base_url || "no URL on this ring",
    source: pair,
  };
}
