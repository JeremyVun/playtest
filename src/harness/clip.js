// `playtest clip` — cut a subtitled clip from a run's existing screencast
// (VERSION_1.1.md item 2). The default path is zero-dependency: the recorded
// video.webm plus a generated WebVTT sidecar, cue-timed from step `ts`
// (stamped at action dispatch, so captions lead the action). `--burn` and the
// no-video slideshow fallback spawn a system ffmpeg — optional by contract.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DummyConfigError } from "./config.js";
import { findRunsRoot, latestRun } from "./runs-root.js";
import { readTrajectory } from "./trajectory.js";

/** Resolve `<runDir|case>`: an existing run directory wins; anything else is
 *  treated as a case id and resolves to that case's latest run under the
 *  nearest runs root (the runs-root.js seam, as its header prescribes). */
export function resolveClipRun(target) {
  const asDir = path.resolve(target);
  if (fs.existsSync(path.join(asDir, "manifest.json"))) return asDir;
  if (fs.existsSync(asDir) && fs.statSync(asDir).isDirectory()) {
    throw new DummyConfigError(`${target} is not a run directory (no manifest.json)`);
  }
  const root = findRunsRoot(null);
  const hit = latestRun(root, target);
  if (!hit) {
    throw new DummyConfigError(
      `no runs of case ${target} found under ${root}\n` +
        "  pass a run directory (runs/<run-id>/<case>) or a case id with runs in the nearest runs/",
    );
  }
  return hit.dir;
}

/* ---------- caption derivation (mirrors the viewer's describe(); app.js has
   no exports — the repo's documented inline-copy convention applies) ---------- */

const actionOf = (env, baselineByStep) =>
  env.agent?.action ??
  env.action ??
  (env.acted_from != null ? (baselineByStep.get(env.acted_from)?.agent?.action ?? null) : null);

function locatorName(locator) {
  if (!locator) return null;
  let m = locator.match(/name="((?:[^"\\]|\\.)*)"/);
  if (m) return m[1];
  m = locator.match(/data-testid=["']?([\w-]+)/);
  if (m) return m[1];
  m = locator.match(/^text="((?:[^"\\]|\\.)*)"$/);
  if (m) return m[1];
  return locator;
}

function targetName(env, baselineByStep) {
  const a = actionOf(env, baselineByStep);
  const locator =
    env.resolution?.locator ??
    (env.acted_from != null ? (baselineByStep.get(env.acted_from)?.resolution?.locator ?? null) : null);
  return locatorName(locator) ?? (a?.ref ? `ref ${a.ref}` : null);
}

function describe(env, baselineByStep) {
  if (env.mode === "error") return { verb: "actor error", arg: "" };
  const a = actionOf(env, baselineByStep);
  const type = a?.type ?? (env.acted_from != null ? "acted" : "step");
  const name = targetName(env, baselineByStep);
  switch (type) {
    case "click": return { verb: "click", arg: name ?? "?" };
    case "tap": return { verb: "tap", arg: name ?? "?" };
    case "type": return { verb: "type", arg: `“${a.text}”${name ? " → " + name : ""}` };
    case "select": return { verb: "select", arg: `“${a.value}”${name ? " in " + name : ""}` };
    case "scroll": return { verb: "scroll", arg: a.direction };
    case "swipe": return { verb: "swipe", arg: `${a.direction}${name ? " on " + name : ""}` };
    case "navigate": return { verb: "go to", arg: a.url };
    case "back": return { verb: "back", arg: "" };
    case "request": return { verb: a.method ?? "request", arg: a.path ?? "" };
    case "wait": return { verb: "wait", arg: `${a.seconds}s` };
    case "done": return { verb: "done", arg: a.summary };
    case "give_up": return { verb: "gave up", arg: a.reason };
    default: return { verb: "acted", arg: name ?? `baseline step ${env.acted_from ?? "?"}` };
  }
}

/* ---------- cues ---------- */

// One line of cue text, safe inside a VTT cue block.
const vttSafe = (s) =>
  String(s ?? "").replace(/-->/g, "→").replace(/[\r\n]+/g, " ").trim();

function captionFor(env, style, baselineByStep) {
  const d = describe(env, baselineByStep);
  if (style !== "thought") {
    return vttSafe(`${d.verb.charAt(0).toUpperCase()}${d.verb.slice(1)} ${d.arg ?? ""}`.trim());
  }
  if (env.agent?.thought) {
    const lines = [vttSafe(env.agent.thought)];
    if (env.agent.expectation) lines.push(vttSafe(`expects ${env.agent.expectation}`));
    return lines.join("\n");
  }
  // Acted steps carry no agent block — same fallback wording as the viewer,
  // incl. quoting done/give_up sentence args instead of splicing them.
  const what =
    d.verb === "done" || d.verb === "gave up"
      ? `${d.verb === "done" ? "finished" : "gave up"}: “${String(d.arg ?? "").replace(/[.\s]+$/, "")}”`
      : `${d.verb} ${d.arg ?? ""}`.trim();
  return vttSafe(`Replayed from the saved recording — ${what}`);
}

/**
 * Cue N: starts at (ts_N − t0), ends at the next step's start; the last cue
 * runs to `endMs` (video end derived from the manifest). The first cue is
 * pulled back to 0 so the lead-in frames carry a caption too.
 * @returns {{start: number, end: number, text: string}[]} times in ms
 */
export function buildCues(envelopes, { t0, endMs, style = "action", baselineByStep = new Map() }) {
  const steps = envelopes.filter((e) => typeof e.ts === "number");
  const starts = steps.map((env, i) => (i === 0 ? 0 : Math.max(0, env.ts - t0)));
  return steps.map((env, i) => ({
    start: starts[i],
    // honest edges: a cue ends exactly where the next action dispatches (a
    // mock-speed run can flash a cue; real step gaps are model-paced)
    end: i + 1 < starts.length ? Math.max(starts[i], starts[i + 1]) : Math.max(starts[i] + 1500, endMs),
    text: captionFor(env, style, baselineByStep),
  }));
}

const pad = (n, w) => String(n).padStart(w, "0");

function vttTime(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const m = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(t % 1000, 3)}`;
}

export function formatVtt(cues) {
  const blocks = cues.map(
    (c, i) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text || "(no caption)"}`,
  );
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

/* ---------- ffmpeg (optional, system-installed) ---------- */

const FFMPEG_HINT =
  "install a full ffmpeg (macOS: brew install ffmpeg-full, then set PLAYTEST_FFMPEG=$(brew --prefix ffmpeg-full)/bin/ffmpeg; linux: apt install ffmpeg)";

/** The ffmpeg binary; with burnFilters, also verified to carry the filters
 *  --burn needs (slim builds exist — Homebrew's default formula lacks libass
 *  and freetype). Throws DummyConfigError (exit 2) either way. */
function ffmpegBinary({ burnFilters = false } = {}) {
  const bin = process.env.PLAYTEST_FFMPEG || "ffmpeg";
  const probe = spawnSync(bin, ["-hide_banner", "-filters"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    throw new DummyConfigError(`this clip needs ffmpeg and "${bin}" did not run — ${FFMPEG_HINT}`);
  }
  if (burnFilters) {
    const missing = ["subtitles", "drawtext"].filter((f) => !new RegExp(` ${f} +`).test(probe.stdout));
    if (missing.length) {
      throw new DummyConfigError(
        `the ffmpeg at "${bin}" is a slim build without the ${missing.join("/")} filter(s) — ${FFMPEG_HINT}`,
      );
    }
  }
  return bin;
}

const ffmpeg = (bin, args, cwd) => {
  const res = spawnSync(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8", cwd });
  if (res.error || res.status !== 0) {
    throw new DummyConfigError(`ffmpeg failed: ${(res.stderr || res.error?.message || "").trim().slice(0, 800)}`);
  }
};

// green pass / amber changed / red fail; infra and explored stay neutral.
function watermark(manifest) {
  const status = manifest.result?.status ?? "?";
  if (status === "pass" && manifest.healed) return { label: "changed", box: "0xCC8B00", fg: "white" };
  if (status === "pass") return { label: "pass", box: "0x1F7A33", fg: "white" };
  if (status === "fail") return { label: "fail", box: "0xB3261E", fg: "white" };
  return { label: status, box: "0x5F6368", fg: "white" };
}

/** Hard subtitles + status watermark + case id and per-step counter.
 *  Paths and free text never enter the filtergraph — its quoting cannot
 *  carry arbitrary strings (quotes can't be escaped inside quotes, and the
 *  option parser re-splits on ':'): the returned work dir holds safe-named
 *  copies (subs.vtt, head.txt, the filter script) and ffmpeg runs with cwd
 *  there; real input/output paths travel as argv, which needs no escaping. */
function burnArgs({ input, vttPath, manifest, cues, out }) {
  const { label, box, fg } = watermark(manifest);
  const caseId = manifest.case?.id ?? "run";
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "playtest-clip-"));
  fs.copyFileSync(vttPath, path.join(work, "subs.vtt"));
  fs.writeFileSync(path.join(work, "head.txt"), `${label.toUpperCase()}  ${caseId}`);
  const drawCommon = `fontcolor=${fg}:fontsize=20:box=1:boxcolor=${box}@0.85:boxborderw=8`;
  const filters = [
    `subtitles=filename=subs.vtt:force_style='FontSize=18,Outline=1,Shadow=0'`,
    `drawtext=textfile=head.txt:x=16:y=14:${drawCommon}`,
    ...cues.map(
      (c, i) =>
        `drawtext=text='step ${i + 1}/${cues.length}':x=16:y=52:fontsize=16:${drawCommon}` +
        `:enable='between(t,${(c.start / 1000).toFixed(3)},${(c.end / 1000).toFixed(3)})'`,
    ),
  ].join(",");
  fs.writeFileSync(path.join(work, "filter"), filters);
  return {
    work,
    args: ["-i", path.resolve(input), "-filter_script:v", "filter", "-c:v", "libvpx-vp9", "-crf", "34",
      "-b:v", "0", "-cpu-used", "5", "-row-mt", "1", "-an", path.resolve(out)],
  };
}

/** Slideshow fallback: per-step screenshots become a video whose frame
 *  durations are the step's ts gap clamped to [800ms, 8000ms] (raw gaps are
 *  unwatchable: mock-paced runs flash, think-time gaps stall); steps with a
 *  missing screenshot fold their time into the previous frame. Each frame
 *  keeps its envelope so the caller can time cues to this same timeline. */
function slideshowArgs(runDir, envelopes, out) {
  const frames = [];
  const steps = envelopes.filter((e) => typeof e.ts === "number");
  steps.forEach((env, i) => {
    const next = steps[i + 1];
    const ms = next ? Math.min(8000, Math.max(800, next.ts - env.ts)) : 2500;
    const file = env.artifacts?.screenshot ? path.join(runDir, env.artifacts.screenshot) : null;
    if (file && fs.existsSync(file)) frames.push({ file, ms, env });
    else if (frames.length) frames[frames.length - 1].ms += ms;
  });
  if (!frames.length) {
    throw new DummyConfigError(`${runDir} has no screencast and no step screenshots — nothing to clip`);
  }
  const list = frames
    .map((f) => `file '${f.file.replace(/'/g, "'\\''")}'\nduration ${(f.ms / 1000).toFixed(3)}`)
    .join("\n");
  const listFile = path.join(os.tmpdir(), `playtest-clip-${process.pid}.frames`);
  // concat-demuxer quirk: the last duration is honored only with a trailing
  // repeat of the file — which then lingers for an extra beat of its own, so
  // the output is trimmed (-t) to the cue timeline's exact length.
  fs.writeFileSync(listFile, `${list}\nfile '${frames.at(-1).file.replace(/'/g, "'\\''")}'\n`);
  const totalSec = frames.reduce((n, f) => n + f.ms, 0) / 1000;
  return {
    listFile,
    frames,
    args: ["-f", "concat", "-safe", "0", "-i", listFile,
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=24",
      "-c:v", "libvpx-vp9", "-crf", "34", "-b:v", "0", "-cpu-used", "5", "-row-mt", "1", "-an",
      "-t", totalSec.toFixed(3), out],
  };
}

/* ---------- command ---------- */

/**
 * `playtest clip <runDir|case>`. Default: video.webm + a generated video.vtt
 * sidecar in the run dir (the viewer's <track> and any browser play the pair).
 * --burn: a single self-contained clip.webm. No screencast: slideshow
 * fallback (ffmpeg required either way on that path).
 */
export async function clip(target, opts = {}) {
  const style = opts.captions ?? "action";
  if (!["action", "thought"].includes(style)) {
    throw new DummyConfigError(`invalid --captions ${style} (action|thought)`);
  }
  const runDir = resolveClipRun(target);
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, "manifest.json"), "utf8"));
  const trajPath = path.join(runDir, manifest.artifacts?.trajectory ?? "trajectory.jsonl");
  if (!fs.existsSync(trajPath)) {
    throw new DummyConfigError(`${runDir} has no trajectory.jsonl — nothing to caption`);
  }
  const envelopes = readTrajectory(trajPath);
  if (!envelopes.length) throw new DummyConfigError(`${runDir} recorded no steps — nothing to clip`);

  const baselineByStep = new Map();
  const basePath = path.join(runDir, "baseline.jsonl");
  if (fs.existsSync(basePath)) for (const env of readTrajectory(basePath)) baselineByStep.set(env.step, env);

  // The manifest claims artifacts.video unconditionally — trust the file, not
  // the claim (no pinned chromium or an early infra death mean no webm).
  const videoPath = path.join(runDir, manifest.artifacts?.video ?? "video.webm");
  const hasVideo = manifest.video_started_at != null && fs.existsSync(videoPath);

  if (hasVideo) {
    const t0 = manifest.video_started_at;
    const runEnd = manifest.started_at && manifest.duration_ms != null
      ? Date.parse(manifest.started_at) + manifest.duration_ms
      : null;
    const cues = buildCues(envelopes, {
      t0,
      endMs: runEnd != null ? Math.max(0, runEnd - t0) : 0,
      style,
      baselineByStep,
    });
    const vttPath = path.join(runDir, "video.vtt");
    fs.writeFileSync(vttPath, formatVtt(cues));
    if (!opts.burn) {
      console.log(`clip pair ready (open both in any browser, or playtest view):\n  ${videoPath}\n  ${vttPath}`);
      return { video: videoPath, vtt: vttPath };
    }
    const bin = ffmpegBinary({ burnFilters: true });
    const out = path.resolve(opts.out ?? path.join(runDir, "clip.webm"));
    const { work, args } = burnArgs({ input: videoPath, vttPath, manifest, cues, out });
    try {
      ffmpeg(bin, args, work);
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    console.log(`burned clip: ${out}`);
    return { video: out, vtt: vttPath };
  }

  // No screencast: assemble the slideshow (ffmpeg on both paths here), then
  // burn on top of it when asked. Cues are timed to the slideshow's own
  // frame durations — not raw ts deltas, which the frames clamp — so each
  // caption spans exactly its frame; folded (screenshot-less) steps lose
  // their caption along with their frame.
  const bin = ffmpegBinary({ burnFilters: Boolean(opts.burn) });
  const out = path.resolve(opts.out ?? path.join(runDir, "clip.webm"));
  const vttPath = path.join(runDir, "clip.vtt");
  const show = slideshowArgs(runDir, envelopes, opts.burn ? `${out}.base.webm` : out);
  const cues = [];
  let t = 0;
  for (const f of show.frames) {
    cues.push({ start: t, end: t + f.ms, text: captionFor(f.env, style, baselineByStep) });
    t += f.ms;
  }
  fs.writeFileSync(vttPath, formatVtt(cues));
  try {
    ffmpeg(bin, show.args);
    if (opts.burn) {
      const { work, args } = burnArgs({ input: `${out}.base.webm`, vttPath, manifest, cues, out });
      try {
        ffmpeg(bin, args, work);
      } finally {
        fs.rmSync(work, { recursive: true, force: true });
        fs.rmSync(`${out}.base.webm`, { force: true });
      }
    }
  } finally {
    fs.rmSync(show.listFile, { force: true });
  }
  console.log(
    opts.burn
      ? `burned slideshow clip (no screencast in this run): ${out}`
      : `slideshow clip (no screencast in this run):\n  ${out}\n  ${vttPath}`,
  );
  return { video: out, vtt: vttPath };
}
