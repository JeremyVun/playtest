// On-demand clip worker. Clips run on the control plane
// when ffmpeg is available: the sealed bundle is materialized to a temp run dir,
// core `clip.ts` generates the same burned/slideshow output as the CLI, and the
// resulting clip lands as sibling artifacts (`clip.mp4`, `clip.vtt`) so the
// immutable bundle hash remains the run-produced audit unit.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clip as clipRunDir } from "@playtest/core/media";
import { firstLine } from "@playtest/core/artifacts";
import { AppError } from "../errors.ts";
import { audit } from "../audit.ts";
import { ulid } from "../ulid.ts";
import { emitPlatformEvent } from "../events/outbox.ts";
import { appendRunEvent } from "../events/run-events.ts";
import { loadRunBundle } from "../run-storage.ts";

const CAPTIONS = new Set(["action", "thought"]);

export function normalizeClipRequest(body: HostedDynamic = {}) {
  const captions = body.captions ?? "action";
  if (!CAPTIONS.has(captions)) {
    throw new AppError("bad_request", `"captions" must be "action" or "thought"`);
  }
  return { captions, burn: body.burn !== false };
}

export async function generateClip(ctx: HostedDynamic, { run, project, actor, request, dispatchId = null }: HostedDynamic) {
  const bundle = await loadRunBundle(ctx, run.id);
  if (!bundle) throw new AppError("not_found", `run "${run.run_id}" has no bundle to clip`);
  if (bundle.artifact.tier !== "full" || run.artifact_tier !== "full") {
    throw new AppError(
      "bad_request",
      `run "${run.run_id}" has been pruned to ${run.artifact_tier}; on-demand clips need the full bundle`,
    );
  }

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pt-clip-"));
  const outDir = path.join(dir, "out");
  const runDir = path.join(dir, "run");
  try {
    await materializeBundle(bundle.provider, runDir);
    await fsp.mkdir(outDir, { recursive: true });

    const oldLog = console.log;
    console.log = () => {};
    let result;
    try {
      result = await clipRunDir(runDir, { out: outDir, captions: request.captions, burn: request.burn });
    } finally {
      console.log = oldLog;
    }

    const videoPath = result.video;
    const vttPath = result.vtt;
    const videoBytes = await fsp.readFile(videoPath);
    const vttBytes = vttPath ? await fsp.readFile(vttPath) : null;
    const clipKey = `runs/${run.run_group_id}/${run.id}.clip.mp4`;
    const vttKey = `runs/${run.run_group_id}/${run.id}.clip.vtt`;
    const storedVideo = await ctx.store.put(clipKey, videoBytes);
    const storedVtt = vttBytes ? await ctx.store.put(vttKey, vttBytes) : null;

    await ctx.db.withTx(async (tx: HostedDynamic) => {
      await upsertArtifact(tx, {
        runId: run.id,
        kind: "clip",
        key: clipKey,
        sha256: storedVideo.sha256,
        size: storedVideo.size,
      });
      if (storedVtt) {
        await upsertArtifact(tx, {
          runId: run.id,
          kind: "clip_vtt",
          key: vttKey,
          sha256: storedVtt.sha256,
          size: storedVtt.size,
        });
      }
      if (dispatchId) {
        await tx.query(
          `UPDATE dispatches SET status = 'concluded', concluded_at = now(), error = NULL WHERE id = $1`,
          [dispatchId],
        );
      }
      await audit(tx, {
        actor,
        action: "run.clip_created",
        entityType: "run",
        entityId: run.id,
        projectId: project.id,
        detail: { captions: request.captions, burn: request.burn, sha256: storedVideo.sha256 },
      });
      await emitPlatformEvent(tx, {
        projectId: project.id,
        type: "clip.created",
        entity: { run_id: run.id },
        payload: { run_id: run.id, captions: request.captions, burn: request.burn, size: storedVideo.size },
      });
    });
    return { key: clipKey, sha256: storedVideo.sha256, size: storedVideo.size };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

export function startClip(ctx: HostedDynamic, { run, project, actor, request, dispatchId = null }: HostedDynamic) {
  generateClip(ctx, { run, project, actor, request, dispatchId }).catch(async (e) => {
    ctx.log.error({ msg: "clip generation failed", runId: run.id, err: e?.stack || String(e) });
    try {
      await ctx.db.withTx(async (tx: HostedDynamic) => {
        if (dispatchId) {
          await tx.query(
            `UPDATE dispatches SET status = 'concluded', concluded_at = now(), error = $2 WHERE id = $1`,
            [dispatchId, firstLine(e)],
          );
        }
        await appendRunEvent(tx, {
          runDbId: run.id,
          projectId: project.id,
          type: "clip_failed",
          payload: { error: firstLine(e) },
        });
      });
    } catch {}
  });
}

async function materializeBundle(provider: HostedDynamic, dir: HostedDynamic) {
  await fsp.mkdir(dir, { recursive: true });
  for (const name of Object.keys(provider.entries)) {
    if (name === "ptrun.json") continue;
    const abs = path.join(dir, ...name.split("/"));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const chunks: HostedDynamic[] = [];
    for await (const c of provider.createReadStream(name)) chunks.push(c);
    await fsp.writeFile(abs, Buffer.concat(chunks));
  }
}

async function upsertArtifact(tx: HostedDynamic, { runId, kind, key, sha256, size }: HostedDynamic) {
  await tx.query(
    `INSERT INTO artifacts (id, run_id, kind, key, sha256, size, tier, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'full', now())
     ON CONFLICT (run_id, kind, tier)
       DO UPDATE SET key = EXCLUDED.key, sha256 = EXCLUDED.sha256, size = EXCLUDED.size, verified_at = now()`,
    [ulid(), runId, kind, key, sha256, size],
  );
}
