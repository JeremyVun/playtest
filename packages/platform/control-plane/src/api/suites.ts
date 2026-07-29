// Suites of record (docs/contracts/hosted.md#suites-and-snapshots). `suite_files` is the
// live working tree (always fully valid — every mutation validates the whole tree
// with core before committing); each mutation also writes one immutable, content-
// addressed `suite_snapshots` row. There is ONE resolver (core discoverCases, run
// server-side over a materialized temp tree). Export/import is a tar round-trip so a
// suite moves freely between the hosted DB and a git repo.
import { ulid } from "../ulid.ts";
import { audit, actorOf } from "../audit.ts";
import { created } from "../http.ts";
import { readJsonBody, readRawBody, tar } from "../http.ts";
import {
  requireAuth,
  guard,
  getProjectByKey,
  getSuite,
  slugField,
  stringField,
  parsePagination,
} from "./util.ts";
import { badRequest, conflict, notFound, forbidden, validationFailed } from "../errors.ts";
import { kindForPath, isCodeKind, normalizePath } from "../suites/paths.ts";
import { contentTree, putBlobs, loadTreeFiles } from "../suites/snapshots.ts";
import { resolveCases, validateTree, lintTree } from "../suites/resolve.ts";
import { writeTar, readTar } from "../suites/tar.ts";

// ---------- suite CRUD ----------

// story_count is the count of story FILES (kind='case'). The working tree always
// fully validates, so every case-kind file is a resolvable story; a discovery
// story with persona fan-out counts once (it is one story). This is what lets
// list consumers show story counts without resolving N trees.
const STORY_COUNT_SQL = `(SELECT COUNT(*) FROM suite_files f
     WHERE f.suite_id = s.id AND f.kind = 'case') AS story_count`;

/** The bound application, folded into every suite read that renders a picker. */
const APPLICATION_JOIN_SQL = `a.key AS application_key, a.name AS application_name,
     a.driver AS application_driver, a.platform AS application_platform`;

/** GET /projects/:p/suites — live suites; ?archived=1 lists the archived ones instead. */
export async function listSuites(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const archived = ctx.query.get("archived") === "1" || ctx.query.get("archived") === "true";
  const { rows } = await ctx.db.query(
    `SELECT s.*, ${STORY_COUNT_SQL}, ${APPLICATION_JOIN_SQL}
       FROM suites s JOIN applications a ON a.id = s.application_id
      WHERE s.project_id = $1 AND s.archived = $2 ORDER BY s.slug`,
    [project.id, archived],
  );
  return { items: rows.map(suiteView) };
}

/**
 * PATCH /suites/:s {archived} — archive/unarchive. Archived suites disappear
 * from the default list (and with it the launcher) but stay reachable by slug;
 * nothing about them is deleted, so unarchive is always safe.
 */
export async function patchSuite(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const suite = await getSuite(ctx, ctx.params.s);
  guard(ctx, suite.project_id, "editor");
  const body = await readJsonBody(ctx.req);
  if (typeof body.archived !== "boolean") throw badRequest(`"archived" (boolean) is required`);
  if (body.archived === suite.archived) return suiteView(suite);
  const updated = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(
      `UPDATE suites SET archived = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [suite.id, body.archived],
    );
    await audit(tx, {
      actor: actorOf(p),
      action: body.archived ? "suite.archived" : "suite.unarchived",
      entityType: "suite",
      entityId: suite.id,
      projectId: suite.project_id,
      detail: { slug: suite.slug },
    });
    return rows[0];
  });
  return suiteView(updated);
}

/**
 * DELETE /suites/:s — permanent, and legal ONLY while the suite has no run
 * groups (the typo'd-suite case). Runs anchor baselines, candidates and finding
 * evidence; deleting a suite with history would either cascade evidence away or
 * dangle references — archive is the retirement path. The pre-check gives the
 * friendly message; the run_groups FK (ON DELETE RESTRICT) backstops it.
 *
 * `withTx` opens BEGIN IMMEDIATE, so the count and the delete are serialized
 * against a concurrent launch: either the run group commits first and the count
 * sees it, or the suite is gone and the group's FK rejects it.
 */
export async function deleteSuite(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const suite = await getSuite(ctx, ctx.params.s);
  guard(ctx, suite.project_id, "editor");
  await ctx.db.withTx(async (tx: HostedDynamic) => {
    const { rows } = await tx.query(`SELECT COUNT(*) AS n FROM run_groups WHERE suite_id = $1`, [suite.id]);
    if (rows[0].n) {
      throw conflict(
        `suite "${suite.slug}" has ${rows[0].n} run group${rows[0].n === 1 ? "" : "s"} — ` +
          `runs are evidence and can't be deleted with the suite. Archive it instead.`,
      );
    }
    // files / snapshots / authoring sessions cascade; content-addressed blobs
    // are shared and reaped by the snapshot GC sweep.
    await tx.query(`DELETE FROM suites WHERE id = $1`, [suite.id]);
    await audit(tx, {
      actor: actorOf(p),
      action: "suite.deleted",
      entityType: "suite",
      entityId: suite.id,
      projectId: suite.project_id,
      detail: { slug: suite.slug, name: suite.name },
    });
  });
  return { deleted: true };
}

/** GET /projects/:p/suites/:slug — one suite by its user-facing key (archived included). */
/**
 * GET /projects/:p/suites/:slug[?include=cases,defaults] — one suite by slug.
 * `include` folds in what the suite page needs so its first paint is one
 * request instead of a lookup-then-fetch waterfall: `cases` carries the same
 * items as GET /suites/:s/cases, `defaults` the same row as
 * GET /suites/:s/files/playtest.yaml — or null before the first commit, which
 * is a new suite's normal state, not an error. An unknown include value is
 * refused, not ignored: a typo that silently returns less data reads as loss.
 */
export async function getSuiteBySlug(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "viewer");
  const { rows } = await ctx.db.query(
    `SELECT s.*, ${STORY_COUNT_SQL}, ${APPLICATION_JOIN_SQL}
       FROM suites s JOIN applications a ON a.id = s.application_id
      WHERE s.project_id = $1 AND s.slug = $2`,
    [project.id, ctx.params.slug],
  );
  if (!rows[0]) throw notFound(`no suite "${ctx.params.slug}" in project "${project.key}"`);
  const view: HostedDynamic = suiteView(rows[0]);
  const include = (ctx.query.get("include") || "").split(",").filter(Boolean);
  const unknown = include.find((k: HostedDynamic) => k !== "cases" && k !== "defaults");
  if (unknown !== undefined) throw badRequest(`unknown include "${unknown}" (supported: cases, defaults)`);
  if (include.includes("cases")) view.cases = await resolvedCasesFor(ctx.db, rows[0].id);
  if (include.includes("defaults")) {
    const f = await ctx.db.query(
      `SELECT path, kind, content, updated_at FROM suite_files WHERE suite_id = $1 AND path = 'playtest.yaml'`,
      [rows[0].id],
    );
    view.defaults = f.rows[0] || null;
  }
  return view;
}

/**
 * POST /projects/:p/suites {slug, name, application_id}
 *
 * The application binding is chosen at creation and is immutable: the suite's
 * driver IS the application's driver, and the launch selector is (suite, ring),
 * so this one field is what keeps a suite from ever reaching another surface's
 * deployment. An empty project has no application to bind, which is a
 * developer's job to fix — say so rather than 404ing on a null id.
 */
export async function createSuite(ctx: HostedDynamic) {
  const p = requireAuth(ctx);
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "editor");
  const body = await readJsonBody(ctx.req);
  const slug = slugField(body, "slug");
  const name = stringField(body, "name", { required: true, max: 200 });
  const application = await suiteApplication(ctx, project, body.application_id);
  const dup = await ctx.db.query(`SELECT 1 FROM suites WHERE project_id = $1 AND slug = $2`, [
    project.id,
    slug,
  ]);
  if (dup.rows.length) throw conflict(`a suite with slug "${slug}" already exists in this project`);

  const suite = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const id = ulid();
    let rows;
    try {
      ({ rows } = await tx.query(
        `INSERT INTO suites (id, project_id, application_id, slug, name) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, project.id, application.id, slug, name],
      ));
    } catch (e: HostedDynamic) {
      // Pre-check races: a concurrent create can slip past it and hit the unique
      // index — surface the same friendly conflict, never the raw constraint error.
      if (/UNIQUE constraint failed/.test(e.message)) {
        throw conflict(`a suite with slug "${slug}" already exists in this project`);
      }
      throw e;
    }
    await audit(tx, {
      actor: actorOf(p),
      action: "suite.created",
      entityType: "suite",
      entityId: id,
      projectId: project.id,
      detail: { project_id: project.id, slug, name, application: application.key },
    });
    return rows[0];
  });
  return created(suiteView({ ...suite, application_key: application.key, application_name: application.name, application_driver: application.driver, application_platform: application.platform }));
}

/**
 * The application a new suite binds to. Required — but when the project has
 * exactly one, take it: a project with a single surface should not make an
 * editor look up an opaque id to create a suite.
 */
async function suiteApplication(ctx: HostedDynamic, project: HostedDynamic, requested: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT * FROM applications WHERE project_id = $1 ORDER BY key`,
    [project.id],
  );
  if (requested) {
    const hit = rows.find((r: HostedDynamic) => r.id === requested || r.key === requested);
    if (!hit) throw notFound(`no application "${requested}" in project "${project.key}"`);
    return hit;
  }
  if (rows.length === 1) return rows[0];
  if (!rows.length) {
    throw badRequest(
      `project "${project.key}" has no application yet — a suite runs against one application target, ` +
        `so a developer has to create one (its key, its driver, and an environment URL) before the first suite`,
    );
  }
  throw badRequest(
    `"application_id" is required: this project has ${rows.length} applications ` +
      `(${rows.map((r: HostedDynamic) => `"${r.key}"`).join(", ")}), and a suite runs against exactly one`,
  );
}

// ---------- files ----------

/** GET /suites/:s/files/*path -> {path, kind, content, updated_at} */
export async function getFile(ctx: HostedDynamic) {
  const suite = await suiteForView(ctx);
  const path = safePath(ctx.params.path);
  const { rows } = await ctx.db.query(
    `SELECT path, kind, content, updated_at FROM suite_files WHERE suite_id = $1 AND path = $2`,
    [suite.id, path],
  );
  if (!rows[0]) throw notFound(`no file "${path}" in this suite`);
  // Code files (hooks/assertions) are developer-only even to read as bytes in the UI
  // — but the API returns them to any viewer; the WEB UI gates the code editor by
  // role (UX: "render code-only behind the developer role"). Content is not a secret.
  return rows[0];
}

/** PUT /suites/:s/files/*path {content, note?, base_seq?} — one-file commit. */
export async function putFile(ctx: HostedDynamic) {
  const suite = await getSuite(ctx, ctx.params.s);
  const path = safePath(ctx.params.path);
  const body = await readJsonBody(ctx.req);
  if (typeof body.content !== "string") throw badRequest(`"content" (string) is required`);
  return await applyCommit(ctx, suite, [{ path, content: body.content }], body.note, {
    action: "file.saved",
    baseSeq: body.base_seq ?? null,
  });
}

/** DELETE /suites/:s/files/*path {note?, base_seq?} */
export async function deleteFile(ctx: HostedDynamic) {
  const suite = await getSuite(ctx, ctx.params.s);
  const path = safePath(ctx.params.path);
  // Body is optional here (note/base_seq) — readJsonBody already answers {} for a
  // genuinely empty body; a present-but-malformed or oversized body must still
  // surface its own 400/413, not be swallowed into a silent {}.
  const body = await readJsonBody(ctx.req);
  const exists = await ctx.db.query(`SELECT 1 FROM suite_files WHERE suite_id = $1 AND path = $2`, [
    suite.id,
    path,
  ]);
  if (!exists.rows.length) throw notFound(`no file "${path}" in this suite`);
  return await applyCommit(ctx, suite, [{ path, content: null }], body.note, {
    action: "file.deleted",
    baseSeq: body.base_seq ?? null,
  });
}

/** POST /suites/:s/commit {changes:[{path, content|null}], note, base_seq?} */
export async function commit(ctx: HostedDynamic) {
  const suite = await getSuite(ctx, ctx.params.s);
  const body = await readJsonBody(ctx.req);
  if (!Array.isArray(body.changes) || body.changes.length === 0) {
    throw badRequest(`"changes" must be a non-empty array of {path, content|null}`);
  }
  const changes = body.changes.map((c) => {
    if (!c || typeof c.path !== "string") throw badRequest(`each change needs a "path"`);
    if (c.content != null && typeof c.content !== "string") {
      throw badRequest(`change "${c.path}" content must be a string or null`);
    }
    return { path: safePath(c.path), content: c.content ?? null };
  });
  return await applyCommit(ctx, suite, changes, body.note, {
    action: "suite.committed",
    baseSeq: body.base_seq ?? null,
  });
}

// ---------- validate / lint / cases ----------

/** POST /suites/:s/validate {changes?} — read-only core validation of the proposed tree. */
export async function validate(ctx: HostedDynamic) {
  const suite = await suiteForView(ctx);
  const body = await readJsonBody(ctx.req);
  const changes = normalizeChanges(body.changes);
  guardProposedCode(ctx, suite, changes);
  const proposed = await proposedTree(ctx, suite, changes);
  const result = await validateTree(proposed);
  return result;
}

/** POST /suites/:s/lint {changes?} -> core lint findings (advisory). */
export async function lint(ctx: HostedDynamic) {
  const suite = await suiteForView(ctx);
  const body = await readJsonBody(ctx.req);
  const changes = normalizeChanges(body.changes);
  guardProposedCode(ctx, suite, changes);
  const proposed = await proposedTree(ctx, suite, changes);
  return { findings: await lintTree(proposed) };
}

/**
 * Guard the read-only validate/lint paths against uncommitted code: core
 * discoverCases IMPORTS assertion modules (executing their top-level code)
 * server-side. Proposed `changes` that ADD/MODIFY a code file (hook/assertion) must
 * therefore require the developer role — exactly like a commit — or a viewer could
 * run arbitrary code in the control plane. Deleting code, or editing a case/persona,
 * stays at the viewer gate suiteForView already applied.
 */
function guardProposedCode(ctx: HostedDynamic, suite: HostedDynamic, changes: HostedDynamic) {
  if (changes.some((c: HostedDynamic) => c.content != null && isCodeKind(kindForPath(c.path)))) {
    guard(ctx, suite.project_id, "developer");
  }
}

/** GET /suites/:s/cases — the resolved case list (the one resolver). */
export async function cases(ctx: HostedDynamic) {
  const suite = await suiteForView(ctx);
  return { items: await resolvedCasesFor(ctx.db, suite.id) };
}

/** The resolved-and-decorated case list, shared by GET /suites/:s/cases and
    the suite-by-slug `include=cases` fold-in — one shape, stated once. */
async function resolvedCasesFor(db: HostedDynamic, suiteId: HostedDynamic) {
  const files = await loadWorkingFiles(db, suiteId);
  const items: HostedDynamic = await resolveCases(files);
  // Decorate each story with its latest finished runs — one window query for
  // the whole suite, so the suite page can show LAST and TREND without a
  // per-story history read. `recent` is newest-first, at most 5 statuses.
  // `(started_at IS NULL)` leads the sort because SQLite orders NULL FIRST under
  // DESC; without it a never-started run would masquerade as the latest one.
  const { rows } = await db.query(
    `SELECT story_id, status, started_at, id, run_group_id FROM (
       SELECT r.story_id, r.status, r.started_at, r.id, r.run_group_id,
              row_number() OVER (
                PARTITION BY r.story_id ORDER BY (r.started_at IS NULL), r.started_at DESC
              ) AS rn
         FROM runs r JOIN run_groups g ON g.id = r.run_group_id
        WHERE g.suite_id = $1 AND r.status IN ('pass','fail','infra','explored')
     ) t WHERE rn <= 5`,
    [suiteId],
  );
  const byStory = new Map();
  for (const r of rows) {
    if (!byStory.has(r.story_id)) byStory.set(r.story_id, []);
    byStory.get(r.story_id).push(r);
  }
  // next_run comes back from the resolver reading the materialized tree, which
  // carries no results/ dir — so core always says "record". Hosted, the baselines
  // table is the source of truth for whether a story acts or records; this is the
  // same rule (and the same query) dispatch/dispatcher.js plans modes with. One
  // query for the whole suite, like the run window above.
  const baselineStories = new Set(
    (
      await db.query(
        `SELECT DISTINCT story_id FROM baselines WHERE suite_id = $1 AND superseded_by IS NULL`,
        [suiteId],
      )
    ).rows.map((r: HostedDynamic) => r.story_id),
  );
  for (const item of items) {
    const recent = byStory.get(item.id) || [];
    item.last = recent[0]
      ? { status: recent[0].status, started_at: recent[0].started_at, run_id: recent[0].id, run_group_id: recent[0].run_group_id }
      : null;
    item.recent = recent.map((r: HostedDynamic) => r.status);
    // Discovery decides first (the precedence in suites/resolve.ts). `baselines.story_id`
    // holds the persona-INDEPENDENT base id, so a fanned-out `<story>@<persona>` item
    // matches on story_id — the key review.js and the dispatcher both compare on.
    if (item.next_run !== "explore") {
      item.next_run = baselineStories.has(item.story_id || item.id) ? "check" : "record";
    }
  }
  return items;
}

// ---------- snapshots ----------

/** GET /suites/:s/snapshots */
export async function listSnapshots(ctx: HostedDynamic) {
  const suite = await suiteForView(ctx);
  const { limit } = parsePagination(ctx.query);
  const { rows } = await ctx.db.query(
    `SELECT s.id, s.seq, s.note, s.created_at, s.created_by, u.email AS created_by_email
       FROM suite_snapshots s LEFT JOIN users u ON u.id = s.created_by
      WHERE s.suite_id = $1 ORDER BY s.seq DESC LIMIT $2`,
    [suite.id, limit],
  );
  return { items: rows };
}

// ---------- export / import ----------

/** GET /suites/:s/export?snapshot= -> tar of the tree (CLI round-trip). */
export async function exportSuite(ctx: HostedDynamic) {
  const suite = await suiteForView(ctx);
  const snapId = ctx.query.get("snapshot");
  let files;
  if (snapId) {
    const { rows } = await ctx.db.query(
      `SELECT tree FROM suite_snapshots WHERE id = $1 AND suite_id = $2`,
      [snapId, suite.id],
    );
    if (!rows[0]) throw notFound(`no snapshot "${snapId}" in this suite`);
    files = await loadTreeFiles(ctx.store, rows[0].tree);
  } else {
    files = await loadWorkingFiles(ctx.db, suite.id);
  }
  return tar(writeTar(files), `${suite.slug}.tar`);
}

/** POST /suites/:s/import (tar) — validate-all-or-nothing → snapshot. */
export async function importSuite(ctx: HostedDynamic) {
  const suite = await getSuite(ctx, ctx.params.s);
  const buf = await readRawBody(ctx.req);
  let imported;
  try {
    imported = readTar(buf);
  } catch (e: HostedDynamic) {
    throw badRequest(`could not read the uploaded tar: ${e.message}`);
  }
  const files: HostedDynamic = {};
  for (const [rel, data] of Object.entries(imported)) {
    const p = normalizePath(rel);
    // Skip run output and VCS noise a `tar c` of a working dir might sweep in.
    if (p.startsWith("results/") || p.startsWith(".git/") || p.startsWith(".playtest-env/")) continue;
    // macOS AppleDouble (._foo) and Finder (.DS_Store) metadata junk — a `tar c` on
    // macOS sweeps these in unasked; they are never suite files and their binary
    // resource-fork bytes are exactly what trips the NUL-byte reject below.
    const base = p.slice(p.lastIndexOf("/") + 1);
    if (base.startsWith("._") || base === ".DS_Store") continue;
    // A genuine binary/NUL-containing file isn't a suite file either (yaml/js are
    // text) — reject with a friendly 400 naming the path instead of storing bytes
    // that no text column, editor, or tar round-trip can faithfully carry.
    if (data.includes(0)) {
      throw badRequest(
        `"${p}" contains a NUL byte and isn't a suite file — rebuild the tar with ` +
          `COPYFILE_DISABLE=1 (macOS) to avoid embedding binary metadata junk`,
      );
    }
    files[p] = data.toString("utf8");
  }
  if (!Object.keys(files).length) throw badRequest(`the tar contained no suite files`);

  // Full replace: set imported paths, delete working paths absent from the tar.
  const current = await loadWorkingFiles(ctx.db, suite.id);
  const changes: HostedDynamic[] = [];
  for (const [p, content] of Object.entries(files)) changes.push({ path: p, content });
  for (const p of Object.keys(current)) if (!(p in files)) changes.push({ path: p, content: null });
  return await applyCommit(ctx, suite, changes, `import (${Object.keys(files).length} files)`, {
    action: "suite.imported",
  });
}

// ---------- core commit path ----------

/**
 * Validate the proposed tree with core, then atomically: sync suite_files rows,
 * write content-addressed blobs, insert one snapshot, audit. The invariant this
 * upholds — the working tree always fully validates — is what lets every read path
 * (cases, export) trust the files without re-checking. Exported for callers that
 * commit a subset of files (e.g. import) with their own base_seq — same lock,
 * same validation, same snapshot semantics.
 */
export async function applyCommit(ctx: HostedDynamic, suite: HostedDynamic, changes: HostedDynamic, note: HostedDynamic, { action, baseSeq = null }: HostedDynamic) {
  const p = requireAuth(ctx);
  // Role: editor in general; developer when any changed path is code (hook/assertion).
  const touchesCode = changes.some((c: HostedDynamic) => isCodeKind(kindForPath(c.path)));
  guard(ctx, suite.project_id, touchesCode ? "developer" : "editor");
  if (note != null && typeof note !== "string") throw badRequest(`"note" must be a string`);

  // Everything that reads the current tree, decides the snapshot contents, or writes
  // runs INSIDE the transaction, which `withTx` opens as BEGIN IMMEDIATE — the write
  // lock is taken at statement one, so commits serialize. Reading `current` before
  // the transaction let two concurrent commits to different paths each snapshot a
  // stale whole-tree, so the newest snapshot's `tree` no longer matched suite_files —
  // breaking the invariant /export and conflict detection rely on. Validation + blob
  // writes happen under the lock (brief, and the blobs are content-addressed).
  const committed = await ctx.db.withTx(async (tx: HostedDynamic) => {
    const current = await loadWorkingFiles(tx, suite.id);

    // Optimistic concurrency: if the client committed against base_seq, reject when a
    // changed path has been altered since (last-writer-wins is opt-out, not the
    // default — UX: "never a silent overwrite").
    if (baseSeq != null) {
      const conflicts = await detectConflicts(tx, suite.id, baseSeq, changes, current);
      if (conflicts.length) {
        throw conflict("someone else changed these files since you started editing", conflicts);
      }
    }

    const proposed: HostedDynamic = { ...current };
    for (const c of changes) {
      if (c.content == null) delete proposed[c.path];
      else proposed[c.path] = c.content;
    }

    const result = await validateTree(proposed);
    if (!result.ok) throw validationFailed(result.errors);

    // Content-addressed + idempotent; an orphan blob on a later rollback is harmless.
    const tree = await putBlobs(ctx.store, proposed);

    for (const c of changes) {
      if (c.content == null) {
        await tx.query(`DELETE FROM suite_files WHERE suite_id = $1 AND path = $2`, [suite.id, c.path]);
      } else {
        await tx.query(
          `INSERT INTO suite_files (id, suite_id, path, kind, content, updated_by)
             VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (suite_id, path)
             DO UPDATE SET content = EXCLUDED.content, kind = EXCLUDED.kind,
                           updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [ulid(), suite.id, c.path, kindForPath(c.path), c.content, userIdOf(p)],
        );
      }
    }
    const seqRow = await tx.query(
      `SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM suite_snapshots WHERE suite_id = $1`,
      [suite.id],
    );
    const seq = seqRow.rows[0].seq;
    const id = ulid();
    try {
      await tx.query(
        `INSERT INTO suite_snapshots (id, suite_id, seq, tree, created_by, note)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, suite.id, seq, tree, userIdOf(p), note ?? null],
      );
    } catch (e: HostedDynamic) {
      // `UNIQUE (suite_id, seq)` is the real one-winner guarantee behind the
      // MAX(seq)+1 allocation above. BEGIN IMMEDIATE should already have
      // serialized the two commits, so this only fires if that ever regresses —
      // the loser must still see the friendly conflict, never a raw constraint error.
      if (/UNIQUE constraint failed/.test(e.message)) {
        throw conflict("someone else committed to this suite at the same time — reload and try again");
      }
      throw e;
    }
    await tx.query(`UPDATE suites SET updated_at = now() WHERE id = $1`, [suite.id]);
    await audit(tx, {
      actor: actorOf(p),
      action,
      entityType: "suite",
      entityId: suite.id,
      projectId: suite.project_id,
      detail: { snapshot_id: id, seq, changes: changes.map((c: HostedDynamic) => ({ path: c.path, deleted: c.content == null })), note: note ?? null },
    });
    return { snapshot: { id, seq, note: note ?? null }, cases: result.cases };
  });

  return committed;
}

/** Working paths whose content diverged from base_seq's snapshot (a real conflict). */
async function detectConflicts(q: HostedDynamic, suiteId: HostedDynamic, baseSeq: HostedDynamic, changes: HostedDynamic, current: HostedDynamic) {
  const { rows } = await q.query(
    `SELECT tree FROM suite_snapshots WHERE suite_id = $1 AND seq = $2`,
    [suiteId, baseSeq],
  );
  const baseTree = rows[0]?.tree ?? {};
  const curTree = contentTree(current);
  const out: HostedDynamic[] = [];
  for (const c of changes) {
    if ((baseTree[c.path] ?? null) !== (curTree[c.path] ?? null)) {
      out.push({ path: c.path, current_content: current[c.path] ?? null });
    }
  }
  return out;
}

// ---------- helpers ----------

// `q` is any object with a `.query(text, params)` — the pool (ctx.db) for read paths
// or a tx handle inside a locked commit.
async function loadWorkingFiles(q: HostedDynamic, suiteId: HostedDynamic) {
  const { rows } = await q.query(`SELECT path, content FROM suite_files WHERE suite_id = $1`, [
    suiteId,
  ]);
  return Object.fromEntries(rows.map((r: HostedDynamic) => [r.path, r.content]));
}

async function proposedTree(ctx: HostedDynamic, suite: HostedDynamic, changes: HostedDynamic) {
  const current = await loadWorkingFiles(ctx.db, suite.id);
  const proposed: HostedDynamic = { ...current };
  for (const c of changes) {
    if (c.content == null) delete proposed[c.path];
    else proposed[c.path] = c.content;
  }
  return proposed;
}

function normalizeChanges(changes: HostedDynamic) {
  if (!changes) return [];
  if (!Array.isArray(changes)) throw badRequest(`"changes" must be an array`);
  return changes.map((c) => ({ path: safePath(c.path), content: c.content ?? null }));
}

/** Load the suite and check the caller can view its project. */
async function suiteForView(ctx: HostedDynamic) {
  const suite = await getSuite(ctx, ctx.params.s);
  guard(ctx, suite.project_id, "viewer");
  return suite;
}

function safePath(raw: HostedDynamic) {
  try {
    return normalizePath(raw);
  } catch (e: HostedDynamic) {
    throw badRequest(e.message);
  }
}

const userIdOf = (p: HostedDynamic) => (p.kind === "user" ? p.userId : null);
const suiteView = (r: HostedDynamic) => ({
  id: r.id,
  project_id: r.project_id,
  // The one application this suite runs against, fixed at creation. `application`
  // is folded in wherever the read joins it, so a picker never has to look the
  // key up separately.
  application_id: r.application_id,
  ...(r.application_key !== undefined
    ? {
        application: {
          id: r.application_id,
          key: r.application_key,
          name: r.application_name ?? null,
          driver: r.application_driver ?? null,
          platform: r.application_platform ?? null,
        },
      }
    : {}),
  slug: r.slug,
  name: r.name,
  archived: r.archived,
  updated_at: r.updated_at,
  // present on list/by-slug reads (rows selected with STORY_COUNT_SQL)
  ...(r.story_count !== undefined ? { story_count: r.story_count } : {}),
});

export { forbidden };
