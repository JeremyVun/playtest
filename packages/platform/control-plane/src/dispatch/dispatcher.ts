import YAML from "yaml";
import { ulid } from "../ulid.ts";
import { audit, actorOf } from "../audit.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { loadTreeFiles } from "../suites/snapshots.ts";
import { resolveSnapshotCases } from "../suites/resolve.ts";
import { newRunId } from "@playtest/core/artifacts";
import { defaultModels } from "@playtest/core/llm";
import { emitPlatformEvent } from "../events/outbox.ts";
import { inClause } from "../db.ts";
import { checkInWindowMs } from "./pool.ts";
import { labelsMatch } from "../auth/runner-credentials.ts";

const ACTIVE_DISPATCHES = ["requested", "scheduled", "running"];

/**
 * Which labels place this group. A launch may pin them (`runner_labels` on the
 * launch request), which OVERRIDES the ring's for that group only — the CI case:
 * two concurrent pipelines share one ring but each has to reach its own build's
 * runner, and a ring per pipeline would be a permanent object created for a
 * five-minute job.
 *
 * The pin rides the group, so every later attempt (continuation after a partial
 * completion, in-place retry) is placed the way the original was even if someone
 * edits the ring in between.
 */
export function groupDispatchLabels(group: HostedDynamic, ring: HostedDynamic): string[] {
  return group?.runner_labels ?? ring?.runner_labels ?? [];
}

/**
 * The NON-SECRET target snapshot a dispatch attempt records, and the only thing
 * its offer and its group spec ever serve. A ring edit between preview, poll,
 * claim and exchange therefore cannot make them disagree; a retry snapshots
 * current ring state, which is the documented retry behavior.
 *
 * Secrets are deliberately absent — they are resolved when the group spec is
 * served, after the claim and the credential exchange.
 */
export function targetSnapshot(application: HostedDynamic, ring: HostedDynamic, labels: string[]) {
  return {
    application_id: application.id,
    application_key: application.key,
    ring_id: ring.id,
    ring_key: ring.key,
    driver: application.driver,
    platform: application.platform ?? null,
    base_url: ring.base_url ?? null,
    labels,
    config: ring.config ?? {},
  };
}

export async function createRunGroup(ctx: HostedDynamic, { principal, project, suite, application, ring, selection, note = null, runnerLabels = null }: HostedDynamic) {
  selection = normalizeSelection(selection);
  requireDispatchableDriver(application);
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
  requireApplicationDriver(cases, application);
  requireDiscoveryAllowed(cases, application, ring);

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

  // Pinned at launch, or inherited from the ring. `runner_labels` on the group
  // is NULL unless this launch pinned them, so a group reads back saying whether
  // its placement was a launch decision or the ring's standing one.
  const labels = runnerLabels ?? ring.runner_labels ?? [];
  const target = targetSnapshot(application, ring, labels);

  await ctx.db.withTx(async (tx: HostedDynamic) => {
    // The launch transaction is where suite, ring and application are made to
    // agree: a stale client or a hand-written API call must not be able to pin a
    // group whose three references contradict each other.
    const agree = await tx.query(
      `SELECT s.application_id AS suite_app, r.application_id AS ring_app
         FROM suites s, rings r WHERE s.id = $1 AND r.id = $2`,
      [suite.id, ring.id],
    );
    const row = agree.rows[0];
    if (!row || row.suite_app !== application.id || row.ring_app !== application.id) {
      throw conflict(
        `suite "${suite.slug}" and ring "${ring.key}" no longer agree on their application — ` +
          `reload the launch dialog and pick a ring of this suite's application`,
      );
    }
    await tx.query(
      `INSERT INTO run_groups
         (id, project_id, suite_id, snapshot_id, application_id, ring_id, trigger, selection, status, runner_labels)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', $9)`,
      [
        groupId,
        project.id,
        suite.id,
        snapshot.id,
        application.id,
        ring.id,
        triggerFor(principal, note),
        normalizeSelection(selection),
        runnerLabels,
      ],
    );
    for (const r of runs) {
      await tx.query(
        `INSERT INTO runs (id, run_group_id, case_id, story_id, run_id, status, mode)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.id, r.run_group_id, r.case_id, r.story_id, r.run_id, r.status, r.mode],
      );
    }
    // The labels and target snapshots ride the ledger row, written in the same
    // transaction: under pull-based placement this row IS the claim-board entry,
    // so a runner must never be able to read it before what places it is durable.
    await tx.query(
      `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status, labels, target)
         VALUES ($1, $2, 'group', $3, 1, 'requested', $4, $5)`,
      [dispatchId, project.id, groupId, labels, target],
    );
    await audit(tx, {
      actor: actorOf(principal),
      action: "run_group.created",
      entityType: "run_group",
      entityId: groupId,
      projectId: project.id,
      detail: {
        suite_id: suite.id,
        snapshot_id: snapshot.id,
        application: application.key,
        ring: ring.key,
        cases: runs.length,
        note,
        // Placement is auditable: a pin says who chose it; the ring's own labels
        // are already readable from the ring.
        ...(runnerLabels ? { runner_labels: runnerLabels } : {}),
      },
    });
    await emitPlatformEvent(tx, {
      projectId: project.id,
      type: "run.status",
      entity: { run_group_id: groupId },
      payload: { status: "queued", cases: runs.length },
    });
  });

  await dispatchAttempt(ctx, { dispatchId, kind: "group", refId: groupId, labels });

  return {
    run_group: await getRunGroupView(ctx, groupId),
    runs: runs.map(runView),
  };
}

/**
 * Hosted mobile is dark until runner bindings land (R3 of the runner refactor).
 * Refuse the launch here rather than letting a group nothing can execute sit on
 * the claim board until its unclaimed timeout.
 */
function requireDispatchableDriver(application: HostedDynamic) {
  if (application.driver !== "mobile") return;
  throw badRequest(
    `"${application.key}" is a mobile application, and hosted mobile placement lands with runner bindings — ` +
      `a runner declares which application and ring it can build for in its own configuration file, and no ` +
      `runner can claim this work yet. Run mobile cases from the CLI in the meantime.`,
  );
}

/**
 * The staging-only guardrail: discovery agents genuinely click buy/delete/submit,
 * so discovery cases only run on a ring a developer explicitly opened.
 */
function requireDiscoveryAllowed(cases: HostedDynamic, application: HostedDynamic, ring: HostedDynamic) {
  const discovery = cases.filter((c: HostedDynamic) => c.mode === "discovery");
  if (discovery.length && !ring.discovery_allowed) {
    throw badRequest(
      `this selection includes ${discovery.length} discovery ${discovery.length === 1 ? "story" : "stories"}, ` +
        `but ring "${application.key}/${ring.key}" is not marked as allowing discovery. Discovery agents really ` +
        `click buy, delete and submit — point the study at a staging ring and enable ` +
        `"Allow discovery studies" for it.`,
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
export async function previewRunGroup(ctx: HostedDynamic, { project, suite, application, ring, selection, runnerLabels = null }: HostedDynamic) {
  selection = normalizeSelection(selection);
  const snapshot = await latestSnapshot(ctx, suite.id);
  const resolved = await resolveSnapshotCases(snapshot.id, () => loadTreeFiles(ctx.store, snapshot.tree));
  const cases = selectCases(resolved.cases, selection);
  requireApplicationDriver(cases, application);
  const labels = runnerLabels ?? ring.runner_labels ?? [];
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
      allowed: ring.discovery_allowed === true,
    },
    // Placement said out loud before launch: the labels this run would need, who
    // chose them, and whether a runner advertising them is actually online.
    placement: {
      runner_labels: labels,
      labels_source: runnerLabels ? "launch" : "ring",
      runner_online: await labelMatchingRunnerOnline(ctx, project.id, labels),
    },
    // The target, stated as the model states it: the application and ring this
    // launch resolves to, and the URL a web/API run points at. For mobile there
    // is no URL and no binary to report — the claiming runner supplies the
    // build, and the platform never inspects one.
    target: {
      application: { id: application.id, key: application.key, name: application.name, driver: application.driver, platform: application.platform ?? null },
      ring: { id: ring.id, key: ring.key, name: ring.name },
      resolved_base_url: ring.base_url ?? null,
      build_supplied_by_runner: application.driver === "mobile",
    },
    models: resolveModels(resolved.defaults, project),
  };
}

/**
 * Is a runner advertising these labels checked in right now? A preview that says
 * "nothing here can take this" beats a launch that sits queued until its
 * unclaimed timeout.
 */
async function labelMatchingRunnerOnline(ctx: HostedDynamic, projectId: HostedDynamic, labels: string[]) {
  const windowMs = checkInWindowMs(ctx.config.dispatch.pool);
  const { rows } = await ctx.db.query(
    `SELECT labels FROM runners
      WHERE project_id = $1 AND revoked_at IS NULL AND last_seen_at IS NOT NULL AND last_seen_at > $2`,
    [projectId, new Date(Date.now() - windowMs)],
  );
  return rows.some((r: HostedDynamic) => labelsMatch(labels, r.labels || []));
}

/**
 * A suite has no driver column — its case files do. So the one check that
 * survives is: every resolved case's driver must equal the application's. A
 * `driver: mobile` case inside a web application's suite stays expressible and
 * must be refused here, at preview and at launch, so a stale client or a
 * hand-written API call cannot cross the boundary either.
 */
function requireApplicationDriver(cases: HostedDynamic[], application: HostedDynamic) {
  const drivers = [...new Set(cases.map((c: HostedDynamic) => c.driver ?? "web"))];
  const wrong = drivers.filter((driver) => driver !== application.driver);
  if (!wrong.length) return;
  throw badRequest(
    `this selection has ${wrong.map((d) => `"${d}"`).join(", ")} ${wrong.length === 1 ? "case" : "cases"}, ` +
      `but they belong to application "${application.key}", which is a "${application.driver}" surface — ` +
      `move those stories to a suite bound to a matching application`,
  );
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

/**
 * Post an attempt to the claim board. Nothing is started and nothing is
 * contacted: the `requested` ledger row plus its labels and target snapshots IS
 * the board entry, and the winning CLAIM (`api/pool.ts`) is what moves it to
 * `scheduled`, flips the group to running, and emits the provisioning event.
 */
export async function dispatchAttempt(ctx: HostedDynamic, { dispatchId, kind, refId, labels }: HostedDynamic) {
  await ctx.board.postDispatch({ dispatchId, kind, refId, labels });
}

export async function dispatchContinuation(ctx: HostedDynamic, groupId: HostedDynamic) {
  const group = await getRunGroup(ctx, groupId);
  const { application, ring } = await groupTarget(ctx, group);
  const attemptRow = await ctx.db.query(
    `SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM dispatches WHERE kind = 'group' AND ref_id = $1`,
    [group.id],
  );
  const attempt = attemptRow.rows[0].attempt;
  const dispatchId = ulid();
  const labels = groupDispatchLabels(group, ring);
  // A continuation snapshots CURRENT ring state, exactly as a retry does: the
  // next attempt runs against the ring as it is now, and its own snapshot is
  // what its offer and group spec will serve.
  await ctx.db.query(
    `INSERT INTO dispatches (id, project_id, kind, ref_id, attempt, status, labels, target)
       VALUES ($1, $2, 'group', $3, $4, 'requested', $5, $6)`,
    [dispatchId, group.project_id, group.id, attempt, labels, targetSnapshot(application, ring, labels)],
  );
  await dispatchAttempt(ctx, { dispatchId, kind: "group", refId: group.id, labels });
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
  const { application, ring } = await groupTarget(ctx, group);
  return {
    ...group,
    // Where this group ran, by name rather than by opaque id — the Runs index
    // and the run page both read it, and neither should have to join.
    application: { id: application.id, key: application.key, name: application.name, driver: application.driver, platform: application.platform ?? null },
    ring: { id: ring.id, key: ring.key, name: ring.name, base_url: ring.base_url ?? null },
    runs: rows.map(runView),
    placement: await placementView(ctx, group),
  };
}

/**
 * What produced this group's evidence: the newest attempt's placement, the
 * self-hosted runner that claimed it (pool dispatch only — the other adapters
 * leave `runner_id` null), and the isolation that runner reported at the
 * exchange. Evidence trust is stated, not laundered: a persistent shared runner
 * without per-case containers is visible as `process` here.
 */
async function placementView(ctx: HostedDynamic, group: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT d.id, d.attempt, d.status, d.runner_id, d.labels, r.name AS runner_name, e.isolation
       FROM dispatches d
       LEFT JOIN runners r ON r.id = d.runner_id
       LEFT JOIN executors e ON e.id = d.executor_id
      WHERE d.kind = 'group' AND d.ref_id = $1
      ORDER BY d.attempt DESC, d.requested_at DESC LIMIT 1`,
    [group.id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    dispatch_id: row.id,
    attempt: row.attempt ?? null,
    isolation: row.isolation ?? null,
    runner: row.runner_id ? { id: row.runner_id, name: row.runner_name ?? null } : null,
    // Which labels this attempt was placed on, and whether the launch chose them
    // or the ring did. Placement is auditable after the fact, not only in the
    // moment someone clicked launch.
    labels: row.labels ?? [],
    labels_source: group.runner_labels ? "launch" : "ring",
  };
}

/** The (application, ring) a group pinned at launch. Both are ON DELETE RESTRICT, so both exist. */
export async function groupTarget(ctx: HostedDynamic, group: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT r.*, a.key AS application_key, a.name AS application_name,
            a.driver AS application_driver, a.platform AS application_platform
       FROM rings r JOIN applications a ON a.id = r.application_id
      WHERE r.id = $1`,
    [group.ring_id],
  );
  if (!rows[0]) throw notFound(`no ring "${group.ring_id}"`);
  const row = rows[0];
  return {
    ring: row,
    application: {
      id: row.application_id,
      key: row.application_key,
      name: row.application_name,
      driver: row.application_driver,
      platform: row.application_platform ?? null,
    },
  };
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
