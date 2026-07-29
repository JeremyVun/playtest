# Hosted findings and authoring contracts

This file owns durable findings, finding automation, rule-card governance, and
hosted model-assisted authoring. [Hosted platform contracts](hosted.md) own
authorization, storage, runs, and events. [Script contracts](scripts.md) own the
API-suite handout and rule vocabulary.

The database schema, route inventory, and configuration module remain
authoritative inventories. This file records lifecycle, identity, grounding,
and human-decision boundaries.

## Findings lifecycle

The finding is the only durable cross-run defect entity. There is no separate
bug candidate, insight, report, or suppression object. Actor raises remain
run-scoped observations; graded defect claims may enter findings intake.

Internal states are:

- `new`: machine-filed and awaiting judgment;
- `accepted`: human-confirmed and open;
- `reopened`: a confirmed finding recurred;
- `resolved`: closed; and
- `rejected`: dismissed.

The user-facing buckets are **Needs review** (`new`), **Open** (`accepted` and
`reopened`), **Resolved**, and **Rejected**. Confirmation means the finding is
real, not fixed.

Failed product runs may create findings; infrastructure failures do not.
Rejected findings absorb exact recurrences without returning to review. A
resolved finding that recurs returns to `reopened` if a person previously
confirmed it, otherwise `new`. Leaving `resolved` clears current resolution
provenance; audit retains history.

Machine activity cannot enter a confirmed state, raise a confirmed-attention
count, or hand off to an external tracker. Machines may group unreviewed claims
and retire findings when new evidence disproves them. Recurrence preserves the
human boundary by returning unconfirmed claims to quiet review.

Finding projections report exact counts separately from capped list pages.
Alarm counts include only `accepted` and `reopened`; `new` and fix suggestions
remain review work with distinct, non-alarm presentation. Evidence links name a
specific run and viewer step when known.

Reviewer transitions are accept, reject with reason (`not_a_bug`, `wont_fix`,
`duplicate`), resolve, reopen, merge, split evidence, acknowledge an automatic
resolution, and dismiss a fix suggestion. Every intake and transition is
authorized and audited in its state-change transaction.

Reviewer filing from a run lands confirmed because filing is the human decision.
**Confirm and copy** combines confirmation and tracker-summary copy; confirmed
findings offer **Copy for tracker**. An external reference may be stored, but
Playtest never creates or updates an external ticket.

### Client projections and receipts

Finding lists may be capped, so counts come from an exact aggregate projection
over live, unmerged findings. It returns one total per internal state plus
`fix_suggested`, the number of `accepted` or `reopened` findings with a pending
Looks-fixed suggestion. A `new` finding with such a suggestion is already
counted as review work by state. Lists accept `fix_suggested=1`.

Project health carries:

- `major_findings`: the five newest confirmed major findings;
- `findings_needs_review`: the exact `new` count; and
- `findings_fix_suggested`: the exact pending-suggestion count.

Per-suite health derives open, review, and `fix_suggested` from the same rules,
so linked tables and finding tabs agree. Machine claims and suggestions remain
visually distinct from confirmed alarms.

Automatic-resolution provenance is additive:

- run projections carry `resolved_findings`, and finding lists accept
  `resolved_by_run`;
- findings store `resolved_by_run_id` and `auto_resolved_at`;
- `summary.auto_resolve.reason` explains a completed automatic resolution; and
- `summary.auto_resolve.suggested` and its `.reason` describe a pending
  suggestion.

Automatic resolution emits the ordinary `finding.resolved` event and audit
action `finding.auto_resolved`. Suggestions emit `finding.fix_suggested`.
Reviewer Acknowledge records `finding.acknowledged`; Not fixed clears the
suggestion, records `finding.fix_dismissed`, and remembers the checked run.
These receipts describe current resolution only and clear when the finding
leaves `resolved`.

## Findings intake

A machine-filed finding is a typed, cited claim with:

- project, first run, case, and story provenance;
- a category from `http_error`, `console_exception`,
  `expectation_violation`, `data_mismatch`, `no_effect`, `perf_regression`, or
  `broken_navigation`;
- title, expected/observed behavior, severity, and signals;
- normalized match text, deterministic lookup keys, and algorithm versions; and
- initial state `new`.

Discovery synthesis, grade ingest, and reviewer filing use one server-side
intake path. Evidence rows are append-only and idempotent on finding, run, and
step. Durable caller idempotency keys prevent retries from filing twice while
still permitting new evidence.

Exact identity derives only from trusted recorded context:

```text
strict = sha256(project_id ‖ story_id ‖ signal_type ‖ normalized_locus)
loose  = sha256(project_id ‖ signal_type ‖ normalized_locus)
```

Model prose and model-selected category do not enter either key.
`normalized_locus` derives from route, step/selector, and status context with
run-specific values removed. Claims without deterministic signals carry no
exact keys. Key and normalization versions are stored. Because inputs are
recorded, a version change recomputes stored keys after migration.

Intake resolves live merge heads in this order:

1. An intake-key hit appends new evidence only.
2. A strict-key hit appends evidence. Rejected matches stay rejected; resolved
   matches recur according to prior confirmation.
3. A loose-key hit creates a `new` finding with a merge suggestion toward the
   best reviewed live match. It never auto-merges.
4. A miss creates a `new` finding.

Creation emits `finding.created`; recurrence from `resolved` audits
`finding.recurred`. Intake, evidence append, lifecycle transition, and merge
commit their audit/event receipts with the state change.

A finding and merge target must belong to one project. Merge carries all
evidence to the live survivor and leaves a traversable tombstone.

### Run-grade and study intake

Run report ingest reads the sealed `grade.json`: typed `bug_candidates` and
minor/major free-form findings enter the same intake path; informational
observations remain run-scoped. Identity comes from recorded anomaly signals,
not grader prose, and intake keys are stable across runner retries.

Discovery synthesis is editor-authorized and contextual to a finished discovery
group. It mines graded runs and personas, but every claim must cite a real
provided run/step. The server derives deterministic identity from those cited
records. Ungrounded claims are dropped. Results report created, suggested,
appended, and absorbed counts; `absorbed` means recurrence into a rejected
finding.

## Semantic consolidation

Consolidation groups differently worded `new` findings through
retrieve-then-verify. Manual review and automatic dedupe use the same pipeline:

1. **Deterministic retrieval.** Versioned rare-word-weighted overlap shortlists
   live neighbors across all states. Category contributes to score but never
   gates comparison. The current retrieval version is `shortlist-v1`.
2. **Score routing.** A single high-scoring reviewed neighbor becomes a merge
   suggestion; no neighbor above the floor stands alone. Neither path calls a
   model.
3. **Cluster verification.** Ambiguous connected components use one forced-tool
   model call per bounded cluster. Prompts include claims and evidence
   references, never screenshots, trajectories, HAR bodies, cookies, or auth
   headers. Oversized components are split and recorded rather than truncated.

Thresholds and caps are validated server configuration. Lexical overlap alone
never merges: only deterministic exact identity or model-verified consolidation
may do so. Reviewer labels record the score, confidence, edit, confirmation,
and rejection outcomes for later calibration.

A consolidation plan is a proposal, not a finding mutation. The server validates
that every id was supplied to its cluster, projects do not cross, each new
finding occurs once, and new groups have titles. Confidence is `high` or
`medium`; unsupported groups remain unresolved. Invalid plans are not persisted.

Applying a plan is one transaction through ordinary merge machinery. Existing
targets survive; targetless groups merge into their oldest member, optionally
retitled, and remain `new`. Reviewers may accept, edit, or skip each proposal.
The full plan and outcome are audited.

Plans record digests of covered findings. A plan conflicts if any member was
reviewed, merged, re-keyed, applied, or discarded after proposal. Algorithm,
model, shortlist, threshold, and gateway-usage metadata remain provenance.

The reviewer preview performs no write or model call. It reports unreviewed
finding counts, cluster count, prompt bytes, estimated input tokens, and active
thresholds. Running consolidation returns a proposed plan. Plan lists/details
are viewer-readable and include every member claim and evidence link; apply and
discard require reviewer. Consolidation remains contextual to Needs review, not
a navigation destination.

### Automatic dedupe

After report or synthesis intake may create `new` findings, a debounced
per-project sweep runs best-effort under a lease:

- model-verified high-confidence groups are merged with system attribution;
- medium-confidence existing-target matches and deterministic score routes
  become suggestions;
- all others remain separate and unresolved.

The sweep never confirms or rejects a claim. Automatic grouping is reversible,
so the human-decision guarantee holds.

The deployment supplies an automatic-dedupe default; a project admin may pin it
on or off. Enabling it schedules catch-up. When enabled, the console shows
history instead of a manual action. When disabled, the reviewer-triggered plan
flow remains available. Sweep failure degrades to manual review and never fails
run reporting. Applied sweeps emit `consolidation.auto_applied`.

The consolidation model resolves from project policy, then deployment policy,
then the default low-cost tier. The plan records the model actually used.

## Automatic resolution

After every pass or fail report, a debounced per-project sweep evaluates whether
new evidence disproves open findings. It runs best-effort under a lease distinct
from consolidation.

Resolution is per `(suite, ring, case)`. A finding's affected triples derive
from its evidence. Each triple receives a resolution stamp only from a newer run
that disproves the finding. The finding resolves when every affected triple has
a stamp newer than its latest evidence. Stamps remain as history; new evidence
makes old stamps stale.

Resolution tiers depend on grounding:

- **Gate findings** stamp when the same gate check passes in a newer run.
- **Signal-keyed findings** stamp when recomputed signals no longer strict-match
  and the run passed or reached the recorded locus. An incomplete run that
  never reached the surface proves nothing.
- **Keyless findings** use a forced-tool verification against the newer run’s
  recorded page evidence. It answers fixed, not fixed, or indeterminate.
  Fixed stamps use method `verified_absent`. Without a model gateway, a graded
  outright pass may create a suggestion with method `case_pass`, but an
  ungraded check proves nothing about a judgment claim.

Not-fixed and indeterminate checks write memoized check results, not evidence
rows. A passing run cited as defect evidence would corrupt recurrence and
`last_seen`.

Every stamp requires a strictly newer run, and a run cannot resolve a finding
it evidenced. Apply rechecks live state, merge status, and `last_seen` without
following a concurrent merge tombstone. Lost races are retried by a future
sweep.

Automatic resolution reuses `resolved` and records the resolving run, time,
method, human-readable reason, system audit actor, and ordinary resolved event.
Manual resolution clears automatic provenance. Recurrence and reopen clear it.

Two modes govern keyless verified fixes:

- `semi` creates a **Looks fixed** suggestion requiring reviewer Resolve or
  Not fixed;
- `full` resolves only when every affected triple has verified absence.

Findings with live external references always receive suggestions. A reviewer
dismissing one records the run so it does not reappear until newer evidence.
Deterministic tiers may resolve directly because their proof is reproducible.

Auto-resolved findings remain visible and reversible. Finding detail names the
resolving run and reason; the run names how many findings it resolved. Resolved
evidence remains retention-pinned for a grace period. `new` findings are
eligible, but recurrence returns them to `new`, never `reopened`.

Deployment defaults control enablement, mode, model, debounce, and retention
grace. Project admins may pin enablement and mode and may select the verification
model. Enabling or widening policy schedules catch-up.

## Rule cards

Rule cards are hosted Level 1 invariants from
[Script contracts](scripts.md#invariant-levels). Level 0 policies are code,
always enabled, and shown read-only. The product presents assisted authoring:
review and confirm the API's rules. It never says the platform discovered
authoritative rules.

Each suite-scoped card stores:

- immutable `rule_id`, which keys handouts and reports;
- `candidate`, `approved`, or `denied` state;
- `proposed` or `authored` origin;
- statement, title, applicability, exceptions, provenance, and owner note;
- the original proposed statement after human edits; and
- human decision provenance for decided cards.

Only approved statements enter authoring handouts. The control-plane query and
core handout conversion each independently filter to `approved`.

Governance rules:

- Model proposals always create `candidate` cards.
- Denial persists as memory and suppresses re-proposal by id; proposed cards are
  denied, not deleted.
- Editing a candidate does not approve it.
- A reviewer-authored card lands approved because writing it is the approval.
- Only authored cards may be deleted.

Reads require `viewer`; proposal requires `editor`; create, edit, decide, and
delete require `reviewer`. Every mutation writes its audit row and
`rule_card.*` event transactionally.

Action semantics are:

| Action | Role | Guarantee |
|---|---|---|
| List cards | viewer | Includes Level 0 rules, all cards, counts, and proposal availability. |
| Read handout | viewer | Returns only approved cards in the core handout shape. |
| Propose from OpenAPI | editor | Model output creates candidates only. |
| Add authored card | reviewer | A human-written card lands approved. |
| Edit | reviewer | May change statement, applicability, exceptions, and note without implicitly approving a candidate. |
| Approve or deny | reviewer | Records the decision and optional note. |
| Delete | reviewer | Allowed only for authored cards; proposed cards are denied. |

Proposal accepts an uploaded or pasted OpenAPI document. The control plane does
not fetch URLs or auto-discover a spec. Without the platform LLM gateway,
proposal returns `503 not_configured`; manual authoring remains available.

## Story drafting

Story drafting is inline and stateless. An editor submits a plain-language goal,
a short browser-held clarification transcript, and optionally the existing
story. The server adds current suite defaults, compact story summaries,
personas, and non-secret application/ring context.

The response is either `needs_input` with a clarifying reply or
`{ draft, drafts }`. Each draft is `{ path, yaml, validation, lint }`; `drafts`
is the capped proposal set and `draft` is its final entry for single-draft
clients. Improving an existing story always returns one draft pinned to its
path. A multi-story set is reviewed together and saved through one ordinary
suite commit.

JSON remains the default response. A client may request `text/event-stream` to
receive `working` and truthful model-gateway `retry` progress, followed by one
terminal `result` or `error` event carrying the same envelope. Retry progress
names the attempt and retry budget; it is not model-token streaming.

Drafting has no durable side effect: no authoring row, event, snapshot, audit
entry, server transcript, or assistant-specific commit exists. Model output
only fills an unsaved form. Human Save performs normal whole-suite validation
and optimistic concurrency.

Rule-card proposal is the only assisted-authoring call that writes, and it may
write candidates only. Its prompt schema and normalization are owned by core's
API-suite-script facade.

Drafting and discovery synthesis call the deployment LLM gateway and expose
`not_configured` when absent. They have separate model settings and must not
silently re-tier each other. Neither receives secrets, session artifacts, or
raw authentication values.

## External handoff

Stable authenticated APIs expose finding reads and ordinary audited transitions.
Playtest runs no project-authored exporter, webhook, or ticket integration.
External references are written explicitly after human confirmation; **Copy for
tracker** is the default handoff.

## Contract changes

Update this file for changes to finding identity, lifecycle, evidence,
consolidation, auto-resolution, rule-card governance, model grounding, or
assisted-authoring persistence. Platform roles and event delivery remain in
[Hosted platform contracts](hosted.md).
