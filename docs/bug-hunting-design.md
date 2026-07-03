# Bug-hunting subsystem — design + contract

Status: **PROPOSED** (2026-06-27). Nothing here is implemented yet. This is the architectural
spec for turning Playtest from a *regression* tool into one that also *hunts* bugs during
exploration, triages them through a verify → dedupe → review funnel, and (eventually) hands
confirmed defects to a builder. When built, the frozen parts — `bug.schema.json`, the ledger
DDL + versioning policy, the new `app.*` keys, the `pins`/`prompts_version` decisions, the new
run artifacts — migrate into `docs/CONTRACTS.md` as a new section; this document is retained as
the design rationale, exactly as `driver-interface.md` relates to CONTRACTS §16. **Silent
contract drift is the one unforgivable sin** (CONTRACTS.md preamble) — that rule governs this
subsystem from day one because its whole value is a years-long accreting record.

Repo invariants carried over (non-negotiable): plain JS ESM, Node >= 20, no TypeScript, no
build step. `npm test` is the offline gate (`node --test test/*.test.js`), 0 skipped. User
errors go through `DummyConfigError`. **The web journey path is the control and must never
regress** — same prompts, same envelopes, same manifests, golden-bytes pinned. No speculative
abstraction.

---

## 1. The idea, and the one big constraint

Discovery mode already runs an actor through an open-ended task and a grader mines the
trajectory for *discoverability* findings ("where did the user look, what couldn't they
find"). That is a **UX** lens. It is not tuned to answer "**did the app malfunction?**" — and
when it trips a real defect, that defect is buried as one `findings[]` note in one run's
`grade.json`, with no identity, no dedupe, no lifecycle, and no path to a fix.

This subsystem adds the missing lens and the missing funnel. Two ideas carry the whole design:

> **A bug is not a new data type — it is a *projection* over the trajectory you already
> record.** A regression baseline is "the whole happy path, replayable." A bug evidence pack is
> "the failing slice, demonstrable." Same substrate, different view. The bug-finder is a
> *selection-plus-summarization* function over existing artifacts — which is why it is a pure
> reader, safe to bolt on, and never touches the journey control path.

> **The defense against throwing away years of history is not a perfect upfront schema — it is
> an *evolvable* one.** The fingerprint/dedupe logic is the hardest thing here and *will*
> change. The substrate's invariants (§8.2) are what let it change without orphaning a single
> historical issue.

### Non-goals (deliberately omitted, or deferred)

- **Not** a static analyzer or a source-code scanner. Detection is **black-box**, off the
  running surface only. The app's source may be a different repo, or not on disk at all.
- **Not** an auto-filer or auto-fixer. A human gate sits before anything leaves the local
  store and before any code is written — mirroring the existing `heal → candidate →
  accept/reject` model.
- **JIRA is not the store.** It is an optional, idempotent *mirror* behind a seam (§9). The
  source of truth is local and offline, so `npm test` stays offline and dedupe stays testable.
- **Source localization** (§6.5) and the **builder** (§6.6) are deferred past the PoC. Prove
  detection *precision* first; a pile of low-quality auto-filed bugs is strictly worse than
  none.

---

## 2. Three lanes

The work splits into three concerns that must not be conflated. Lane 2 exists today; lanes 1
and 3 are new.

| Lane | Question | Owner | Status |
|---|---|---|---|
| **1. Acting** | *surface* the bug | actor + an adversarial overlay/persona | NEW (§3) |
| **2. Grading** | "could the user find/do it" (UX) | `grader.js` | EXISTS — unchanged |
| **3. Triage** | "did the app misbehave", then verify → dedupe → review → fix | `bugfinder.js` + ledger + sinks | NEW (§5–§9) |

Clean division of labor: **the grader owns UX; the bug-finder owns correctness.** They are
independent parallel readers of the same immutable trajectory (§7), so there is no ordering
between them and no risk to the grader.

**Definition (the line the bug-finder draws).** A *bug* is a divergence between the actor's
stated `expectation` and the observed system behavior that is attributable to the application —
**not** user confusion, **not** a missing affordance (that's the grader's `findings`), **not**
environment flakiness. The actor already writes a falsifiable `expectation` every step and the
harness already records whether it held; expectation-violation is the richest single signal and
it is already in the trajectory.

---

## 3. Lane 1 — the adversarial actor

A cooperative discovery actor ("look for the affordance, give up gracefully") mostly does *not*
trip bugs. To *find* bugs you tune the actor to be adversarial. The hook already exists:
`actor.js` builds the system prompt from stacked overlays (system + persona + discovery +
vision + story). Bug-hunting contributes **one more overlay and one built-in persona**, exactly
as discovery and vision do:

- **`prompts/actor-bughunt.md`** — an overlay (slotted like discovery/vision, *after* Persona,
  so the web journey prompt's bytes are untouched, §10) that licenses adversarial moves a
  cooperative user wouldn't: double-submit, back-button after a POST, refresh mid-flow,
  malformed/boundary input, rapid re-click, navigate away and return. It keeps the
  falsifiable-expectation discipline so every probe is checkable.
- **`personas/saboteur.yaml`** (built-in, alongside `tester`/`exploratory`) — the persona that
  pairs with the overlay.

Selection is by the existing persona machinery + one mode flag (§11). A bug-hunt run is a
discovery/explore run (no gate, no baseline) whose actor wears the saboteur hat.

---

## 4. The evidence pack — what a bug *is*

A bug claim is a **stitched-together evidence pack: a deterministic subset of the run's own
artifacts**, plus the model's narrative and the dedupe metadata. It is the always-available,
portable form of a bug — the thing that goes to the store, the human, and (later) the sink.

### 4.1 Contents (all of it already recorded by the harness)

- the step slice `steps[i..j]` leading to the anomaly — each step's `thought`, `expectation`,
  `action`, `result` (verbatim from the step envelope, carrying its `schema_version`);
- the triggering request + response from `har.json` (**scrubbed** of auth headers/cookies — the
  contract warns `har.json` carries them, §14);
- console errors / `js_errors` in the window;
- before/after screenshots (`steps/NNN.png`) — *copied*, not referenced;
- the deterministic anomaly signals that flagged it (§5.1);
- the model's narrative + the **canonical dedupe sentence** (§5.3).

### 4.2 On-disk layout, and the durability rule

`runs/` is gitignored and grows unbounded; it *will* be pruned. So the evidence pack must be
**snapshot-copied off the run dir at promotion** — detached from the ephemeral run, exactly as
`acceptBaseline` copies a trajectory into `results/` rather than referencing the run. The store
row points at the snapshot, never the live run.

```
<suite>/issues/<issue-id>/
  pack.json            # the evidence pack: step slice, anomaly signals, har slice (scrubbed),
                       # narrative, canonical sentence, source run-id + step range (provenance)
  steps/NNN.png        # copied screenshots referenced by the pack (only those it cites)
```

The pack is **verbatim bedrock** (§8.2-2): every derived value (fingerprint, severity,
embedding) is recomputable *from it*, so an algorithm upgrade never forces discarding it.

### 4.3 `bug.schema.json` (the claim contract — Ajv-validated forced tool call)

The bug-finder emits claims through a forced tool call validated against this schema, the same
mechanism as the grader's `grade` tool.

```js
{
  kind: "http_error" | "console_exception" | "expectation_violation"
      | "data_mismatch" | "no_effect" | "perf_regression" | "broken_navigation",
  severity: "minor" | "major" | "critical",
  title: "...",                       // human one-liner
  canonical: "...",                   // the dedupe sentence: <symptom> on <surface> when <trigger>
                                      // — stable across runs/personas/builds; what gets embedded/searched
  expectation: "...",                 // what the actor expected (quoted from the step)
  observed: "...",                    // what actually happened
  evidence_steps: [12, 13],           // indices into the trajectory the claim rests on
  location: { surface: "/checkout", signature: "..." },  // normalized; feeds the fingerprint (§5.3)
  confidence_inputs: { anomalies: ["http_5xx", "console_exception"] }  // deterministic signals present
}
```

`confidence`, `fingerprint`, the embedding, and `status` are **not** in the claim — they are
assigned downstream (§5.2–5.3, §8). The model proposes; the harness disposes.

---

## 5. Lane 3 — the triage pipeline

`bugfinder.js` is a **sibling of `grader.js`**: same shape (`findBugs(runDir, resolvedCase) ->
bugReport`), same LLM/forced-tool plumbing, run in parallel right where `gradeRun` is called
(§7). It writes a run-local `bugs.json`; everything cross-run lives in the ledger (§8).

```
trajectory.jsonl + manifest + har   (immutable; same input the grader reads)
        │
   5.1 DETECT      deterministic anomaly extractor → candidates → model classifier → claims
        │
   5.2 VERIFY      refute pass (kill false positives) + confidence ladder (env-gated)
        │
   5.3 DEDUPE      3-tier: exact fingerprint → recall retrieval → model adjudication
        │
   5.4 PROMOTE     human review gate (mirrors heal accept/reject)
        │
  (5.5 LOCALIZE    optional, read-only, source-aware — deferred)
        │
  (5.6 BUILD       worktree-isolated, repro-gated PR — deferred)
```

### 5.1 Detect — deterministic-first, model-second

Do **not** hand a model the raw trajectory and say "find bugs" — it hallucinates defects and
burns tokens. Two passes:

1. **`src/shared/anomalies.js`** — a deterministic extractor, **browser-safe ESM like
   `movement.js`** so it is unit-testable and reusable by the viewer. It pulls *candidates*
   straight from envelopes already recorded: `4xx`/`5xx` in `network.requests`,
   `console_errors`/`js_errors > 0`, `confusion: action_failed|no_effect|repeated_action`,
   perf-budget breaches, and **expectation contradictions** (step N's `expectation` vs step
   N+1's `result`/`thought`). No model.
2. **Model classifier** — `prompts/bugfinder-system.md` (pinned), forced tool call against
   `bug.schema.json`. It *classifies and explains* the grounded candidates and additionally
   hunts the semantic bugs deterministic rules can't see (wrong total displayed, stale state
   after nav, data not persisted). Grounding it in real signals is what keeps precision up.

### 5.2 Verify — a confidence ladder, env-gated

Two mechanisms. The first is always available; the second is gated on whether Playtest controls
the environment.

**Refute pass (always, cheap).** A second model call prompted to *refute*: "app bug, or user
confusion / intended behavior / env flake? cite the step; default to refuted if uncertain."
Kills most hallucinated bugs for ~one call.

**The repro ladder (confidence elevation, env-gated).** Re-running is *not* the primary
verification — the actor has already mutated state, so a clean re-run isn't always possible.
Re-run is a confidence elevator layered on the always-available evidence pack:

```
ALWAYS   ── EVIDENCED    the evidence pack (§4): a demonstration, not a reproduction. Pure data.
IF env   ── REPLAYED     re-execute the recorded action track via act-mode (executeLocator —
controllable             machinery that ALREADY EXISTS). Anomaly recurs on replay? Cheaper and
                         more reliable than a fresh agentic run; still subject to state drift.
IF env   ── REPRODUCED   managed mode (compose + init/reset.sh): boot a FRESH container, run the
seedable                 synthesized case N times. det-fail = gold. This is exactly where
                         Playtest already controls the world (the todo suite resets per run).
```

This maps onto the existing managed-vs-external distinction in `env.js`: managed/seedable →
REPRODUCED reachable; external/shared → REPLAYED best-effort, REPRODUCED unavailable; always →
EVIDENCED. The rung reached becomes the issue's `confidence`:
`reproduced-deterministic > reproduced-flaky > replayed > evidenced`. (Intermittent re-run =
real but **flaky** — tag it, don't drop it.)

**This is also the loop into the core product.** A REPRODUCED bug's synthesized case is a
*failing journey case*. When the bug is fixed, that case becomes a *passing committed baseline*
— a regression test forever. The bug-finder manufactures regression tests.

### 5.3 Dedupe — three tiers, because a fingerprint alone cannot carry it

Dedupe is the hardest correctness problem in the subsystem. A normalized signature alone has
real false-negatives (same root cause at different URLs; varying error wording; the same bug
described differently across runs) — and a duplicate ticket is noise that makes humans stop
trusting the ledger. So **precision does not live in the fingerprint**; it lives in a model
adjudicator, and the fingerprint is demoted to a fast exact-match cache.

```
new claim (+ canonical dedupe sentence)
   │
 TIER 1  exact fingerprint        b-tree lookup over the WHOLE corpus, free. Hit → bump
   │     (loose/conservative)     occurrence; if status=resolved → ★FIX REGRESSED★ (queue-jump).
   │ miss                         DONE, no model.
 TIER 2  retrieval — RECALL only  FTS5(canonical+evidence) ∪ cosine(embedding); top-K (~5–10)
   │                              open + recently-resolved candidates. Wide net.
 TIER 3  adjudication — PRECISION model: "same root cause as any of these K? cite it, else novel."
   │                              Bounded by K; this is where same-vs-different is actually decided.
 same → bump occurrence           novel → new issue + snapshot evidence pack (§4.2)
```

Three properties make this robust where a signature alone is not:

- **Fingerprint brittleness becomes a *performance* cost, not a correctness bug.** Its only job
  is exact recurrence (the most important case — "this exact thing came back"). If it
  under-normalizes and misses, the claim falls through to Tier 2–3, which is the correct path
  anyway. Worst case: one extra model call. This is why it can be loose, and why it is a
  *lookup column, never the identity* (§8.2-1).
- **You embed a model-canonicalized sentence, not raw evidence.** `<symptom> on <surface> when
  <trigger>` (e.g. *"Cart total shows a stale value after removing an item on the checkout
  page"*) is stable across runs/personas/builds and embeds/searches far better than any stack
  trace. Normalizing stack traces and dynamic IDs is the nightmare you avoid by canonicalizing
  at the model.
- **Retrieval only needs recall**, because Tier 3 makes the final call. So FTS5 over canonical
  sentences may suffice for the PoC with **zero new dependency**; embeddings are the upgrade if
  measured recall is the bottleneck (§14, embedding-provider decision).

**Scale note (answers "thousands over time").** sqlite handles millions; thousands is nothing.
The only thing that scales with total corpus is *fuzzy* dedupe, so split the access pattern:
Tier 1 (exact) is an indexed lookup run against the **entire** history including
resolved/wontfix — it catches "a bug from two years ago came back" and never gets expensive.
Tiers 2–3 (fuzzy) run only against the **bounded active set** (open + a recently-resolved
window), so even at 50k total issues the search set is a few hundred and brute-force cosine
stays sub-10ms. You reach for `sqlite-vec`/ANN only if the *active* set ever gets large — it
won't.

### 5.4 Promote — the human gate

A status transition, gated on confidence, **mirroring `heal → candidate → accept/reject`**:
bugs are candidates awaiting human promotion, exactly like changed journeys — a mental model
the user already has. Auto-promote only `reproduced-deterministic` + verified + novel; hold the
rest in a lower lane; the refuted ones are dropped (or kept in a low-priority audit bucket, not
surfaced). "Accept-with-steering" = the human appends a root-cause hypothesis / constraints /
"don't touch X" to the issue, which seeds localization and the builder.

### 5.5 Source localization — optional, read-only, DEFERRED

Detection is black-box (the source may be elsewhere). But once an issue is *confirmed and
deduped*, an optional **read-only** enrichment can run — *only when a source path is configured*
(§11) — fanning out subagents to localize the defect to suspect files/functions and attach a
hypothesis. It is **not** the builder: localization is read-only and safe to run automatically;
the fix is a write and stays behind the human gate. Deferred past the PoC; runs post-dedupe so
it never wastes effort on duplicates.

### 5.6 Builder — worktree-isolated, repro-gated, DEFERRED

The flashy end, deliberately last. One bug → one isolated git worktree → one branch → one PR
(never the user's working tree). **Its acceptance test is the repro case manufactured in §5.2**
— red before, green after — plus the existing suite stays green (Playtest dogfooding itself).
Output is a PR for human merge; the human gate stays at merge. On merge, the repro case is
promoted to a committed journey baseline.

---

## 6. Closing the loop — bugs become regression tests

The reason this is a Playtest feature and not a generic bug tracker: the artifacts are the same
substrate at different lifecycle stages, so the funnel feeds the core product.

```
  adversarial run  ──►  evidence pack (§4)  ──►  [REPRODUCED] synthesized failing case (§5.2)
                                                          │
                                                  human promote + builder fix (§5.6)
                                                          │ red → green
                                                          ▼
                                              committed journey baseline  ──►  caught forever
                                              (results/<case>.baseline.*)       by the existing
                                                                                regression suite
```

A regression baseline is the happy path, replayable. A bug evidence pack is the failing slice,
demonstrable. A *fixed* bug is a new baseline. Nothing in the pipeline invents a new data model
— it moves a slice of trajectory data along a lifecycle and, at the end, hands it back to the
regression engine that already exists. That is also why a recurrence of a `resolved` issue
(§5.3, Tier 1) is the highest-value event in the system: it means a committed regression test
*should* have caught a re-break, and the ledger noticed first.

---

## 7. Run integration — where it hooks in

`bugfinder.js` runs in parallel with `gradeRun`, right after the grade block in `runner.js`
(today ~`runner.js:299-327`), gated by config (§11), **defaulted off on journeys**. Both are
independent readers of the same immutable trajectory — no ordering, no shared state, no risk to
the journey control path.

- New run-local artifact **`bugs.json`** (the finder's per-run output, like `grade.json`),
  added to `manifest.artifacts`.
- Cross-run intelligence (dedupe, occurrence counts, resolved-regression detection, suppression)
  lives **only** in the ledger (§8). `bugs.json` is stateless per-run.
- Promotion (ledger upsert + evidence-pack snapshot) is a post-run step, not in the hot loop.

---

## 8. The substrate — a local sqlite ledger

### 8.1 Why sqlite (and not JIRA, and not flat files)

The store must be **searchable, persistent, and offline**. Flat markdown files aren't
searchable without building a search layer; JIRA-as-store breaks offline `npm test`, is
per-user, and welds dedupe correctness to a remote API's rate limits. **sqlite is the
searchable persistent store that stays inside Playtest's offline/zero-server ethos** — embedded,
transactional, FTS5 built in, no daemon (the same posture as `playwright`'s native binaries and
the zero-dep todo app). JIRA/GitHub/Linear become idempotent *mirrors* behind a seam (§9). The
same store can later host the run-history catalog the `movement.js:5-7` seam already anticipates
(*"that seam is where a SQLite index ... plugs in later"*) — note: `CI_INTEGRATION.md §12`,
referenced there, **does not exist**, so this doc authors that contract.

### 8.2 The durability invariants (these are the whole point)

You will not get the schema right on day one. These five invariants make the schema *evolvable*
so history is never thrown away. They are the same instincts the repo already lives by
(trajectory is verbatim truth; everything derived is *computed, not stored*; `schema_version`
everywhere).

1. **Identity is an opaque surrogate, never the fingerprint.** The PK is a content-free id
   (uuid/ksuid) assigned at creation, derived from nothing. The fingerprint is a *mutable lookup
   column*. When the fingerprint algorithm improves — and it will — re-fingerprinting the corpus
   touches a column, not the PK; identities (and every occurrence linked to them) survive. This
   is the invariant that, violated, *forces* throwing away history.
2. **Keep verbatim inputs; treat every algorithm-output as recomputable.** The evidence pack
   (§4) is bedrock and kept verbatim (it's a subset of the already-frozen step envelope, so it
   needs no new bedrock format). Fingerprint, severity, canonical sentence, embedding are all
   *derived from it and stamped with the algorithm version that produced them*. Upgrade →
   batch-recompute from inputs you still have. The cardinal sin is storing a derived value whose
   inputs you discarded.
3. **Embeddings are a quarantined, rebuildable cache — never truth, never identity.** Vectors
   from different models can't share a space, and you *will* change models over years. Store
   `embedding_model` + `dim` per vector; never commit them; treat the whole vector column as
   derivable from the canonical sentence. Switch models → re-embed all sentences in one batch.
4. **Occurrences and status are append-only events, not mutable counters.** Store an
   `occurrence` log and a `status_event` log; keep denormalized current columns for fast
   queries, but the *truth* is the event stream. A counter throws away exactly the history you'll
   want: cross-persona convergence, when-it-recurred, the resolved→regressed timeline.
5. **Additive-only schema, `schema_version` per row, forward migrations under the `npm test`
   gate.** Never repurpose a column; add and deprecate. Readers handle old and new (like
   trajectory readers handle envelope `schema_version` today), so you can *always read* old rows
   — you never hit "can't parse, discard."

### 8.3 Schema (DDL) — read the zones, that's the design

```sql
-- ZONE: identity (never changes) + bedrock (verbatim, kept forever, small) + derived (versioned, disposable)
CREATE TABLE issue (
  id             TEXT PRIMARY KEY,   -- [identity]  opaque surrogate, derived from NOTHING
  schema_version INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  canonical      TEXT NOT NULL,      -- [bedrock]   the dedupe sentence — verbatim INPUT
  evidence_ref   TEXT NOT NULL,      -- [bedrock]   path to snapshotted evidence pack (§4.2)
  kind           TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,      -- [derived]   a LOOKUP column, NOT the PK
  fp_algo        TEXT NOT NULL,      -- [derived]   version stamp → recompute on upgrade
  severity       TEXT NOT NULL,      -- [derived]   versioned, mutable
  confidence     TEXT NOT NULL,      -- [derived]   evidenced|replayed|reproduced-flaky|reproduced-det
  status         TEXT NOT NULL       -- [derived]   denormalized current; truth is status_event
);
CREATE UNIQUE INDEX issue_fp ON issue(fingerprint, fp_algo);  -- exact recurrence over ALL history, free
CREATE INDEX issue_status ON issue(status);                   -- bound the fuzzy-dedupe active set

CREATE TABLE occurrence (              -- [events] append-only; NOT a counter
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issue(id),
  run_id TEXT NOT NULL, ts INTEGER NOT NULL, persona TEXT, driver TEXT,
  confidence TEXT NOT NULL, evidence_ref TEXT NOT NULL
);
CREATE TABLE status_event (            -- [events] append-only: new→open→resolved→regressed→...
  id TEXT PRIMARY KEY, issue_id TEXT NOT NULL REFERENCES issue(id),
  ts INTEGER NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
  actor TEXT NOT NULL,                 -- 'human' | 'auto'
  note TEXT
);
CREATE TABLE embedding (               -- [cache] rebuildable from issue.canonical; never committed
  issue_id TEXT PRIMARY KEY REFERENCES issue(id),
  model TEXT NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL
);
CREATE TABLE sink_link (               -- [mirror] reconstructable pointer; ledger works with all sinks gone
  issue_id TEXT NOT NULL REFERENCES issue(id),
  tracker TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT
);
CREATE VIRTUAL TABLE issue_fts USING fts5(canonical, evidence, content='');  -- recall tier
CREATE TABLE suppression (             -- known-acceptable noise; filtered BEFORE surfacing
  fingerprint TEXT, fp_algo TEXT, reason TEXT, by TEXT, ts INTEGER
);
```

Identity never changes. Bedrock is small and kept forever. Derived is versioned and disposable.
Events are append-only. Cache and mirror are reconstructable. **The only thing that must be
*right* on day one is the bedrock format — and it's a verbatim subset of contracts already
frozen.**

### 8.4 Committed truth vs derived index — the fork (§14)

A binary `.db` is bad in git (no diffs, merge conflicts). If dedupe state must survive a clean
checkout / be shared across a team / CI — and the "resolved bug recurred" signal *requires* this
— make the **committed truth diffable** (per-issue JSON/markdown under `<suite>/issues/`, the
evidence pack already lives there) and the **sqlite a rebuildable index** (`playtest issues
reindex` rebuilds it from the committed files; embeddings recompute on reindex). If PoC-only and
single-machine, just locate one `.db` and move on. Recommendation: committed-truth + rebuildable
index, because that's what makes cross-machine regression detection real.

---

## 9. The sink seam — idempotent mirrors

A `Sink` interface, selected by one defaulted config key `tracker` (`none` default | `github` |
`jira` | `linear`), **mirroring the Driver seam exactly** (one interface, in-tree
implementations, switch dispatch — no registry, no discovery, no user-authored sinks; "no
speculative abstraction"). Properties:

- **Idempotent.** On promote, push; store the returned `external_id` in `sink_link`. On a
  recurrence of an already-pushed issue, **comment on the existing ticket**, never open a new
  one.
- **Off the hot loop, offline-safe.** The ledger is fully functional with every sink
  disconnected. A sink push is a post-promotion side effect; failure is a warning, not an error.
- **Scrubbed.** Anything leaving the local store is stripped of secrets (§14).
- Optional, like `webdriverio` for the mobile driver — `none` users never need network or auth.

---

## 10. Pins, prompts_version, and the contract-drift trap

The subsystem adds prompts (`actor-bughunt.md`, `bugfinder-system.md`, the refute prompt). The
**single global `prompts_version`** keys run comparability and the golden-bytes test pins it on
the web journey path. Bumping it makes **every existing web baseline non-comparable** — squarely
the "silent contract drift" the repo forbids. Two acceptable resolutions; pick one explicitly
(§14):

1. **Keep bug-hunt prompts strictly off the journey control path** and do *not* bump the
   journey-affecting version. The new overlay is slotted after Persona (§3) and only assembled on
   bug-hunt/explore runs, so the web journey prompt's bytes — and its pinned `prompts_version` —
   are unchanged. (Recommended for the PoC.)
2. **Scope `prompts_version` per mode/driver**, so the bug-hunt prompt corpus versions
   independently of the journey corpus. More correct long-term, a bigger contract change.

Either way the decision is recorded, not discovered. A new pin (e.g. `bugfinder_prompts`) added
to `manifest.pins` must also be added to `PIN_KEYS` in `movement.js` if it should key
comparability — adding it to the manifest alone does nothing (the same two-edit gotcha §16
documents for `driver`).

---

## 11. Config surface (the whole change)

New keys, all defaulted, validated by enum in both `case.schema.json` and
`defaults.schema.json`, inheritable like the rest:

```yaml
# playtest.yaml (suite defaults)
bug_hunt: true            # default false. Runs bugfinder.js parallel to the grader on explore runs.
tracker: github           # default none. Selects the Sink (§9).
source_path: ../app       # default null. Enables read-only localization (§5.5); absent ⇒ black-box only.
embed_model: null         # default null ⇒ FTS-only dedupe. Set to enable the vector recall tier (§5.3).
```

`bug_hunt: true` on a journey (measured) case is a `DummyConfigError` naming the file — the same
cross-field strictness `config.js` already enforces for `vision`/discovery. Bug-hunting is an
exploration concern; it never touches the gated control path. A `tracker` other than `none`
without that sink's credentials configured is a friendly config error at load, not a stack trace.

---

## 12. CLI surface

One new noun, `issues`, mirroring the shape of the existing hidden lifecycle commands
(`accept`/`reject`/`grade`):

```
playtest issues [list]   [--status open|new|resolved|...] [--severity ...] [--json]
playtest issues show <id>                         # the evidence pack, occurrences, status timeline
playtest issues triage                            # interactive promote/suppress queue (the human gate)
playtest issues promote <id> [--steer "<note>"]   # → needs-human-review or hands to builder (deferred)
playtest issues suppress <id> [--reason "..."]    # add to suppression; dedupe filters it thereafter
playtest issues reindex                           # rebuild the sqlite index from committed truth (§8.4)
playtest issues sync                              # push/refresh the configured sink (§9), idempotent
```

---

## 13. Testing contract (the merge gate)

The repo rule: `npm test` is offline, in-process, **0 skipped**, and the **web path must never
regress**. This subsystem ships only with:

- An **offline golden test** driving a deterministic bug-find scenario through `mock-llm.js`
  (the finder's forced tool call returns a canned claim; the deterministic extractor is pure and
  trivially testable). Without this, the feature cannot merge under the repo's own rules.
- A **dedupe test**: two runs producing the same canonical sentence collapse to one issue with
  two occurrences; a `resolved` fingerprint recurring emits the regressed signal.
- A **migration test**: a forward migration over a fixture DB preserves identities and reads old
  `schema_version` rows.
- **Golden-bytes unchanged for web journeys** — proving the bug-hunt prompts stayed off the
  control path (§10).
- `src/shared/anomalies.js` unit tests (browser-safe, no harness).

---

## 14. Hard parts / open decisions

1. **sqlite binding.** `better-sqlite3` (mature, native build, FTS5) vs Node 22.5+ built-in
   `node:sqlite` (no dep but bumps the Node floor from 20, experimental) vs `sql.js` (wasm, pure
   JS, slower). Recommendation: `better-sqlite3` for a tool already shipping Playwright's native
   binaries. **A new manifest dependency — flag it per the CONTRACTS preamble.**
2. **Committed truth vs single `.db`** (§8.4). Recommendation: committed diffable truth +
   rebuildable index, to make cross-machine regression detection real.
3. **`prompts_version` scoping** (§10). Recommendation: keep bug-hunt prompts off the journey
   path for the PoC; revisit per-mode scoping later.
4. **Embedding provider** (§5.3). Anthropic serves no embeddings; the recall-vector tier needs
   OpenAI (`text-embedding-3-small`, fits the existing `OPENAI_API_KEY` fallback), Voyage, or a
   local ONNX model (keeps offline). Recommendation: ship FTS-only first; add embeddings only
   when measured recall demands it.
5. **Retention policy.** "Thousands over time" is fine for the *rows* (small scalar core kept
   forever); the bulky evidence-pack files (screenshots, har slices) are what age out. Design the
   table split (§8.3) so a cold row stays useful (dedupe, trend, regression detection) after its
   pack files are archived. Not a day-one feature, but a day-one *schema* concern.
6. **Repro reliability is environment-bound** (§5.2). REPRODUCED is reachable only in
   managed/seedable envs; external/shared surfaces get EVIDENCED + best-effort REPLAYED. Honest
   confidence labels, never a false "reproduced."

### Security / privacy

`har.json` carries auth headers and cookies by contract. The evidence pack (§4) and every sink
push (§9) **must scrub** them. This is not optional — a bug report mirrored to JIRA that leaks a
session cookie is a far worse bug than the one it reports.

---

## 15. Phasing (build order — each phase independently shippable)

| Phase | Deliverable |
|---|---|
| **0** | `src/shared/anomalies.js` + tests; surface anomalies in the existing discovery grade. Near-zero surface, validates signal quality. |
| **1** | `bugfinder.js` (detect + classify), `bug.schema.json`, `bugs.json` artifact, golden test. The grader's sibling. |
| **2** | Refute pass + the repro/confidence ladder (reusing `runCase` / act-mode replay). |
| **3** | sqlite ledger (DDL, invariants, FTS dedupe), `playtest issues` triage, suppression. |
| **4** | Sink seam (GitHub/JIRA/Linear), idempotent. Optional dep. |
| **5** | `actor-bughunt.md` + saboteur persona; read-only localization; builder skill (worktree, repro-gated, PR out). |

PoC = Phases 0–3 (detect → verify → ledger → human review). No source code, no builder, no JIRA
until the funnel's precision is proven.
