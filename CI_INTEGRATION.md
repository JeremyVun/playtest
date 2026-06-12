# CI Integration

GitHub-Actions/CI-facing work, extracted 2026-06-12 from the improvement
planning doc (IMPROVEMENTS_FOLLOWUP.md, since dismantled and deleted). The
section numbers §6 and §12 are kept as historical identifiers from that
doc.

Order: both items come after `VERSION_1.1.md` ships. The PR bot is the
first post-talk adoption vehicle ("the first team that says 'we want this
on our PRs' is the pilot") and was held swappable-by-appetite with the
agent skill (V1.1 item 3 — solo loop vs team visibility). The history
backend is last as a build, not as a decision: its v0 (workflow-artifact
upload) lands free with the PR bot, the schema's comparability key is
decided by V1.1 item 6, and the API/DB is built only when cross-run trends
in CI or team dashboards are concretely demanded.

## 6. PR Journey-Diff Bot

The problem it solves: attaching screenshots and screen recordings to PRs by
hand to prove "the journey still works." A trusted regression badge backed by
a visual playthrough replaces all of that.

Shape: a GitHub Action (`playtest-action`) that:

1. Runs the smoke tag against the PR's preview deployment
   (`--base-url $PREVIEW_URL --ci --json`).
2. Uploads the run directory as a workflow artifact (the viewer already
   works from an artifact download).
3. Posts/updates one sticky PR comment:

```md
### Playtest — user journeys on this PR

| Journey | Result | Steps | Duration |
|---|---|---|---|
| todos/add-todo | ✅ pass (checked) | 4 | 3.2s (−0.2s) |
| checkout/guest | 🔶 changed — healed at step 6 | 9 (+2) | 8.7s (+1.4s) |

**checkout/guest changed:** the journey survived a UI change.
[screenshot at divergence: before → after] · [download run artifact]
Review locally: `playtest view --changed` · accept: `playtest accept <runDir>`
```

Implementation notes:

- Everything load-bearing exists: `--json`, exit codes, heal detection,
  `--fail-on-changed` as the gating knob, per-step screenshots for the
  before/after pair at the divergence step.
- Divergence screenshots: baseline step N screenshot vs healed run step N —
  both already on disk; the bot just picks the first diverging step from the
  action-track diff.
- Comment is regenerated, not appended (sticky comment keyed by a marker).
- Once journey clips exist (`VERSION_1.1.md` item 2), the comment embeds
  the subtitled clip for changed and failed journeys — the self-contained
  burned-in `--burn` variant.
- v1 needs only: a composite action wrapping the CLI + a small comment
  script. No backend. The durable-history backend (§12 below) later
  upgrades the table with cross-run trends.
- Scope guard (from the execution order): v1 deltas compare against the
  baseline only (step count, baseline duration) — no run history exists in
  ephemeral CI until §12.

## 12. Durable Run History Backend

`runs/` is local and gitignored, so all trend features are currently
per-machine. Target: CI (GitHub Actions) uploads runs to a persistent
store; dashboards and the viewer read from it.

Architecture — split the run into two planes; never serve reads from zips:

- **Control plane (hot, tiny):** `manifest.json` + `grade.json` + gate
  results — a few KB per run, and everything trends/history/dashboards
  query. The `--json` run summary is already the exact ingestion payload.
  A CI step POSTs it to a small API backed by Postgres. All list/trend
  reads are indexed DB queries; no cache warming, because hot data never
  lives inside an archive.
- **Data plane (cold, heavy):** webm, MHTML, screenshots, HAR — needed only
  when a human opens one specific run. Store as individual objects under a
  run-id prefix in object storage (not one zip); the DB row holds the
  prefix. The viewer (already a static app) reads history from the API and
  lazy-loads artifacts via signed URLs per run.

If org policy mandates a single archive in Artifactory, two escape hatches:

1. **Sidecar uploads** (preferred): push the zip for archival AND the three
   small files as separate artifacts; ingestion reads only the sidecars.
2. **Range-read the zip:** zip's central directory is at the file's end and
   Artifactory/S3 honor HTTP range requests, so a client can fetch the
   directory then range-get individual entries without downloading the
   archive. Works, but more machinery than (1).

Design rules:

- CQRS / cache-aside is deferred: write volume is one POST per case per
  run; plain Postgres + object store carries this far. Add read models when
  a real query gets slow.
- The schema's load-bearing column is the **comparability key**: store the
  full pin set (harness/model/prompt/schema/settle versions, headed flag)
  on every row. The harness's rule — never compare trends across baseline
  boundaries — must be enforced in queries too, or trend lines silently lie
  after every harness upgrade.
- Retention tiers: summaries kept indefinitely (trends want a long horizon,
  rows are tiny); artifacts on a 30–90 day TTL.
- v0 needs no backend at all: workflow-artifact upload (data plane) + a
  POST step can come later; the PR bot (§6) works from artifacts alone.
- This backend is also the read side of the hosted run service deferred in
  NICE_TO_HAVE.md — design the schema with that in mind.

### Staged rollout (2026-06-13)

Why a db at all: every history feature (case trends, the viewer's deltas,
team dashboards) is today an O(all runs) directory scan, and per-machine
only. The db turns those into indexed millisecond queries and makes the
same history visible to every runner — local CLI, web interface, GitHub
Action — at once. That is the entire job of the control plane; artifacts
have a different job and a different home (see "where artifacts live").

**Stage 0 — today.** Everything is a directory scan:

```
playtest run ──writes──▶ runs/<case>/<run-id>/
                           manifest.json  grade.json     ◀─ control plane (KBs)
                           video.webm  steps/*.png  …    ◀─ data plane (MBs)
                              ▲
view-server ──scans runs/ ────┘   (/runs.json /changed.json /history.json /run/<path>)
```

**Stage 1 — local SQLite index.** One summary row per case-run (the
`--json` payload flattened, plus the comparability-key columns decided by
VERSION_1.1 item 6). The important addition is not the engine but the
seam:

```
                   trend/movement logic (item 6's pure module)
                                 ▲
                 HistoryProvider: rows(caseId, pinKey) → [summaries]
                       ┌─────────┴─────────┐
                 scan runs/           history.db (SQLite)
                 (fallback,           derived index — rebuildable
                  always works)       from runs/ at any time

playtest run ──▶ runs/<run-id>/…   (unchanged: the only authoritative write)
view-server  ──▶ history via provider; artifacts still served from runs/
```

**Stage 2 — shared backend.** Same row, same key, different provider.
Every runner shape converges on one store:

```
 local CLI ────┐
 GitHub Action ┼── artifacts ──▶ object store (data plane)
 web runner ───┘                  s3://playtest-runs/<run-id>/video.webm, steps/…
                                       │ bucket event (S3 → SQS)
                                       ▼
                                  ingest worker ──▶ Postgres (control plane)
                                                     rows: summary + pin set
                                                     + artifact prefix

 hosted viewer ── history, lists, trends ──▶ API (indexed queries)
       └──────── signed URLs, HTTP range ──▶ object store (video seek, images)
```

The provider switch is configuration, not code:
`PLAYTEST_HISTORY=sqlite:./runs/history.db` →
`PLAYTEST_HISTORY=https://playtest.corp/api` (an API, not a raw db
connection string — auth, multi-tenancy, and schema ownership stay
server-side instead of handing every laptop db credentials).

### Ingestion consistency: no dual writes

Design rule: **exactly one authoritative write per run; every db row is
derived from it, idempotently, and reconcilable after any failure.** The
run never commits to two stores.

- **Local (stage 1):** `playtest run` writes only `runs/` — manifest.json
  written last is the commit marker (a run dir without it is incomplete
  and ignored). The SQLite row is write-behind and best-effort; every
  reader does read-repair: scan for committed run dirs the index lacks
  (high-water mark by run id/mtime), upsert the missing rows. A crash
  between file write and row insert costs nothing — the next read heals
  it. `playtest index --rebuild` regenerates the whole db from `runs/`.
- **Remote (stage 2):** the object-store upload is the commit — artifacts
  first, manifest last, same marker rule. The Postgres row is derived from
  the bucket, preferably by event notification (S3 → SQS → ingest worker
  reads the manifest object and upserts), with a periodic reconciler
  sweeping bucket listings against the table for missed events. Where no
  event infra exists, the CI step POSTs the summary with retries and the
  reconciler is the safety net.
- **Order matters:** never write the row before the artifacts land. A row
  pointing at missing artifacts is a lie the viewer trips over; missing
  row + present artifacts is invisible and self-healing. Upserts are
  idempotent on run id, so the event, the POST, and the sweep can all fire
  for the same run without harm.

### Where artifacts live (and why not in the db)

A summary row is a few KB; a run's artifacts are tens of MB (webm,
per-step screenshots, MHTML, HAR). Databases *can* store blobs, but here
it buys nothing and costs three ways: trend queries share cache/WAL/backup
space with blobs they never read; video seeking needs HTTP range requests,
which object stores serve natively and a db row cannot; and the
index-is-disposable property (rebuildable, corruption is a non-event) dies
the moment the db holds the only copy of anything. Locally the artifacts
already exist as files; remotely they go to object storage under a run-id
prefix — which preserves the `runs/`-directory shape the viewer already
treats as its interface (`/run/<path>` ↔ signed URL per object).

Constraints that keep all stages migration-safe:

- Keep the SQL portable (or behind a thin data layer): same schema DDL for
  SQLite and Postgres, comparability-key columns from day one.
- The HistoryProvider seam is shared work with VERSION_1.1 item 6 (the
  comparability module defines the row semantics; this doc's stages just
  change where rows come from). Build the seam there; build providers
  here.
