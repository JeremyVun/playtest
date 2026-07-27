import YAML from "yaml";
import { ulid } from "../ulid.ts";
import { audit, actorOf } from "../audit.ts";
import { AppError, badRequest, conflict, notFound } from "../errors.ts";
import { loadTreeFiles } from "../suites/snapshots.ts";
import { resolveSnapshotCases } from "../suites/resolve.ts";
import { newRunId } from "@playtest/core/artifacts";
import { defaultModels } from "@playtest/core/llm";
import { emitPlatformEvent } from "../events/outbox.ts";
import { inClause } from "../db.ts";

const ACTIVE_DISPATCHES = ["requested", "scheduled", "running"];

export async function createRunGroup(ctx: HostedDynamic, { principal, project, suite, environment, selection, note = null }: HostedDynamic) {
  selection = normalizeSelection(selection);
  if (!ctx.github?.enabled) {
    // A test/local mock sets ctx.github.enabled=true. Without that or real GitHub
    // App config, launching would create a permanently queued group.
    throw new AppError("config_error", "GitHub dispatch is not configured and no local dispatch mock is installed");
  }
  const active = await ctx.db.query(
    `SELECT COUNT(*) AS n FROM dispatches
      WHERE project_id = $1 AND status IN (${inClause(ACTIVE_DISPATCHES, 2)})`,
    [project.id, ...ACTIVE_DISPATCHES],
  );
  if (active.rows[0].n >= ctx.config.dispatch.maxActivePerProject) {
    throw conflict(`project "${project.key}" already has ${active.rows[0].n} active dispatches`);
  }

  const snapshot = await latestSnapshot(ctx, suite.id);
  const resolved = await resolveSnapshotCases(snapshot.id, () => loadTreeFiles(ctx.store, snapshot.tree));
  const cases = selectCases(resolved.cases, selection);
  if (!cases.length) throw badRequest("run selection matched no cases");
  requireDiscoveryAllowed(cases, environment);

  // The snapshot tree carries no results/ dir, so core next_run always says
  // "record" — hosted, the baselines table is the source of truth for whether
  // a story acts or records (the executor materializes results/ from it, §3).
  const baselineStories = new Set(
    (
      await ctx.db.query(
        `SELECT DISTINCT story_id FROM baselines WHERE suite_id = $1 AND superseded_by IS NULL`,
        [suite.id],
      )
    ).rows.map((r: HostedDynamic) => r.story_id),
  );

  const groupId = ulid();
  const dispatchId = ulid();
  const runs = cases.map((c: HostedDynamic) => ({
    id: ulid(),
    run_group_id: groupId,
    case_id: c.id,
    story_id: c.story_id || c.id,
    run_id: newRunId(),
    status: "queued",
    mode: plannedMode(c, selection, baselineStories),
  }));

  await ctx.db.withTx(async (tx: HostedDynamic) => {
    await tx.query(
      `INSERT INTO run_groups
         (id, project_id, suite_id, snapshot_id, environment_id, trigger, selection, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')`,
      [
        groupId,
        project.id,
        suite.id,
        snapshot.id,
        environment.id,
        triggerFor(principal, note),
        normalizeSelection(selection),
      ],
    );
    for (const r of runs) {
      await tx.query(
        `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.id, r.run_group_id, r.case_id, r.story_id, r.run_id, r.status, r.mode],
      );
    }
    await tx.query(
      `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status)
         VALUES ($1, $2, 'group', $3, 1, 'requested')`,
      [dispatchId, project.id, groupId],
    );
    await audit(tx, {
      actor: actorOf(principal),
      action: "run_group.created",
      entityType: "run_group",
      entityId: groupId,
      projectId: project.id,
      detail: { suite_id: suite.id, snapshot_id: snapshot.id, environment_id: environment.id, cases: runs.length, note },
    });
    await emitPlatformEvent(tx, {
      projectId: project.id,
      type: "run.status",
      entity: { run_group_id: groupId },
      payload: { status: "queued", cases: runs.length },
    });
  });

  await dispatchAttempt(ctx, {
    dispatchId,
    projectId: project.id,
    kind: "group",
    refId: groupId,
    attempt: 1,
    labels: environment.runner_labels || [],
  });

  return {
    run_group: await getRunGroupView(ctx, groupId),
    runs: runs.map(runView),
  };
}

/**
 * The staging-only guardrail: discovery agents
 * genuinely click buy/delete/submit, so discovery cases only run on an
 * environment a developer explicitly marked `discovery_allowed`.
 */
function requireDiscoveryAllowed(cases: HostedDynamic, environment: HostedDynamic) {
  const discovery = cases.filter((c: HostedDynamic) => c.mode === "discovery");
  if (discovery.length && !environment.discovery_allowed) {
    throw badRequest(
      `this selection includes ${discovery.length} discovery ${discovery.length === 1 ? "story" : "stories"}, ` +
        `but environment "${environment.name}" is not marked as allowing discovery. Discovery agents really ` +
        `click buy, delete and submit — point the study at a staging environment and enable ` +
        `"Allow discovery studies" for it under Settings → Environments.`,
    );
  }
}

/**
 * Launch preview: the same resolution + planning a
 * launch would do, read-only — one row per would-be run (personas fanned out,
 * planned mode decided) plus an HONEST cost estimate. Estimates come from this
 * suite's own finished runs (per story+mode, falling back to per mode); a
 * story with no history estimates null, never a made-up number.
 */
export async function previewRunGroup(ctx: HostedDynamic, { project, suite, environment, selection }: HostedDynamic) {
  selection = normalizeSelection(selection);
  const snapshot = await latestSnapshot(ctx, suite.id);
  const resolved = await resolveSnapshotCases(snapshot.id, () => loadTreeFiles(ctx.store, snapshot.tree));
  const cases = selectCases(resolved.cases, selection);
  const baselineStories = new Set(
    (
      await ctx.db.query(
        `SELECT DISTINCT story_id FROM baselines WHERE suite_id = $1 AND superseded_by IS NULL`,
        [suite.id],
      )
    ).rows.map((r: HostedDynamic) => r.story_id),
  );
  const history = await runCostHistory(ctx, suite.id);
  const rows = cases.map((c: HostedDynamic) => {
    const mode = plannedMode(c, selection, baselineStories);
    const est = history.byStoryMode.get(`${c.story_id || c.id}|${mode}`) ?? history.byMode.get(mode) ?? null;
    return {
      id: c.id,
      story_id: c.story_id,
      description: c.description,
      persona: c.persona,
      mode,
      limits: effectiveLimits(c, selection),
      est_cost_usd: est?.cost ?? null,
      est_duration_ms: est?.ms ?? null,
    };
  });
  const known = rows.filter((r: HostedDynamic) => r.est_cost_usd != null);
  const discovery = rows.filter((r: HostedDynamic) => r.mode === "explore");
  return {
    cases: rows,
    total_runs: rows.length,
    estimate: {
      // Sum of the known per-run estimates; honest about coverage — the UI
      // must say "no cost history yet" rather than print $0.00 as a estimate.
      est_total_usd: known.length ? known.reduce((a: HostedDynamic, r: HostedDynamic) => a + r.est_cost_usd, 0) : null,
      known_runs: known.length,
    },
    discovery: {
      runs: discovery.length,
      allowed: environment.discovery_allowed === true,
    },
    target: resolveTarget(resolved.defaults, environment),
    models: resolveModels(resolved.defaults, project),
  };
}

/**
 * Which models will this launch actually use? Mirrors the materialization
 * precedence per key (runner workspace.ts mergeOverlay + core defaults merge):
 * the suite's root playtest.yaml beats the project's default, which beats the
 * engine built-in — said out loud like `target`, so the launch dialog never
 * implies a model the run won't use. A case or deeper playtest.yaml override
 * still wins at run time; those are per-story choices the run's manifest pins
 * record, not launch-wide facts to preview here.
 * `defaultsYaml` is the snapshot's raw playtest.yaml (cache entry), or null.
 */
function resolveModels(defaultsYaml: HostedDynamic, project: HostedDynamic) {
  let doc: HostedDynamic = {};
  try {
    doc = YAML.parse(defaultsYaml || "") || {};
  } catch { /* unparseable defaults — the validate path reports that; preview degrades */ }
  const str = (v: HostedDynamic) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const pick = (key: HostedDynamic) => {
    const suite = str(doc[key]);
    const proj = str(project.models?.[key]);
    return {
      value: suite ?? proj ?? defaultModels[key as keyof typeof defaultModels],
      source: suite ? "suite" : proj ? "project" : "default",
    };
  };
  return { actor_model: pick("actor_model"), grader_model: pick("grader_model") };
}

/**
 * Where will this launch actually point? Mirrors the materialization precedence
 * (runner workspace.ts mergeOverlay + core app.envs): the suite's own
 * app.envs.<name> beats the environment record's declared keys, which beat the
 * suite's top-level base_url. Silent-wrong-target was the launch dialog's worst
 * trap — the UI says the resolved URL and who won out loud.
 * `defaultsYaml` is the snapshot's raw playtest.yaml (cache entry), or null.
 */
function resolveTarget(defaultsYaml: HostedDynamic, environment: HostedDynamic) {
  let app: HostedDynamic = {};
  try {
    app = YAML.parse(defaultsYaml || "")?.app || {};
  } catch { /* unparseable defaults — the validate path reports that; preview degrades */ }
  const str = (v: HostedDynamic) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const suiteEnvBase = str(app?.envs?.[environment.name]?.base_url);
  const envBase = str(environment.config?.app?.base_url);
  const suiteBase = str(app?.base_url);
  const resolved = suiteEnvBase ?? envBase ?? suiteBase;
  return {
    resolved_base_url: resolved,
    source: suiteEnvBase ? "suite-env" : envBase ? "environment" : suiteBase ? "suite" : null,
    suite_base_url: suiteBase,
    environment_base_url: envBase,
  };
}

/**
 * Average cost/duration of this suite's finished runs, per (story, mode) and
 * per mode. The runs row holds the mode planned at dispatch, while the manifest
 * holds what actually happened. An act replay can escalate to a costly heal;
 * classifying that spend as act history would charge the next clean replay for
 * the previous repair.
 */
async function runCostHistory(ctx: HostedDynamic, suiteId: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT r.story_id,
            COALESCE(json_extract(r.manifest, '$.mode'), r.mode) AS mode,
            AVG(CAST(json_extract(r.totals, '$.cost_usd') AS REAL)) AS cost,
            CAST(AVG(r.duration_ms) AS INTEGER) AS ms,
            COUNT(*) AS n
       FROM runs r JOIN run_groups g ON g.id = r.run_group_id
      WHERE g.suite_id = $1 AND r.status IN ('pass','fail','explored')
        AND json_extract(r.totals, '$.cost_usd') IS NOT NULL
      GROUP BY r.story_id, COALESCE(json_extract(r.manifest, '$.mode'), r.mode)`,
    [suiteId],
  );
  const byStoryMode = new Map();
  const perMode = new Map(); // mode -> {cost, ms, n} accumulators
  for (const r of rows) {
    const entry: HostedDynamic = { cost: Number(r.cost), ms: r.ms == null ? null : Number(r.ms) };
    byStoryMode.set(`${r.story_id}|${r.mode}`, entry);
    const acc = perMode.get(r.mode) ?? { cost: 0, ms: 0, n: 0 };
    acc.cost += Number(r.cost) * r.n;
    acc.ms += (r.ms == null ? 0 : Number(r.ms)) * r.n;
    acc.n += r.n;
    perMode.set(r.mode, acc);
  }
  const byMode = new Map(
    [...perMode].map(([mode, a]) => [mode, { cost: a.cost / a.n, ms: a.n ? Math.round(a.ms / a.n) : null }]),
  );
  return { byStoryMode, byMode };
}

export async function dispatchAttempt(ctx: HostedDynamic, { dispatchId, projectId, kind, refId, attempt, labels }: HostedDynamic) {
  const result = await ctx.github.dispatchWorkflow({ dispatchId, kind, refId, labels, attempt });
  await ctx.db.query(
    `UPDATE dispatches
        SET status = 'scheduled', workflow_run_id = $2, workflow_run_url = $3
      WHERE id = $1`,
    [dispatchId, result.workflow_run_id ?? null, result.workflow_run_url ?? null],
  );
  await ctx.db.query(`UPDATE run_groups SET status = 'running', updated_at = now() WHERE id = $1`, [refId]);
  await emitPlatformEvent(ctx.db, {
    projectId,
    type: "run.status",
    entity: { run_group_id: refId },
    payload: { status: "provisioning", dispatch_id: dispatchId, workflow_run_url: result.workflow_run_url ?? null },
  });
}

export async function dispatchContinuation(ctx: HostedDynamic, groupId: HostedDynamic) {
  const group = await getRunGroup(ctx, groupId);
  const env = await getEnvironment(ctx, group.environment_id);
  const attemptRow = await ctx.db.query(
    `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM dispatches WHERE kind = 'group' AND ref_id = $1`,
    [group.id],
  );
  const attempt = attemptRow.rows[0].attempt;
  const dispatchId = ulid();
  await ctx.db.query(
    `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status)
       VALUES ($1, $2, 'group', $3, $4, 'requested')`,
    [dispatchId, group.project_id, group.id, attempt],
  );
  await dispatchAttempt(ctx, {
    dispatchId,
    projectId: group.project_id,
    kind: "group",
    refId: group.id,
    attempt,
    labels: env.runner_labels || [],
  });
  return dispatchId;
}

export async function getRunGroup(ctx: HostedDynamic, id: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM run_groups WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound(`no run group "${id}"`);
  return rows[0];
}

export async function getRunGroupView(ctx: HostedDynamic, id: HostedDynamic) {
  const group = await getRunGroup(ctx, id);
  // One windowed pass over artifacts replaces the two per-run LATERAL … LIMIT 1
  // subqueries: rn = 1 is the newest row of each (run, kind), joined twice.
  // The CTE cannot be called `artifacts` — SQLite reads that as a self-reference.
  const { rows } = await ctx.db.query(
    `WITH latest_artifacts AS (
       SELECT run_id, kind, key, sha256, size, tier,
              row_number() OVER (PARTITION BY run_id, kind ORDER BY created_at DESC) AS rn
         FROM artifacts
     )
     SELECT r.*,
            a.key AS bundle_key, a.sha256 AS bundle_sha256, a.size AS bundle_size, a.tier AS bundle_tier,
            c.key AS clip_key, c.sha256 AS clip_sha256, c.size AS clip_size
       FROM runs r
       LEFT JOIN latest_artifacts a ON a.run_id = r.id AND a.kind = 'bundle' AND a.rn = 1
       LEFT JOIN latest_artifacts c ON c.run_id = r.id AND c.kind = 'clip' AND c.rn = 1
      WHERE r.run_group_id = $1
      ORDER BY r.case_id`,
    [id],
  );
  return {
    ...group,
    runs: rows.map(runView),
  };
}

async function getEnvironment(ctx: HostedDynamic, id: HostedDynamic) {
  const { rows } = await ctx.db.query(`SELECT * FROM environments WHERE id = $1`, [id]);
  if (!rows[0]) throw notFound(`no environment "${id}"`);
  return rows[0];
}

async function latestSnapshot(ctx: HostedDynamic, suiteId: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT * FROM suite_snapshots WHERE suite_id = $1 ORDER BY seq DESC LIMIT 1`,
    [suiteId],
  );
  if (!rows[0]) throw badRequest("suite has no committed snapshot to run");
  return rows[0];
}

function selectCases(cases: HostedDynamic, selection: HostedDynamic = {}) {
  const ids = new Set(selection.ids || []);
  const paths = new Set(selection.paths || []);
  const tags = new Set(selection.tags || []);
  return cases.filter((c: HostedDynamic) => {
    if (ids.size && !ids.has(c.id)) return false;
    if (paths.size && !paths.has(c.path)) return false;
    if (tags.size && !(c.tags || []).some((t: HostedDynamic) => tags.has(t))) return false;
    return true;
  });
}

function plannedMode(c: HostedDynamic, selection: HostedDynamic = {}, baselineStories: HostedDynamic = new Set()) {
  if (c.mode === "discovery") return "explore";
  if (selection.refresh || selection.mode === "agent") return "record";
  // c is a suites/resolve.js projection: the persona-independent story key is
  // snake_case story_id (personas of one story share a baseline lineage).
  return baselineStories.has(c.story_id || c.id) ? "act" : "record";
}

function effectiveLimits(c: HostedDynamic, selection: HostedDynamic = {}) {
  return {
    max_steps: selection.max_steps ?? c.limits?.max_steps ?? null,
    timeout_ms: selection.timeout_ms ?? c.limits?.timeout_ms ?? null,
  };
}

function normalizeSelection(selection: HostedDynamic = {}) {
  const maxSteps = selection.max_steps;
  const timeoutMs = selection.timeout_ms;
  if (maxSteps !== undefined && (!Number.isSafeInteger(maxSteps) || maxSteps < 1)) {
    throw badRequest(`"selection.max_steps" must be a positive integer`);
  }
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) {
    throw badRequest(`"selection.timeout_ms" must be a positive integer`);
  }
  return {
    paths: Array.isArray(selection.paths) ? selection.paths : undefined,
    tags: Array.isArray(selection.tags) ? selection.tags : undefined,
    ids: Array.isArray(selection.ids) ? selection.ids : undefined,
    mode: selection.mode === "agent" ? "agent" : "auto",
    refresh: selection.refresh === true,
    max_steps: maxSteps,
    timeout_ms: timeoutMs,
    retry_remaining: Number.isInteger(selection.retry_remaining) ? selection.retry_remaining : 1,
  };
}

function triggerFor(principal: HostedDynamic, note: HostedDynamic) {
  return {
    kind: principal.kind === "token" ? "api" : "manual",
    ...(principal.kind === "user" ? { user_id: principal.userId } : { token_id: principal.tokenId }),
    ...(note ? { note } : {}),
  };
}

function runView(r: HostedDynamic) {
  return {
    id: r.id,
    run_group_id: r.run_group_id,
    case_id: r.case_id,
    story_id: r.story_id,
    run_id: r.run_id,
    status: r.status,
    mode: r.mode,
    healed: r.healed,
    changed: r.changed,
    score: r.score,
    // The bundle's manifest.totals verbatim — the dashboard's steps/cost line
    // accrues from these as cases finish (UX run-group screen).
    totals: r.totals ?? null,
    duration_ms: r.duration_ms,
    started_at: r.started_at,
    finished_at: r.finished_at,
    // Live telemetry while in flight (step, mode word, last action, cost so
    // far); the case report clears it, so a finished run never carries one.
    progress: r.progress ?? null,
    error: r.error,
    end_reason: r.manifest?.result?.end_reason ?? null,
    limits: r.manifest?.case?.limits ?? null,
    artifact_tier: r.artifact_tier ?? "full",
    retention_pruned_at: r.retention_pruned_at ?? null,
    retention_provenance: r.retention_provenance ?? null,
    artifact: r.bundle_key ? { key: r.bundle_key, sha256: r.bundle_sha256, size: r.bundle_size, tier: r.bundle_tier } : null,
    clip: r.clip_key ? { key: r.clip_key, sha256: r.clip_sha256, size: r.clip_size } : null,
  };
}
