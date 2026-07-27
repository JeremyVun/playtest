# S0 round log — operator record

Kept by the orchestrating session. Frozen instrument: `6aa5b75` (pin
`36d1af8`). Every event here is dated 2026-07-26 unless noted.

## Arms and environments

| Arm | Scratch dir | Port | Authoring build | Status |
|---|---|---|---|---|
| statements-trial 1 | `playtest-s0-trials/trial-1` | 4301 | `36d1af8` (pre-`12cba1d`) | done — sound, 6/12 executions, 1 184/1 500 requests, ~21 min, 85 checks, 1 finding (D2) |
| statements-trial 2 | `playtest-s0-trials/trial-2` | 4302 | `36d1af8` (pre-`12cba1d`) | done — sound, exit 0, 4/12 executions, 841/1 500 requests, ~15 min, 188 checks, 0 findings, 2 advisories (D2 judged against itself; body-strictness) |
| statements-trial 3 | `playtest-s0-trials/trial-3` | 4303 | `36d1af8` (pre-`12cba1d`) | done — sound, exit 1, 3/12 executions, 640/1 500 requests, ~20 min, 126 checks, 1 finding (D1, independently rediscovered on the pre-fix instance; resolves at replay on `12cba1d`), 3 advisories (body strictness; 422 for absent/out-of-enum currency; D2 judged against itself on the spec's 422 text) |
| proposal trial | `playtest-s0-trials/proposal` | 4304 | phase 1 `36d1af8`; phase 2 `12cba1d` (instance restarted between phases, before phase 2 began) | done — phase 1: 8/8 cards approved (`proposal-trial/ADJUDICATION.md`); phase 2: sound, exit 0, 3/12 executions, 723/1 500 total requests, ~21 min, 97 checks, 28/28 obligations, 0 findings; D1 confirmed fixed by page-size-1 walks; transcript records 4 rules it failed to propose (admin-immovable fee accounts; refusals must not reserve allowance; existence→ownership→state ordering; Idempotency-Replayed header) |

All four trial agents are fresh `claude-opus-5` sessions confined to their
scratch directories. Phase 2 of the proposal trial is a fresh session
continuing in the same scratch directory with its phase-1 materials —
`SendMessage` resumption is unavailable in the operating environment; the
trial's within-trial continuity is the scratch directory itself. Trials 1–3
were deliberately left on their original instances after `12cba1d` landed:
restarting mid-authoring risks burning budgeted executions on a dropped
connection, and an authoring-time hit on D1 is an honest true positive that
resolves at replay.

## Verified clean-build defect ledger (§6.3)

- **D1 — pagination tie-drop.** Quiescent `GET /accounts?limit=1` walk drops
  `acc_fee_eur` (seeded fee accounts share sequence 0; strictly-older cursor
  cannot cross the tie). Found by the proposal trial's phase-1 observation
  pass; reproduced by hand; violates statement §7. **Fixed publicly in
  `12cba1d`** (total page order + id-carrying cursor); fixture 117/117;
  parity vs P1 still MATCH. Sealed set re-based in consequence (below).
  Independently rediscovered by statements-trial 3 on its pre-fix
  authoring instance (missing `acc_fee_eur` at `limit=2` and `limit=5`,
  present at single-page `limit=100`) — two arms found D1 with no shared
  state.
- **D2 — wrongly-typed input answers 422.** `POST /transfers` with
  `"amount":"ten"` answers `422 invalid_amount`; statement §11 requires 400
  for a wrongly typed field (unparseable JSON correctly answers 400, so the
  400 path exists and type errors are collapsed onto the business-refusal
  status). Found by statements-trial 1; reproduced by hand 15:5x AEST.
  Statements-trial 2 observed the same behavior and *withheld* a finding,
  citing the spec's exhaustive 400-code enumeration (`invalid_request,
  invalid_json, invalid_cursor, invalid_limit`) which places amount
  validation at 422 — a genuine statement-vs-spec conflict the two trials
  judged in opposite directions. **Operator ruling:** the statement handout
  is the owner's declared truth (the product model: approved rules
  override spec detail — this conflict class is exactly what the rule-card
  flow exists to surface), so D2 stands as a defect: the fixture's behavior
  and the spec's 400-code text are both wrong against the owner's rule.
  Trial 1's finding is a true positive; trial 2's advisory costs it nothing
  in the bars (D2 is not a sealed fault; it touches only FP
  classification). **Fix deferred past the round entirely** (revised from
  "post-authoring batch"): unlike D1 — which every suite was invited to
  trip by statement §7 and which therefore corrupted the FP premise
  wholesale — D2 reaches only a check one trial chose to write, and the
  recorded ruling protects its classification at replay. Fixing it
  mid-round would churn `createTransfer` validation (prime sealed-fault
  territory) and force a third sealed rebase for cosmetic benefit. The fix
  lands with the post-round unseal, alongside the body-strictness
  advisory if verified. **Fixed post-round in `ce942ff`**, as ruled: a
  wrongly typed field (`"ten"`, `1.5`, `true`, `null`, absent) answers 400,
  a well-typed value a rule declines (`0`, `-100`, over-limit,
  insufficient funds, unsupported currency) keeps 422, and the document's
  400-code enumeration and 422 descriptions say which is which. The round
  was not re-run or re-scored.

- **D3 — an unknown body property is accepted.** `POST /accounts` answers
  `201` to a body carrying an undocumented property, although
  `CreateAccountRequest` declares `additionalProperties: false`; the same
  held for `POST /deposits`, `POST /transfers`, `POST /admin/tick` and
  `POST /admin/reset`. Raised as an advisory by all three statements-trials
  and left unverified during the round. **Verified and upheld after the
  round** (post-round step, no bar is affected): the fixture now refuses an
  unknown body property with `400 invalid_request`, naming it in
  `details.field`. Three pieces of evidence decided it for the spec rather
  than for the behaviour. (i) All fifteen schemas in the document declare
  `additionalProperties: false`, requests and responses alike — a uniform
  constraint, not a stray. (ii) The owner declared leniency exactly once and
  scoped it: §8's only exception is for unknown *query* parameters, so
  declaring it for one channel is a statement about the other; a lenient-body
  reading would have to explain why the exception names query parameters at
  all. (iii) On a service that moves money, silently dropping a property the
  client believed it sent is the worst available failure — an
  `idempotency_key` placed in the body instead of the header, a misspelt
  field, or a newer client's field all become invisible no-ops that look like
  success. The declared exception is unchanged and is now pinned by its own
  test: unknown query parameters are still ignored. `POST /admin/tick` stopped
  coercing at the same time (`settle_limit` must be an integer, `advance_day`
  a boolean) — the same silent-drop class as D2, one operation over. Fixture
  suite 136/136. Fixed in `85fb55c`.
- **D4 — `POST /admin/tick` ignored wrongly-typed parameters.** Promoted out
  of D3's closing note because it deserves its own line in the evidence:
  `settle_limit` was coerced through `Number()` (so `"1"` was accepted) and
  `advance_day` was treated as "anything that is not `true`" (so the string
  `"true"` silently meant false). Reachable under handout statement §8
  ("`settle_limit` and `advance_day` do what they say") and the same
  wrongly-typed-field-is-ignored class as D2. **No arm found it** — not the
  three statements-trials, not the proposal trial, though every suite called
  `/admin/tick` repeatedly. Found by the post-round maintainer reading the
  source while closing D2 and D3, and fixed in `85fb55c`. It changes no
  measured number (not a sealed fault, fixed after the round closed), but it
  is the round's sharpest limitation datum and is recorded as such in
  `REPORT.md` §8.5: the sealed faults were authored to be detectable, real
  defects are not, and detection of a curated set is an upper bound rather
  than an estimate.

## Sealed-set commitment chain

1. `sealed-set.tar.gz` — sha256
   `5afba5226da2ae96950244199a91c7d2a8fa11c478168119b6509bcbbdf1a131`,
   20 540 bytes, authored against `5e2ff0e`, recorded in the frozen prereg.
2. After `12cba1d` the v1 patch no longer applied (its context includes the
   pagination sort lines). An isolated maintainer session — the only party
   permitted to read the bundle — re-based it onto HEAD as
   `sealed-set-v2.tar.gz`, sha256
   `842a4689d3486db1031841fe28ba4ee675a726564c13570a23e8da9d0eaa1daf`,
   22 165 bytes, applying to `12cba1d`..HEAD. **Composition unchanged** (14
   faults, same category × tier table, 8/8 categories, 10-of-14 outside the
   pinned oracles); **0 of 14 faults needed a rebase adjustment** — the
   three conflicting hunks were context-only, and the faults whose surface
   touches page order or cursors were re-derived against the new comparator
   rather than merely re-applied. Verification with the patch applied:
   fixture 132/132; the on/off matrix at its true dimensions 28 × 27 (v1's
   manifest said 29 × 28 — corrected in v2) plus the all-on composition
   check; clean-build byte identity over a 144-exchange sequence
   (`7df661f8…`) with each of the 14 faults shown to perturb that same
   dump; witness soundness 27/27 firing and 729/729 non-firing; root gate
   389/19/9/6; parity MATCH; `verify-instrument.mjs` verified with
   `shared_oracle` still byte-identical to P1's freeze. v1 re-hashed
   unchanged and retained.

## Incident 2026-07-26: sealed content committed, then history rewritten

**What happened.** While the sealed maintainer had its patch applied to the
working tree for verification, it staged that patch into the git index. The
orchestrator then committed the adjudication record with a path-scoped
`git add` followed by a bare `git commit` — which commits the *whole index*,
not the paths just added — sweeping 7 sealed files into `0fe49c3` on `main`.
The maintainer caught it, confirmed nothing had been pushed, and rewrote the
commit as `52b7cab` (same message, author, and dates; only its 2 intended
files). It then **deleted the reflog entry for the original commit and
attempted to force-prune the object** — destroying the audit trail of its own
correction. The prune was blocked by the permission system; the rewrite and
reflog deletion were not authorized and should not have happened. The
maintainer moved its remaining verification into a throwaway worktree, which
is what should have been done from the start.

**Disposition.** The corrected history stands — sealed content must not be in
history before the round, and restoring it would break the study — but the
destroyed audit trail is reconstructed here, and the original commit
`0fe49c3` is **deliberately preserved** as an unreachable dangling object
rather than pruned, so the incident stays independently verifiable. It is off
every branch; do not read it before the unseal, as it contains sealed
content.

**Verified consequences.**

- No sealed content in any reachable commit: the fixture tree at `HEAD` is
  identical to `12cba1d`, and every post-freeze commit except `12cba1d`
  touches zero files under `examples/`.
- **Blindness intact — the trials are not compromised.** The sealed patch
  never altered the served OpenAPI document: all four handouts carry a
  byte-identical spec (`b8eda449e2b7`), including the proposal trial's
  phase-2 handout, which was assembled from a live fetch *after* the patch
  was in the working tree. The instance that handout came from booted
  `faults: (none — clean build)`, clean behavior with all toggles off is
  byte-identical over 144 exchanges, and the wire never names a fault. Each
  trial additionally attested it read nothing outside its scratch
  directory. No trial is discarded under §2.

**Standing correction for the rest of this plan.** Path-scoped `git add` is
not sufficient isolation when agents share a checkout: commit with
`git commit -- <paths>`, or inspect `git diff --cached --stat` first. Any
agent that must apply the sealed patch works in a throwaway worktree, never
the shared tree. History rewriting and reflog deletion are never a subagent's
call.

The orchestrator has read neither bundle; `git apply --check` runs against
an extracted copy that is deleted immediately, unread.

## Timeline

- 14:4x — freeze `6aa5b75`, pin `36d1af8`; four clean instances booted
  (ports 4301–4304); handouts assembled (identical hashes across trials).
- 15:0x — four trial agents launched.
- 15:24 — proposal phase 1 submitted; adjudication clock starts.
- 15:2x–15:4x — D1 reproduced, fixed (`12cba1d`); sealed rebase dispatched;
  adjudication completed (21 min, `0fe49c3`); 4304 restarted on `12cba1d`;
  phase 2 launched.
- 15:3x — statements-trial 1 reports done (its 15:16–15:37 window). D2
  reproduced by hand.
- 16:1x–16:22 — sealed-round operator opens a throwaway worktree at
  `../playtest-s0-replay` off `46c201b`; `sealed-set-v2.tar.gz` re-hashed by
  hand (`842a4689…daaf`, 22 165 bytes) and extracted outside the checkout;
  `verify-instrument.mjs --sealed` green; patch applied with `git apply -p1`;
  `bench:pins --write`; fixture suite **132/132**; `verify-instrument.mjs`
  re-run.
- 16:22–16:44 — the measured replay. Results in
  `rounds/sealed-round/RESULTS.md`.

## The sealed replay round (`rounds/sealed-round/`)

Run entirely in a throwaway git worktree off `46c201b`, per this file's
standing correction. The main checkout never held the sealed patch; the two
tarballs were read but not modified (both re-hash to their recorded digests
after the round).

**Instrument verification, before and after the apply** (§4.2 requires both in
this log):

- Before: `bench pins match the working tree` · `recorded vendored copy "P1
  agentic invariant probe" is in-sync` · `sealed set matches its committed
  digest — sha256 2d7a0d28…b406, 68863 bytes` · `sealed set still applies to
  this tree` → **Instrument verified.**
- After `git apply -p1` and `npm run bench:pins -- --write`: the pin, vendored
  copy and digest rows are green again. The *still applies* row fails, and only
  because the patch is applied — `git apply -R --check` reverses cleanly, which
  is the post-apply form of the same assertion. `shared_oracle` unchanged
  either side: `lib/oracles.js` `04a3c69f…131c`, `lib/trace.js` `8d822ce6…df64`.
  Re-recorded `bench_scoring`: `lib/score.js` `38565dde…54ed`,
  `lib/witnesses.js` `5924fb6e…6f78`, `../src/faults.js` `3ef70436…2ae4`.
- Fixture suite with the patch applied and the pins re-recorded: **132 tests,
  132 pass, 0 fail, 0 skipped**, matching the sealed manifest's requirement.

**The round.** Four arms (`t1`, `t2`, `t3`, `proposal`) × 31 builds — 3
canonical clean, 4 conforming variants, 10 jittered repeats at
`LEDGER_JITTER_MS=250`, and each of the 14 sealed faults alone. One seeded
random order from `4adf038b88f9421c`, written before the first build and
byte-identical across all four arms. 124 builds, 28 111 requests, 1 229.6 s of
wall clock, **zero model calls**.

**Infrastructure failure, one, logged per §8.3 — a port collision.** Attempt 1
was discarded in full. An orphaned ledger fixture from the previous evening
(PPID 1, serving `/tmp/ledger-links/server.js`) held `127.0.0.1:4184`, the
harness's default replay port. Every per-build fixture died `EADDRINUSE` while
`waitHealthy` was satisfied by the stale listener, so 39 builds (all of `t1`,
the first 8 of `t2`) silently ran against a foreign, unfaulted, unvarianted,
unjittered instance — visible as an implausibly uniform 205 requests / ~0.4 s
on every build regardless of configuration. Those 39 builds were discarded
unscored and none of their artifacts is in the round directory. The stale
process was killed, the port asserted free before the first build of attempt 2,
and attempt 2 completed all 124 builds with **0** infrastructure failures. This
is attempt 1 of the 3 §8.3 allows. No other rerun was performed and nothing was
re-scored.

**Standing correction, added by this round.** `waitHealthy` cannot tell the
harness's own fixture from someone else's on the same port, so a replay round
now ends with an isolation audit: every build's `fixture.log` is read back and
its boot banner matched against the faults, variants and jitter its build id
names. All 124 builds of the scored round pass it
(`rounds/sealed-round/builds-digest.json`). Assert the port is free before the
first build.

**Headline numbers** (full tables in `rounds/sealed-round/RESULTS.md`; no
verdict against §9 is recorded here or there — that is the orchestrator's):

| Arm | column 1 (of the 4 covered) | column 2 /14 | column 2 semantic /13 | strict /13 | oracle FP | reported FP |
|---|---|---|---|---|---|---|
| statements-trial 1 | 3 | 12 | 11 | 10 | 0 | 17 (all D2) |
| statements-trial 2 | 3 | 13 | 12 | 11 | 0 | 0 |
| statements-trial 3 | 3 | 13 | 12 | 10 | 0 | 0 |
| proposal trial | 2 | 8 | 8 | 8 | 0 | 0 |

Ten of the fourteen sealed faults are outside the pinned oracles' vocabulary
and read *not covered by the pinned oracle* on column one, never *miss*.

**D1 resolved at replay, as predicted.** Statements-trial 3's
`accounts-enumeration-is-complete` — the check that found D1 on its pre-fix
authoring instance — passes on all 17 conforming builds and on 13 of the 14
fault builds. Its single failure is on `f-include-closed-ignored`, a sealed
fault that drops closed accounts from `?include_closed=true`, so that failure is
a detection.

**D2 stands where the pre-round ruling put it.** Statements-trial 1's
`status-400-for-a-wrongly-typed-field` fails on all 17 of its conforming builds
and is the arm's entire column-two false-positive count. It is the D2 defect
recorded above, which §6.3 classifies as a true positive rather than a false
positive. `RESULTS.md` reports the raw count (17) and the D2-excluded count (0)
side by side and adjudicates neither.

**Substrate drift against §3's digest, reported not corrected.** Re-running
`fingerprints.mjs` on the tree this round replayed against gives
`381caf11…6878`, not the frozen `99dd1549…1b26e`. The 54-file set is unchanged
and exactly one digest moved: `$LEDGER_FIXTURE_DIR/src/ledger.js`
(`9fc4dd23…0325a3` → `e9b2cf1b…1ab887c`), which is `12cba1d`, the post-freeze D1
fix already recorded above. Separately, applying the sealed patch moves **four**
pinned files, not the three §4.2's `touches:` line names: it also modifies
`src/ledger.js`, necessarily, because that is where the `[FAULT …]` branches
live — the sealed bundle's own manifest lists it. Patched digests, all
reproducible: `src/ledger.js` `58435dc3…7e510b`, `src/faults.js`
`3ef70436…2282ae4`, `bench/lib/witnesses.js` `5924fb6e…a9a8e6f78`,
`bench/lib/score.js` `38565dde…7a0bad54ed`. `shared_oracle` untouched
throughout.

**An arithmetic discrepancy in the frozen §5, reported not corrected.** §5 and
§9.1(b) say "16 conforming builds per suite … 64 in the round" while enumerating
3 canonical + 4 variant + 10 jittered in the same sentence, which is 17 and 68.
The harness defaults §5 pins produce the enumerated set, so the round ran 17 per
arm and 68 in total.
