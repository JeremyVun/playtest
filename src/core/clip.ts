// `playtest clip` — cut a subtitled clip from a run's per-step stills. The
// default path stitches the screenshots into a paced slideshow (one frame per
// step at AUTOPLAY_MS) — an H.264 video.mp4 plus a WebVTT video.vtt sidecar,
// cue-timed on that same slideshow timeline. ffmpeg is required to emit the mp4
// (optional by contract — absent leaves just the .vtt); `--burn` adds the story
// intro + status header. MP4 (not webm) so the clip plays inline in a GitHub PR.
// A legacy run dir recorded before the slideshow change (a real video.webm +
// non-null video_started_at) still clips from its screencast, wall-clock-timed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DummyConfigError } from "./config.ts";
import { findRunsRoot, latestRun } from "./runs-root.ts";
import { readTrajectory } from "./trajectory.ts";
import { AUTOPLAY_MS } from "./shared/timing.ts";

type DynamicValue = any; // SAFETY: legacy manifests and envelopes vary across artifact schema versions

export interface ClipCue {
  start: number;
  end: number;
  text: string;
}

interface ClipOptions {
  captions?: string;
  out?: string;
  burn?: boolean;
}

interface ClipRunOptions {
  style?: string;
  out?: string;
  burn?: boolean;
}

interface SlideshowFrame {
  file: string;
  ms: number;
  env: DynamicValue;
  startMs: number;
}

// A burned clip opens on a blank white card showing the user story (the actor's
// brief) for this long before the stills roll, so a viewer reads the goal first.
const INTRO_MS = 3000;

// After the final action the clip holds the last frame for this long, then ends.
// The raw recording keeps running through the post-action grading (an LLM round
// trip — seconds, more under 429 retries), which would otherwise dangle as a
// frozen tail; the last cue ends here and --burn trims the footage to match.
const TAIL_MS = 3000;

/** Resolve `<runDir|case>`: an existing run directory wins; anything else is
 *  treated as a case id and resolves to that case's latest run under the
 *  nearest runs root (the runs-root.ts seam, as its header prescribes). */
function resolveClipRun(target: string): string {
  const asDir = path.resolve(target);
  if (fs.existsSync(path.join(asDir, "manifest.json"))) return asDir;
  if (fs.existsSync(asDir) && fs.statSync(asDir).isDirectory()) {
    throw new DummyConfigError(`${target} is not a run directory (no manifest.json)`);
  }
  const root = findRunsRoot();
  const hit = latestRun(root, target);
  if (!hit) {
    throw new DummyConfigError(
      `no runs of case ${target} found under ${root}\n` +
        `pass a run directory (runs/<run-id>/<case>) or a case id with runs in the nearest runs/`,
    );
  }
  return hit.dir;
}

/* ---------- caption derivation (mirrors the viewer's describe(); app.js has
   no exports — the repo's documented inline-copy convention applies) ---------- */

const actionOf = (env: DynamicValue, baselineByStep: Map<DynamicValue, DynamicValue>): DynamicValue =>
  env.agent?.action ??
  env.action ??
  (env.acted_from !== null ? (baselineByStep.get(env.acted_from)?.agent?.action ?? null) : null);

// A subtitle is a single readable line — pull a friendly name out of the
// locator, but NEVER the raw CSS selector chain a nameless element resolves to
// (`body > div:nth-of-type(2) > … > label`): that floods the frame with an
// unreadable wall of selectors. No name → null, and describe() falls back.
function locatorName(locator: DynamicValue): string | null {
  if (!locator) return null;
  let m = locator.match(/name="((?:[^"\\]|\\.)*)"/);
  if (m) return m[1];
  m = locator.match(/data-testid=["']?([\w-]+)/);
  if (m) return m[1];
  m = locator.match(/^text="((?:[^"\\]|\\.)*)"$/);
  if (m) return m[1];
  return null;
}

// The accessible name the actor saw for a `ref` — the step's a11y snapshot
// (steps/NNN.a11y.txt) lists each ref as `[e4] radio "I'm applying on my own"`.
// This is what makes a nameless element (a <label>/radio that resolves to a raw
// CSS chain) readable, instead of burning the selector path onto the frame.
const a11yCache = new Map<string, DynamicValue>();
function a11yName(runDir: string | null, env: DynamicValue): string | null {
  const ref = env.agent?.action?.ref ?? env.action?.ref;
  const rel = env.artifacts?.a11y;
  if (!ref || !rel || !runDir) return null;
  const file = path.join(runDir, rel);
  if (!a11yCache.has(file)) {
    try { a11yCache.set(file, fs.readFileSync(file, "utf8")); }
    catch { a11yCache.set(file, ""); }
  }
  // Escape the ref before interpolating: it is model-chosen and persisted
  // verbatim, so a hallucinated/malformed value with regex metacharacters (e.g.
  // "e4)") would otherwise make new RegExp throw an uncaught SyntaxError and
  // surface a raw stack from `playtest clip`.
  const safeRef = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = a11yCache.get(file).match(new RegExp(`^\\[${safeRef}\\][^"\\n]*"((?:[^"\\\\]|\\\\.)*)"`, "m"));
  return m ? m[1] : null;
}

function targetName(env: DynamicValue, { baselineByStep, runDir }: { baselineByStep: Map<DynamicValue, DynamicValue>; runDir: string | null }): string | null {
  const locator =
    env.resolution?.locator ??
    (env.acted_from !== null ? (baselineByStep.get(env.acted_from)?.resolution?.locator ?? null) : null);
  return locatorName(locator) ?? a11yName(runDir, env);
}

function describe(env: DynamicValue, ctx: DynamicValue): { verb: string; arg: DynamicValue } {
  if (env.mode === "error") return { verb: "actor error", arg: "" };
  const a = actionOf(env, ctx.baselineByStep);
  const type = a?.type ?? (env.acted_from !== null ? "acted" : "step");
  const name = targetName(env, ctx);
  switch (type) {
    case "click": return { verb: "click", arg: name ?? "" };
    case "tap": return { verb: "tap", arg: name ?? "" };
    case "type": return { verb: "type", arg: `${a.text}${name ? " → " + name : ""}` };
    case "select": return { verb: "select", arg: `${a.value}${name ? " in " + name : ""}` };
    case "scroll": return { verb: "scroll", arg: `${a.direction}${name ? " in " + name : ""}` };
    case "swipe": return { verb: "swipe", arg: `${a.direction}${name ? " on " + name : ""}` };
    case "navigate": return { verb: "go to", arg: a.url };
    case "back": return { verb: "back", arg: "" };
    case "request": return { verb: a.method ?? "request", arg: a.path ?? "" };
    case "wait": return { verb: "wait", arg: `${a.seconds}s` };
    // The done/give_up summary is a long, grader-style essay — never burn it
    // onto a frame (the PASS/FAIL watermark already carries the verdict).
    case "done": return { verb: "done", arg: "" };
    case "give_up": return { verb: "gave up", arg: "" };
    default: return { verb: "acted", arg: name ?? "" };
  }
}

/* ---------- cues ---------- */

// One line of cue text, safe inside a VTT cue block.
const vttSafe = (s: DynamicValue): string =>
  String(s ?? "").replace(/->/g, "→").replace(/[\r\n]+/g, " ").trim();

// An action caption is a subtitle — clamp it to one readable line so a long
// arg (a URL, a verbose `type` value) can never run off the frame.
const clampLine = (s: string, max = 80): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

function captionFor(env: DynamicValue, style: string, ctx: DynamicValue): string {
  const d = describe(env, ctx);
  if (style !== "thought") {
    return clampLine(vttSafe(`${d.verb.charAt(0).toUpperCase()}${d.verb.slice(1)} ${d.arg ?? ""}`.trim()));
  }
  if (env.agent?.thought) {
    const lines = [vttSafe(env.agent.thought)];
    if (env.agent.expectation) lines.push(vttSafe(`expects ${env.agent.expectation}`));
    return lines.join("\n");
  }
  // Acted steps carry no agent block — same wording as the viewer caption:
  // the baseline trajectory played against the live app.
  return vttSafe(`Playing baseline trajectory against live app: ${`${d.verb} ${d.arg ?? ""}`.trim()}`);
}

/**
 * Cue N: starts at (ts_N - t0), ends at the next step's start; the last cue
 * holds for TAIL_MS past the final action, then the clip ends — NOT to the full
 * recorded `endMs`, whose tail is post-action grading (a long frozen frame). The
 * first cue is pulled back to 0 so the lead-in frames carry a caption too.
 * @returns {{start: number, end: number, text: string}[]} times in ms
 */
export function buildCues(
  envelopes: DynamicValue[],
  {
    t0,
    endMs,
    style = "action",
    baselineByStep = new Map(),
    runDir = null
  }: {
    t0: number;
    endMs: number;
    style?: string;
    baselineByStep?: Map<DynamicValue, DynamicValue>;
    runDir?: string | null;
  }
): ClipCue[] {
  const ctx = { baselineByStep, runDir };
  const steps = envelopes.filter((e: DynamicValue) => typeof e.ts === "number");
  const starts: DynamicValue = steps.map((env: DynamicValue, i: number) => (i === 0 ? 0 : Math.max(0, env.ts - t0)));
  // Hold the last frame TAIL_MS, but never past the real footage end (endMs).
  // Floor at the last start so a recorded endMs that precedes it (clock skew on a
  // legacy webm) can't collapse the final caption to a 0ms flash.
  const lastEnd =
    endMs > 0 ? Math.max(starts.at(-1), Math.min(starts.at(-1) + TAIL_MS, endMs)) : starts.at(-1) + TAIL_MS;
  return steps.map((env: DynamicValue, i: number) => ({
    start: starts[i],
    // honest edges: a cue ends exactly where the next action dispatches (a
    // mock-speed run can flash a cue; real step gaps are model-paced)
    end: i + 1 < starts.length ? Math.max(starts[i], starts[i + 1]) : Math.max(starts[i], lastEnd),
    text: captionFor(env, style, ctx),
  }));
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");

function vttTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(t % 1000, 3)}`;
}

export function formatVtt(cues: ClipCue[]): string {
  const blocks = cues.map(
    (c: ClipCue, i: number) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text || "(no caption)"}`,
  );
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

// ASS time is H:MM:SS.cc (centiseconds).
function assTime(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const cs = Math.floor((t % 1000) / 10);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs, 2)}`;
}

// Text inside an ASS Dialogue line: real newlines become \N, and literal braces
// must be neutralised (libass reads `{…}` as an override block).
const assText = (s: DynamicValue): string =>
  String(s ?? "").replace(/[\r\n]+/g, "\\N").replace(/[{}]/g, "");

/**
 * Burn-only subtitle file. ASS (not WebVTT) so the story brief can carry its own
 * smaller size via an inline `{\fs}` override — yellow fill, thin black outline,
 * matching the action captions. The Default style is the caption size (22); the
 * story cue prepends `{\fs17}` (≈25% smaller). PlayResX/Y are unset so libass
 * uses the video frame as the layout box.
 * @param {{cues:{start:number,end:number,text:string}[], story:?string, storyMs:number}} a
 */
export function formatAss({ cues, story = null, storyMs = 0 }: { cues: ClipCue[]; story?: string | null; storyMs?: number }): string {
  // libass colours are &HAABBGGRR; yellow = &H0000FFFF, black = &H00000000.
  const styles =
    "Style: Default,Sans,22,&H0000FFFF,&H0000FFFF,&H00000000,&H00000000," +
    "0,0,0,0,100,100,0,0,1,1.5,0,2,16,16,16,1";
  const dialogue = [
    ...(story && storyMs
      ? [`Dialogue: 0,${assTime(0)},${assTime(storyMs)},Default,,0,0,0,,{\\fs17}${assText(story)}`]
      : []),
    ...cues.map(
      (c: ClipCue) => `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${assText(c.text || "(no caption)")}`,
    ),
  ];
  return (
    "[Script Info]\nScriptType: v4.00+\nWrapStyle: 0\nScaledBorderAndShadow: yes\n\n" +
    "[V4+ Styles]\n" +
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour," +
    "Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow," +
    "Alignment,MarginL,MarginR,MarginV,Encoding\n" +
    `${styles}\n\n` +
    "[Events]\n" +
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n" +
    `${dialogue.join("\n")}\n`
  );
}

/* ---------- ffmpeg (optional, system-installed) ---------- */

export const FFMPEG_HINT =
  "install a full ffmpeg (macOS: brew install ffmpeg-full, then set PLAYTEST_FFMPEG=$(brew --prefix ffmpeg-full)/bin/ffmpeg; linux: apt install ffmpeg)";

/** Conventional homes of a burn-capable ffmpeg on machines whose PATH `ffmpeg`
 *  is a slim build — Homebrew's default bottle lacks libass and freetype, and
 *  its `ffmpeg-full` formula is keg-only, so it never reaches PATH on its own. */
const FFMPEG_FALLBACKS = [
  "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
  "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
];

function probeFfmpeg(bin: string): { runs: boolean; missing: string[] } {
  const probe = spawnSync(bin, ["-hide_banner", "-filters"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return { runs: false, missing: [] };
  const missing = ["subtitles", "drawtext"].filter((f) => !new RegExp(` ${f} +`).test(probe.stdout));
  return { runs: true, missing };
}

/** The ffmpeg binary; with burnFilters, also verified to carry the filters
 *  --burn needs. `PLAYTEST_FFMPEG` is trusted verbatim — no fallback past an
 *  explicit override; otherwise a slim PATH build falls back to the
 *  conventional ffmpeg-full locations before failing. Throws DummyConfigError
 *  (exit 2) either way. `candidates` is a test seam. */
export function resolveFfmpeg({ burnFilters = false, candidates }: { burnFilters?: boolean; candidates?: string[] } = {}): string {
  const explicit = process.env.PLAYTEST_FFMPEG;
  const list = candidates ?? (explicit ? [explicit] : ["ffmpeg", ...FFMPEG_FALLBACKS]);
  let slim: { bin: string; missing: string[] } | null = null;
  for (const bin of list) {
    const { runs, missing } = probeFfmpeg(bin);
    if (!runs) continue;
    if (!burnFilters || missing.length === 0) return bin;
    slim ??= { bin, missing };
  }
  if (slim) {
    throw new DummyConfigError(
      `the ffmpeg at "${slim.bin}" is a slim build without the ${slim.missing.join("/")} filter(s) — ${FFMPEG_HINT}`,
    );
  }
  throw new DummyConfigError(`this clip needs ffmpeg and "${list[0]}" did not run — ${FFMPEG_HINT}`);
}

const ffmpegBinary = (opts: { burnFilters?: boolean; candidates?: string[] }): string => resolveFfmpeg(opts);

/** Non-throwing ffmpeg probe: true when any candidate binary runs. The
 *  runner uses this to BUILD the slideshow opportunistically (ffmpeg optional —
 * absent leaves stills + the VTT sidecar and prints a hint); `playtest clip`
 * keeps the throwing resolveFfmpeg so an explicit clip request still exits 2. */
export function ffmpegPresent(): boolean {
  const explicit = process.env.PLAYTEST_FFMPEG;
  const list = explicit ? [explicit] : ["ffmpeg", ...FFMPEG_FALLBACKS];
  return list.some((bin) => {
    const probe = spawnSync(bin, ["-hide_banner", "-version"], { encoding: "utf8" });
    return !probe.error && probe.status === 0;
  });
}

const ffmpeg = (bin: string, args: string[], cwd?: string): void => {
  const res = spawnSync(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8", cwd });
  if (res.error || res.status !== 0) {
    throw new DummyConfigError(`ffmpeg failed: ${(res.stderr || res.error?.message || "").trim().slice(0, 800)}`);
  }
};

// green pass / amber changed / red fail; infra and explored stay neutral.
function watermark(manifest: DynamicValue): { label: string; box: string } {
  const status = manifest?.result?.status ?? "?";
  if (status === "pass" && manifest.healed) return { label: "changed", box: "0xCC8B00" };
  if (status === "pass") return { label: "pass", box: "0x1F7A33" };
  if (status === "fail") return { label: "fail", box: "0xB3261E" };
  return { label: status, box: "0x5F6368" };
}

// The run date (YYYY-MM-DD, local) for the intro header; "" if unparseable.
function runDate(manifest: DynamicValue): string {
  const t = Date.parse(manifest.started_at ?? "");
  if (Number.isNaN(t)) return "";
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
}

/** Hard subtitles + a 3-row status header + a 3s story intro.
 *  Paths and free text never enter the filter graph — its quoting cannot
 *  carry arbitrary strings (quotes can't be escaped inside quotes, and the
 *  option parser re-splits on ':'): the returned work dir holds safe-named
 *  copies (subs.vtt, *.txt header lines, the filter script) and ffmpeg runs
 *  with cwd there; real input/output paths travel as argv, which needs no
 *  escaping. The captions are yellow with a black outline — subtitle-styled —
 *  and the cue timeline is shifted by INTRO_MS so a white intro card carrying
 *  the user story plays first (tpad pads the start of the real footage white;
 *  the story is the intro's own subtitle cue, the top-left running header stays
 *  hidden over it via an `enable` gate — but the same date/status/step labels
 *  are also shown top-left ON the intro card, with the step counter at 0/N since
 *  the run hasn't started yet). The clip ends on the last cue's TAIL_MS hold;
 *  -t trims off the recording's post-action grading tail. */
function burnArgs({ input, manifest, cues, out }: { input: string; manifest: DynamicValue; cues: ClipCue[]; out: string }): { work: string; args: string[] } {
  const { label, box } = watermark(manifest);
  const caseId = manifest.case?.id ?? "run";
  const persona = manifest.case?.persona ?? "";
  const story = manifest.case?.story ?? "";
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-clip-"));
  // Subtitle track: a story cue over the white intro, then the real cues shifted
  // past it. Written here (not reused from the playable sidecar) so the intro is
  // burn-only and the sidecar stays an honest mirror of the footage.
  const introMs = story.trim() ? INTRO_MS : 0;
  const storyText = introMs ? story.split(/\n{2,}/)[0].replace(/—/g, "→").trim() : null;
  // Burn the subtitles from an ASS file (not WebVTT): libass parses ASS natively,
  // so the story cue can carry its OWN smaller font via an inline {\fsN} tag —
  // WebVTT's reader treats such overrides as literal text. The playable sidecar
  // stays honest WebVTT (formatVtt); this ASS is burn-only.
  const subCues = cues.map((c: ClipCue) => ({ ...c, start: c.start + introMs, end: c.end + introMs }));
  fs.writeFileSync(path.join(work, "subs.ass"), formatAss({ cues: subCues, story: storyText, storyMs: introMs }));
  // Three stacked header rows: date · persona / STATUS caseId / step N/M.
  const line1 = [runDate(manifest), persona].filter(Boolean).join(" · ");
  fs.writeFileSync(path.join(work, "line1.txt"), line1 || caseId);
  fs.writeFileSync(path.join(work, "line2.txt"), `${label.toUpperCase()}  ${caseId}`);
  // The tested_environment (shown ONLY on the intro card so the viewer knows
  // which base_url this run targeted (free text — a textfile, never inline).
  const baseUrl = manifest.env?.base_url ?? "";
  if (baseUrl) fs.writeFileSync(path.join(work, "line3.txt"), baseUrl);
  // The cookies seeded for this run (web blue/green routing, etc.) shown on the
  // intro card under base_url so the viewer knows which slot was targeted.
  const cookies = manifest.env?.cookies ?? null;
  const cookieLine =
    cookies && typeof cookies === "object" && Object.keys(cookies).length
      ? Object.entries(cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")
      : "";
  if (cookieLine) fs.writeFileSync(path.join(work, "line4.txt"), cookieLine);

  const headBox = `fontcolor=white:fontsize=18:box=1:boxcolor=${box}@0.85:boxborderw=8`;
  const introSec = (introMs / 1000).toFixed(3);
  const overIntro = `lt(t,${introSec})`; // top-left header shown only over the intro card
  // The running header shows over the FOOTAGE only (after the intro card) so it
  // doesn't bleed onto the intro slide.
  const footageEndSec = ((introMs + (cues.at(-1)?.end ?? 0)) / 1000).toFixed(3);
  const overFootage = `between(t,${introSec},${footageEndSec})`; // top-left running header
  const filters = [
    `tpad=start_duration=${introSec}:start_mode=add:color=white`,
    // Subtitles are the focus — yellow fill, thin black outline (style in the ASS
    // header so the story cue can override its own size; see formatAss).
    `subtitles=filename=subs.ass`,
    `drawtext=textfile=line1.txt:x=16:y=14:${headBox}:enable='${overFootage}'`,
    `drawtext=textfile=line2.txt:x=16:y=46:${headBox}:enable='${overFootage}'`,
    // Mirror the same header top-left over the intro card (step 0/N — the run
    // hasn't started), plus the tested base_url and any seeded cookies (intro
    // only), so the scenario slide carries date/status/step and the environment
    // it ran against.
    ...(introMs
      ? [
          `drawtext=textfile=line1.txt:x=16:y=14:${headBox}:enable='${overIntro}'`,
          `drawtext=textfile=line2.txt:x=16:y=46:${headBox}:enable='${overIntro}'`,
          `drawtext=text='step 0/${cues.length}':x=16:y=78:${headBox}:enable='${overIntro}'`,
          ...(baseUrl ? [`drawtext=textfile=line3.txt:x=16:y=110:${headBox}:enable='${overIntro}'`] : []),
          ...(cookieLine ? [`drawtext=textfile=line4.txt:x=16:y=142:${headBox}:enable='${overIntro}'`] : []),
        ]
      : []),
    ...cues.map(
      (c: ClipCue, i: number) =>
        `drawtext=text='step ${i + 1}/${cues.length}':x=16:y=78:${headBox}` +
        `:enable='between(t,${((c.start + introMs) / 1000).toFixed(3)},${((c.end + introMs) / 1000).toFixed(3)})'`,
    ),
  ].join(",");
  fs.writeFileSync(path.join(work, "filter"), filters);
  // Trim the output to the intro + the last cue's end (last action + TAIL_MS),
  // then end — dropping the recording's post-action grading tail (an otherwise
  // frozen ~seconds-long dangle).
  const totalSec = ((introMs + (cues.at(-1)?.end ?? 0)) / 1000).toFixed(3);
  return {
    work,
    // H.264 MP4 (yuv420p + faststart) so the clip plays inline in a GitHub PR —
    // GitHub's video player won't render a VP8/VP9 webm. yuv420p keeps the
    // pixel format universal; faststart moves the moov atom up for streaming.
    args: ["-i", path.resolve(input), "-filter_script:v", "filter", "-t", totalSec, "-c:v", "libx264", "-crf", "23",
      "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", path.resolve(out)],
  };
}

/** Slideshow fallback: per-step screenshots become a video that steps at the
 *  same flat AUTOPLAY_MS pace as the viewer's still autoplay (src/core/shared/
 *  timing.ts) — raw ts gaps are unwatchable (mock-paced runs flash, think-time
 *  gaps stall); steps with a missing screenshot fold their beat into the
 *  previous frame. Each frame keeps its envelope so the caller can time cues to
 *  this same timeline. */
// The single source of truth for the slideshow timeline
// (docs/contracts/interfaces.md#clips): walk
// steps in order; a step WITH a screenshot starts a new frame at the running
// offset and advances it by AUTOPLAY_MS; a step WITHOUT a screenshot folds into
// the previous frame (no advance). Returns `{ file, ms, env, startMs }` per
// frame. writeVideoSidecar (VTT cues), slideshowArgs (mp4 build) and the
// viewer's marks/seek must all map a step to the SAME video time, so they all
// consume this recipe (the viewer inlines the identical formula). Pure
// NOTE: this side ALSO requires the PNG to exist on disk (fs.existsSync — ffmpeg
// can't stitch a missing frame); the browser viewer can't stat, so it folds onto
// the `artifacts.screenshot` key alone. On a normal run the two agree (the driver
// only sets the key when the PNG was written); they diverge only if a run dir is
// corrupted or a step PNG is deleted after the manifest was written — an
// unsupported/degraded state.
function slideshowFrames(runDir: string, envelopes: DynamicValue[]): SlideshowFrame[] {
  const frames: DynamicValue = [];
  const steps = envelopes.filter((e: DynamicValue) => typeof e.ts === "number");
  steps.forEach((env: DynamicValue) => {
    const file = env.artifacts?.screenshot ? path.join(runDir, env.artifacts.screenshot) : null;
    if (file && fs.existsSync(file)) frames.push({ file, ms: AUTOPLAY_MS, env, startMs: 0 });
    else if (frames.length) frames[frames.length - 1].ms += AUTOPLAY_MS;
  });
  let t = 0;
  for (const f of frames) {
    f.startMs = t;
    t += f.ms;
  }
  return frames;
}

/**
 * ffmpeg invocation for the paced-stills slideshow. Exported for the regression
 * test that pins the concat input: without it ffmpeg gets filters and an output
 * but no source, and every clip dies with "Output file does not contain any
 * stream" — a silent break of both `playtest clip` and hosted Export clip.
 */
export function slideshowArgs(runDir: string, envelopes: DynamicValue[], out: string): { listFile: string; frames: SlideshowFrame[]; args: string[] } {
  const frames: DynamicValue = slideshowFrames(runDir, envelopes);
  if (!frames.length) {
    throw new DummyConfigError(`${runDir} has no step screenshots — nothing to clip`);
  }
  const list = frames
    .map((f: SlideshowFrame) => `file '${f.file.replace(/'/g, "'\\''")}'\nduration ${(f.ms / 1000).toFixed(3)}`)
    .join("\n");
  const listFile = path.join(os.tmpdir(), `playtest-clip-${process.pid}.frames`);
  // concat-demuxer quirk: the last duration is honored only with a trailing
  // repeat of the file — which then lingers for an extra beat of its own, so
  // the output is trimmed (-t) to the cue timeline's exact length.
  fs.writeFileSync(listFile, `${list}\nfile '${frames.at(-1).file.replace(/'/g, "'\\''")}'\n`);
  const totalSec = frames.reduce((n: number, f: SlideshowFrame) => n + f.ms, 0) / 1000;
  return {
    listFile,
    frames,
    args: [
      // The paced stills ARE the input: the concat demuxer reads the list file
      // written above, honoring its per-frame `duration` lines. `-safe 0`
      // because the list carries absolute run-directory paths.
      "-f", "concat", "-safe", "0", "-i", listFile,
      // H.264 MP4 to render inline on GitHub (see burnArgs) — yuv420p needs even
      // dimensions, which the scale filter already guarantees.
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24",
      "-c:v", "libx264", "-crf", "23", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
      "-t", totalSec.toFixed(3), out],
  };
}

/** Build the per-step stills into a paced slideshow `out` (mp4) via ffmpeg.
 * The thin wrapper the runner calls post-run (after probing ffmpegPresent) and
 * `clipRun`'s slideshow branch share. Throws DummyConfigError when ffmpeg can't
 * run or there are no screenshotted steps. Returns the out path. */
export function buildSlideshow(runDir: string, envelopes: DynamicValue[], out: string, { burnFilters = false }: { burnFilters?: boolean } = {}): string {
  const bin = ffmpegBinary({ burnFilters });
  const show = slideshowArgs(runDir, envelopes, out);
  try {
    ffmpeg(bin, show.args);
  } finally {
    fs.rmSync(show.listFile, { force: true });
  }
  return out;
}

/* ---------- command ---------- */

/**
 * `playtest clip <runDir|case-id>`. An exact run directory wins; otherwise a
 * case id resolves to its latest run under the nearest runs root. The default
 * is a slideshow video.mp4 stitched from the per-step
 * stills + a generated video.vtt sidecar in the run dir (the viewer's <track>
 * and any browser play the pair); ffmpeg required to emit the mp4. --burn: a
 * self-contained clip.mp4 (H.264, plays inline in a GitHub PR — adds the story
 * intro + status header). A legacy run with a real video.webm clips from its
 * screencast instead. --out is an output directory; the clip lands inside as
 * <caseId>.mp4 + <caseId>.vtt (or .webm for a legacy screencast). Omit --out
 * to write into the run directory.
 */
export async function clip(target: string, opts: ClipOptions = {}): Promise<DynamicValue> {
  const style = opts.captions ?? "action";
  if (!["action", "thought"].includes(style)) {
    throw new DummyConfigError(`invalid --captions ${style} (action|thought)`);
  }
  const runDir = resolveClipRun(target);

  // `--out` is always a directory. Without it, clipRun writes into the run dir.
  const outDir = opts.out ? path.resolve(opts.out) : null;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });

  // New runs slideshow to .mp4 (no --burn) or a burned clip.mp4; only a legacy
  // run dir carrying a real video.webm still emits a .webm pair (clipRun keys
  // the extension off the run; here we name the no-burn out by what that run
  // will produce — .webm only when the legacy screencast is present).
  const legacyWebm = (runDir: string): boolean => {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
      const v = path.join(runDir, m.artifacts?.video ?? "");
      return m.video_started_at !== null && m.artifacts?.video?.endsWith(".webm") && fs.existsSync(v);
    } catch {
      return false;
    }
  };
  const out = outDir
    ? path.join(outDir, `${clipBaseName(runDir)}.${opts.burn || !legacyWebm(runDir) ? "mp4" : "webm"}`)
    : undefined;
  return clipRun(runDir, { style, out, burn: opts.burn });
}

/** Sanitized output basename from the manifest case id or run directory. */
function clipBaseName(runDir: string): string {
  let id = path.basename(runDir);
  try {
    const m = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
    if (typeof m.case?.id === "string" && m.case.id) id = m.case.id;
  } catch { /* fall back to dir name */ }
  return id.replace(/[^\w.-]+/g, "_");
}

/** Write the `video.vtt` caption sidecar in a run dir, cue-timed on the SAME
 * AUTOPLAY_MS slideshow timeline as the `video.mp4` build (slideshowFrames) —
 * so the sidecar mirrors the slideshow whether or not ffmpeg produced the mp4.
 * No-op (returns null) when the run recorded no screenshotted steps (an infra
 * death / non-web driver has none). Byte-identical to `clip`'s no-burn VTT, so
 * there's a single cue-timing recipe. */
export function writeVideoSidecar(runDir: string, { style = "action" }: { style?: string } = {}): string | null {
  let manifest: DynamicValue;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  } catch {
    return null;
  }
  const trajPath = path.join(runDir, manifest.artifacts?.trajectory ?? "trajectory.jsonl");
  if (!fs.existsSync(trajPath)) return null;
  const envelopes = readTrajectory(trajPath);
  if (!envelopes.length) return null;

  const baselineByStep = new Map<DynamicValue, DynamicValue>();
  const basePath = path.join(runDir, "baseline.jsonl");
  if (fs.existsSync(basePath)) for (const env of readTrajectory(basePath)) baselineByStep.set(env.step, env);

  const frames = slideshowFrames(runDir, envelopes);
  if (!frames.length) return null;
  const ctx = { baselineByStep, runDir };
  const cues = frames.map((f: SlideshowFrame) => ({ start: f.startMs, end: f.startMs + f.ms, text: captionFor(f.env, style, ctx) }));
  const vttPath = path.join(runDir, "video.vtt");
  fs.writeFileSync(vttPath, formatVtt(cues));
  return vttPath;
}

/** Clip exactly one run dir.  'out' (when set) is the burned/slideshow file. */
async function clipRun(runDir: string, opts: ClipRunOptions = {}): Promise<DynamicValue> {
  const style = opts.style ?? "action";
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  const trajPath = path.join(runDir, manifest.artifacts?.trajectory ?? "trajectory.jsonl");
  if (!fs.existsSync(trajPath)) {
    throw new DummyConfigError(`${runDir} has no trajectory.jsonl — nothing to caption`);
  }
  const envelopes = readTrajectory(trajPath);
  if (!envelopes.length) throw new DummyConfigError(`${runDir} recorded no steps — nothing to clip`);

  const baselineByStep = new Map<DynamicValue, DynamicValue>();
  const basePath = path.join(runDir, "baseline.jsonl");
  if (fs.existsSync(basePath)) for (const env of readTrajectory(basePath)) baselineByStep.set(env.step, env);

  // The manifest claims artifacts.video unconditionally — trust the file, not
  // the claim (no pinned chromium or an early infra death mean no webm).
  const videoPath = path.join(runDir, manifest.artifacts?.video ?? "video.webm");
  const hasVideo = manifest.video_started_at !== null && fs.existsSync(videoPath);

  if (hasVideo) {
    const t0 = manifest.video_started_at;
    const runEnd = manifest.started_at && manifest.duration_ms !== null
      ? Date.parse(manifest.started_at) + manifest.duration_ms
      : null;
    const cues = buildCues(envelopes, {
      t0,
      endMs: runEnd !== null ? Math.max(0, runEnd - t0) : 0,
      style,
      baselineByStep,
      runDir,
    });
    if (!opts.burn) {
      // No --burn: emit the playable video.webm + .vtt pair. Default lands in
      // the run dir; with --out, copy the webm there and put the sidecar beside
      // it so the pair travels together.
      if (opts.out) {
        const out = path.resolve(opts.out);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.copyFileSync(videoPath, out);
        const vttPath = out.replace(/\.webm$/i, "") + ".vtt";
        fs.writeFileSync(vttPath, formatVtt(cues));
        console.log(`clip pair ready (open both in any browser, or playtest view):\n  ${out}\n  ${vttPath}`);
        return { video: out, vtt: vttPath };
      }
      // A real webm needs WALL-CLOCK cues (buildCues above), not the slideshow
      // pacing writeVideoSidecar produces — that's correct only when there's no
      // webm (video_started_at null). Mirror the --out branch: write the cues.
      const vttPath = path.join(runDir, "video.vtt");
      fs.writeFileSync(vttPath, formatVtt(cues));
      console.log(`clip pair ready (open both in any browser, or playtest view):\n  ${videoPath}\n  ${vttPath}`);
      return { video: videoPath, vtt: vttPath };
    }
    // --burn output is clip.mp4 + clip.vtt
    // (docs/contracts/interfaces.md#clips); don't clobber the
    // playable video.vtt sidecar with the burn's captions.
    const vttPath = path.join(runDir, "clip.vtt");
    fs.writeFileSync(vttPath, formatVtt(cues));
    const bin = ffmpegBinary({ burnFilters: true });
    const out = path.resolve(opts.out ?? path.join(runDir, "clip.mp4"));
    const { work, args } = burnArgs({ input: videoPath, manifest, cues, out });
    try {
      ffmpeg(bin, args, work);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    console.log(`burned clip: ${out}`);
    return { video: out, vtt: vttPath };
  }

  // The default path for new runs (no screencast): stitch the per-step stills
  // into a paced slideshow, then burn on top of it when asked. Cues are timed
  // to the slideshow's own frame durations (slideshowFrames) — not raw ts
  // deltas, which the frames clamp — so each caption spans exactly its frame;
  // folded (screenshot-less) steps lose their caption along with their frame.
  const ctx = { baselineByStep, runDir };
  const frames = slideshowFrames(runDir, envelopes);
  if (!frames.length) throw new DummyConfigError(`${runDir} has no step screenshots — nothing to clip`);
  const cues = frames.map((f: SlideshowFrame) => ({ start: f.startMs, end: f.startMs + f.ms, text: captionFor(f.env, style, ctx) }));
  if (!opts.burn) {
    // No --burn: emit the playable video.mp4 + video.vtt pair. Default lands in
    // the run dir (the locked filenames the viewer expects); with --out copy the
    // mp4 there and put the sidecar beside it so the pair travels together.
    if (opts.out) {
      const out = path.resolve(opts.out);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      buildSlideshow(runDir, envelopes, out);
      const vttPath = out.replace(/\.(mp4|webm)$/i, "") + ".vtt";
      fs.writeFileSync(vttPath, formatVtt(cues));
      console.log(`clip pair ready (open both in any browser, or playtest view):\n  ${out}\n  ${vttPath}`);
      return { video: out, vtt: vttPath };
    }
    const out = path.join(runDir, "video.mp4");
    buildSlideshow(runDir, envelopes, out);
    const vttPath = writeVideoSidecar(runDir, { style });
    console.log(`clip pair ready (open both in any browser, or playtest view):\n  ${out}\n  ${vttPath}`);
    return { video: out, vtt: vttPath };
  }
  const bin = ffmpegBinary({ burnFilters: true });
  const out = path.resolve(opts.out ?? path.join(runDir, "clip.mp4"));
  const vttPath = path.join(runDir, "clip.vtt");
  fs.writeFileSync(vttPath, formatVtt(cues));
  buildSlideshow(runDir, envelopes, `${out}.base.mp4`, { burnFilters: true });
  const { work, args } = burnArgs({ input: `${out}.base.mp4`, manifest, cues, out });
  try {
    ffmpeg(bin, args, work);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(`${out}.base.mp4`, { force: true });
  }
  console.log(`burned clip: ${out}`);
  return { video: out, vtt: vttPath };
}
