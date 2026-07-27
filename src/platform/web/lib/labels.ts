// Status/mode vocabulary — mirrors core src/core/report.ts (MODE_DOING /
// MODE_DID / modeLabel / modeDoing): finished runs say
// recorded · checked · tried to heal · changed · explored; running rows say
// recording · checking · healing · exploring. The internal mode words stay
// record|act|heal|explore; only display changes. Duplicated here (browser
// module) with the source named.

const MODE_DOING: WebDynamic = { record: "recording", act: "checking", heal: "healing", explore: "exploring" };
const MODE_DID: WebDynamic = { record: "recorded", act: "checked", heal: "tried to heal", explore: "explored" };

/** In-progress label for a running row (core report.ts modeDoing). */
export function modeDoing(mode: WebDynamic) {
  return MODE_DOING[mode] ?? mode;
}

/** Finished-run label; a healed pass is a "changed" journey (core report.ts modeLabel). */
export function modeLabel(mode: WebDynamic, { healed = false, status }: WebDynamic = {}) {
  if (healed && status === "pass") return "changed";
  return MODE_DID[mode] ?? mode;
}

/** The status-chip class for a run row: changed wins over pass (amber ▲). */
export function chipStatus(run: WebDynamic) {
  if (run.healed && run.status === "pass") return "changed";
  if (["queued", "running", "uploading"].includes(run.status)) return "running";
  if (run.status === "canceled" || run.status === "lost") return "infra";
  return run.status;
}

/** Duration like the CLI (core report.ts fmtMs). */
export function fmtMs(ms: WebDynamic) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export const signedMs = (ms: WebDynamic) => (ms < 0 ? "−" : "+") + fmtMs(Math.abs(ms));

export function fmtCost(usd: WebDynamic) {
  if (usd == null || Number.isNaN(Number(usd))) return "—";
  const n = Number(usd);
  return n < 0.005 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`;
}

/** Abbreviate a ulid-ish id for display (full ids stay in links/tooltips). */
export const short = (id: WebDynamic) => (String(id || "").length > 12 ? String(id).slice(0, 8) : id);

/** One-line clamp for story prose / descriptions (viewer picker rule). */
export const clamp = (s: WebDynamic, n: WebDynamic = 140) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/** A compact absolute start time: "10:31 pm" today, "Thu 10:31 pm" within the
    week, "24 Jul, 10:31 pm" older (with the year once it differs). `ago()` says
    how long; this says WHICH — it is the name-like form, for telling otherwise
    identical rows apart. */
export function stamp(ts: WebDynamic) {
  const d: WebDynamic = new Date(ts);
  const now: WebDynamic = new Date();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .replace(/\s?([AP]M)/i, (_: WebDynamic, m: WebDynamic) => ` ${m.toLowerCase()}`);
  if (d.toDateString() === now.toDateString()) return time;
  if (now - d < 6 * 86400000 && now - d > 0) {
    return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return `${d.toLocaleDateString([], { day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" }) })}, ${time}`;
}

export function ago(ts: WebDynamic) {
  if (!ts) return "—";
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
