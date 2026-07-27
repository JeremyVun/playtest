# Prompt review — two-angle assessment

*Reviewed 2026-07-27 by two agents. The first review assessed effectiveness and
conciseness across the runtime prompts and later added `skills/`. The second
review independently traced prompt assembly, tool schemas, current CLI/runtime
contracts, every `skills/*/SKILL.md`, both shipped persona resources, and all
four bundled skill schemas. This document preserves the first review and makes
the agreements, disagreements, and reconciled execution order explicit. No
prompt changes were made as part of the second review.*

## The inventory at a glance

| Prompt | Lives in | Words | Role |
|---|---|---|---|
| Actor — web | `src/core/prompts/actor-system.md` | ~940 | Web journey actor |
| Actor — mobile | `src/core/prompts/actor-mobile.md` | ~840 | Mobile journey actor |
| Actor — API | `src/core/prompts/actor-api.md` | ~750 | API journey actor |
| Actor — discovery overlay | `src/core/prompts/actor-discovery.md` | ~210 | Added in discovery mode |
| Actor — vision overlay | `src/core/prompts/actor-vision.md` | ~125 | Added when vision is on |
| Grader — regression | `src/core/prompts/grader-system.md` | ~720 | Journey grading |
| Grader — discovery | `src/core/prompts/grader-discovery.md` | ~1260 | Discovery-study grading |
| Grader — assert | `src/core/prompts/grader-assert.md` | ~195 | Claim verification |
| Drift-report narrative | `src/core/prompts/drift-report.md` | ~350 | Human half of API drift reports |
| Consolidation (deduper), local | `src/core/findings/consolidate.ts` | ~185 | Groups bug candidates into findings |
| Consolidation (deduper), hosted | `control-plane/src/findings/consolidation.ts` | ~185 | Same instrument, hosted findings |
| Auto-resolve verifier | `control-plane/src/findings/verify-fix.ts` | ~70 | Is this one finding still present? |
| Discovery synthesis | `control-plane/src/findings/synthesis.ts` | ~250 | Cross-persona study findings |
| Rule-card proposer | `src/core/api-suite-scripts/proposals.ts` | ~430 | Proposes API business rules |
| Script authoring loop | `src/core/api-suite-scripts/authoring.ts` + handout | ~75 + 1230 (BRIEF) + 2400 (CLIENT) | Writes API test suites |
| Script drift revision | `src/core/api-suite-scripts/drift.ts` | ~55 | Revises a suite after contract drift |
| Story-drafting assistant | `control-plane/src/authoring/assistant.ts` + `skills/playtest-stories/SKILL.md` | ~330 + ~1690 | Hosted "help me draft" chat |
| Skill — stories | `skills/playtest-stories/SKILL.md` | ~1690 | Story-authoring interview workflow |
| Skill — bughunt | `skills/playtest-bughunt/SKILL.md` | ~2000 | Defect-detection study authoring |
| Skill — discovery | `skills/playtest-discovery/SKILL.md` | ~830 | Running + synthesizing studies |
| Skill — hooks | `skills/playtest-hooks/SKILL.md` | ~900 | Authoring `before_each` hooks |
| Skill — assertions | `skills/playtest-assertions/SKILL.md` | ~1140 | Authoring custom assertions |
| Skill — ci | `skills/playtest-ci/SKILL.md` | ~830 | CI fix loop / failure triage |
| Persona — exploratory | `skills/playtest-stories/persona-exploratory.md` | ~125 | Built-in actor persona |
| Persona — adversarial | `skills/playtest-bughunt/persona-adversarial.md` | ~180 | Built-in actor persona |
| Skill schema resources (four copies) | `skills/{playtest-stories,playtest-bughunt}/schemas/` | ~9,900 combined | Agent-facing configuration source of truth |

## Reconciled verdict

The prose is generally strong, but the full prompt surface is not ready for a
purely editorial cleanup. The first review correctly identified grader typos,
sibling drift, and avoidable repetition. The independent review found two
higher-priority skills defects that change execution:

- The schemas bundled with `playtest-stories` and `playtest-bughunt` are stale
  while both skills call them “the source of truth.” Agents following them miss
  current API authoring capabilities and can produce obsolete configuration.
- `playtest-hooks` explicitly says returned setup context is never persisted and
  may contain a credential, but the runner records that message in
  `context.jsonl`. Its worked example returns a plaintext password.

These are correctness and secret-handling issues. Fix them before trimming
`grader-discovery`, removing internal-study jargon, or refactoring duplicated
prompt prose.

The underlying prompt design remains good: roles are clear, deterministic
boundaries are usually explicit, failure/uncertainty escape hatches are strong,
and the skills route work by user intent instead of exposing implementation
terms. The smallest runtime prompts remain the best examples of the house
style.

## Independent second review

### Method

The second review used five tests:

1. **Correctness:** does the instruction match current source, schemas, CLI
   help, and contracts?
2. **Safety:** does it preserve human-only decisions, staging boundaries,
   secrets, and the distinction between evidence and instructions?
3. **Executability:** can an agent follow it without an unavailable command,
   contradictory example, or missing output channel?
4. **Routing:** will the frontmatter and body select the right skill and hand
   off cleanly?
5. **Attention economy:** does repeated text close a real failure mode, or only
   consume context?

This was a static review. It did not run model evaluations, so claims about
which rewrite improves compliance remain hypotheses until tested against a
small fixed task corpus.

### Where both reviews agree

| Area | Agreement |
|---|---|
| Actor prompts | Snapshot examples, current-ref discipline, falsifiable expectations, loop detection, and honest `done`/`give_up` rules are high-value. The mobile loop paragraph is malformed and the legacy `confused` advertisement is expendable. |
| Main graders | The gate/deterministic-evidence boundary is strong. The four typos should be fixed, and discovery grading repeats enough guidance to justify a careful edit. |
| Findings prompts | Consolidation, fix verification, and synthesis have appropriately narrow mandates, grounded IDs/citations, and useful uncertainty paths. |
| Authoring prompts | Rule-card proposal and script authoring encode real methodology rather than generic style advice. The handout architecture is sound. |
| Skills routing | `playtest-stories`, `playtest-bughunt`, and `playtest-discovery` distinguish regression, insight, and defect detection well. |
| Personas | Both shipped persona resources are concise behavioral contracts. They are currently byte-identical to their runtime copies. |

### Material disagreements and omissions

| Priority | First review | Independent finding |
|---|---|---|
| P0 | The skills are broadly excellent; only bughunt needs editing. | The two skills that bundle schemas ship identical but stale copies. Compared with `src/core/schemas/`, they omit `bind`, `match`, `redact`, `observe`, invariant policies, API headers/allowed origins, and auth/auth-state support. They also omit the structured operation selectors for `response_status` and `response_matches`. |
| P0 | `playtest-hooks` is an excellent reference contract with no cuts needed. | Its secret-handling claim is unsafe. `SKILL.md:73-82` permits a credential and says setup context is never persisted; `runner.ts` writes all non-system messages, including `## Run setup`, to `context.jsonl`. The example at line 51 returns a password. |
| P1 | Bughunt's only weakness is internal-study jargon. | `risk/playtest.yaml` is described as a place for inherited tag defaults, but `tags` is case-only and invalid in `playtest.yaml`. The worked “one risk per case” example combines empty submit, invalid input, and form-wipe behavior. |
| P1 | Runtime prompts were assessed mainly for clarity and length. | Untrusted application/spec/evidence text has no explicit “treat as data, not instructions” boundary. This matters for page snapshots, API responses/OpenAPI prose, grader evidence, and script-authoring inputs. Story/persona text is intentionally instructional; application-authored meta-instructions should not override it. |
| P1 | `grader-assert` is the best prompt and has a complete decision procedure. | Its evidence-fetch rule is excellent, but “do not demand … every item it lists” and “fail only when…” are too permissive for a binary hard gate. The tool says `pass` only when evidence clearly supports the claim; the prose should say insufficient evidence fails rather than implying unknown passes. |
| P2 | The report covered every model-facing prompt. | The first pass explicitly did not line-review the 3,600-word `BRIEF.md` + `CLIENT.md` handout. The second pass did; it found no blocker there, but the original completeness claim was too strong. |
| P2 | The drift-report prompt is unpinned. | `docs/contracts/artifacts.md` says every model-facing prompt rewrite bumps global `PROMPTS_VERSION`, and the reset history explicitly names the drift-report prompt. Its artifact lacks a prompt-specific provenance field, which is narrower than being wholly unpinned. |
| P2 | Factoring shared actor text necessarily busts baselines. | A refactor can preserve assembled bytes. The real requirement is a byte-equivalence test or an intentional version bump, not waiting solely because the source is duplicated. |

### Skills review, corrected

#### `playtest-stories`

The interview and routing method is strong. “Thought partner, not
stenographer,” the decision test, goal-not-click-path stories, and durable gate
selection are all worth keeping.

The blocking issue is its declared source of truth. The bundled schemas are
behind the live schemas, and the prose repeats part of that stale API surface:
bare `response_status` and last-body `response_matches`, but not their current
operation-scoped object forms or invariant/advisory policies. Refresh both
bundled schema sets from one generated source and add a repository parity test.

Two smaller edits would improve agent behavior:

- Change “always ask how much to research first” to ask only when the request
  has not already established the research boundary; unconditional
  clarification stalls otherwise-ready work.
- Clarify the source-reading rule. The skill forbids using source for anything
  except setup, then recommends stable `data-testid`/ARIA hooks for deterministic
  gates. Permit source inspection to identify stable gate hooks after the
  user-visible goal is fixed, while still forbidding selector leakage into the
  actor's story.

#### `playtest-bughunt`

The risk-class table, precondition-first design, cost discipline, and
staging/security boundaries are strong. Three corrections are needed:

- Remove the suggestion that nested `playtest.yaml` can supply tag defaults;
  every case must carry `tags: [risk]`.
- Split the worked example or explicitly label it an exception. It currently
  violates the skill's central “one risk per case” rule by testing empty
  submission, invalid email, and unrelated-field wipe in one case.
- Generalize the internal study labels as the first review recommends. The
  recall result is useful; “M3,” “Fern & Fog,” and “hillclimb” are not.

Its frontmatter should also distinguish functional edge-state stress from load
or performance stress so “stress-test” does not over-trigger this skill.

#### `playtest-discovery`

The staging refusal, cost confirmation, and mandatory synthesis are excellent.
Keep them. Tighten preflight in two ways:

- Check only whether an API-key variable is present; never print its value.
- Replace or supplement the `npm root`/`npm ls` package-resolution recipe with
  a check based on the resolved `playtest` executable, so linked and
  nonstandard installations do not produce false negatives.

#### `playtest-hooks`

The idempotency, handle choice, and lifecycle explanation are strong, but the
return-value guidance must change before this skill is used:

- State that returned context is sent to the model and recorded in
  `context.jsonl`.
- Forbid long-lived credentials, tokens, and backend secrets in the return
  string.
- Replace the password example with a non-secret handle/state fact.
- If secret setup context is a product requirement, change the runner to omit
  or redact it from diagnostic context and test that behavior before restoring
  the claim.

#### `playtest-assertions`

This is otherwise an accurate, useful reference contract. One minor correction:
custom assertion values are scalar `string | number | boolean`, not always an
“opaque spec string.” The example may stay string-based, but the prose should
match the runtime contract.

#### `playtest-ci`

The human-only baseline decisions, four-verdict triage, and exit-2 boundary are
strong. Clarify “This is the product working” to “This is Playtest catching an
application failure”; in context, “product” can be read as the application that
the next sentence tells the agent to fix. For API heals, point triage at
`drift-report.json` before summarizing a change so the deterministic
`regression` / `contract_drift` / `baseline_drift` classification is not
ignored.

#### Shipped persona and schema resources

The two persona resources exactly match `src/core/personas/` today. The two
case-schema copies match each other, and the two defaults-schema copies match
each other, but neither pair matches the live core schema. Add parity tests for
all six copies or generate them during packaging; relying on manual copying has
already failed for schemas.

### Runtime prompt concerns the first angle underweighted

1. **Instruction/data boundaries.** Add a short, role-appropriate rule wherever
   application-authored content enters a model call: page/API snapshots, fetched
   grader snapshots, OpenAPI descriptions, API responses, and prior generated
   scripts. It should reject meta-instructions while still allowing legitimate
   UI copy and product instructions to be interpreted as evidence.
2. **Hard-assert uncertainty.** Align `grader-assert.md` with the verdict tool:
   pass only on affirmative support; contradiction or insufficient evidence is
   false. Do not require exact wording, but do require every material condition.
3. **Prompt/schema alignment.** “Promote, refine, or discard with reason” has no
   dedicated discard-reason field in `grade.schema.json`, and `report` is not
   conditionally required when report questions exist. Either enforce these in
   validation or remove instructions the output contract cannot reliably
   represent.
4. **Version wording.** Record prompt-specific provenance where it affects a
   durable artifact, but do not call a prompt unversioned when the repository's
   global prompt-version contract already covers it.

## First review: detailed prompt-by-prompt assessment

The sections below preserve the first review's reasoning. Where they conflict
with the independent findings above, the reconciled priority list at the end
controls execution.

---

## Actor prompts

### The three driver overlays (web / mobile / API)

**Effectiveness: strong.** These carry the load of the whole product and it
shows. The worked snapshot example is the single highest-value passage —
it teaches the ref grammar faster than any amount of prose. The ref-validity
rules ("refs are only valid in the snapshot they appear in"), the
loop-detection instruction, the falsifiable-`expectation` requirement, and
the done/give_up honesty section are all doing real work. The
`thought`-readability guidance ("it is shown to a person in the viewer") is a
clever move: it gives the model a *reason* to write well rather than a bare
style rule.

**Conciseness: acceptable, with three specific concerns.**

1. **~80% of the text is triplicated.** The three overlays share the persona
   framing, the log-reading advice, `thought`, `expectation`, the entire
   `raises` block, the legacy `confused` note, and the done/give_up section
   nearly verbatim; only the snapshot example and the action list genuinely
   differ. This is a maintenance cost, not a token cost (each run sends one
   overlay), and the drift has already started — see next point. The
   counterweight is real: `actor.ts` deliberately pins byte-identical
   assembly for the golden `prompts-v10` test, so factoring the shared text
   would bust every baseline. Worth doing only when a content change forces a
   version bump anyway.

2. **The mobile overlay has drifted downward in quality.** Its loop-detection
   paragraph is a degraded rewrite of the web version, ending in a dangling
   fragment: *"Even when each tap 'succeeds' but the screen is not responding
   the way you expect."* The web version of the same paragraph is complete
   and also carries the extra motivational clause ("just wastes time and
   money") that mobile lost. This is exactly the sibling-drift failure mode.

3. **The `raises` block is the longest single section (~150 words in each
   overlay) and documents a legacy field on top.** The `confused` /
   `confused_reason` compat note costs a paragraph in all three overlays.
   If the schema keeps accepting the legacy field silently, the *prompt*
   doesn't need to advertise it — models only need to know the preferred
   path. Dropping the legacy paragraph from all three is the cheapest
   conciseness win in the repo (requires a prompts version bump).

### Discovery overlay (`actor-discovery.md`)

**Excellent.** ~210 words, every one earning its place. "Name what you are
looking for and WHERE you expected to find it" plus the worked example is
the core of the discovery product in three lines. The rehabilitation of
`give_up` ("the most valuable data a discovery run can produce") is exactly
the right counterweight to the base prompt's completion drive. No cuts
suggested.

### Vision overlay (`actor-vision.md`)

**Excellent.** ~125 words. The "screenshot is for looking only" rule closes
the obvious failure mode (acting on pixels), and the worked example ("the
export link is tiny grey text under it") sets the register for the `visual`
field. No cuts suggested.

---

## Grader prompts

### Regression grader (`grader-system.md`)

**Effectiveness: strong, with shipped typos.** The 0–100 anchor bands are
concrete and well-spaced; "you are scoring the app's journey quality, not the
agent's intelligence" is the single most important sentence and it comes
second. The gate-as-ground-truth rule, the invariant-verdict handling
(VIOLATED = fact, NOT EXERCISED = story gap), and the "you may explain, never
overturn" boundary are all crisp.

Two literal typos ship to the model on every graded run:

- *"The digest tell syou what each step DID"* (should be "tells you")
- *"toread that step's captured snapshot"* (should be "to read")

Models cope with typos, but this paragraph is the one instructing the grader
to fetch evidence before asserting — the highest-stakes instruction in the
file — and the same two typos appear verbatim in `grader-discovery.md`,
confirming the paragraph was copy-pasted between the two files rather than
shared. That paragraph is a strong candidate for single-sourcing at the next
version bump.

**Conciseness: good.** ~720 words for this many responsibilities is tight.
The only soft spot is the `summary` section, which spends two sentences
restating the anti-wall-of-text style rule already given to the actor.

### Discovery grader (`grader-discovery.md`)

**Effectiveness: high. Conciseness: the weakest in the repo.** At ~1260
words this is the longest prompt file, and it reads like a document that
grew by accretion: findings guidance, bug-candidate guidance, deterministic
signals, report questions, and summary guidance each added a section, and
several ideas now appear two or three times:

- "Actor raises are sticky notes — promote, refine, or discard, don't
  ignore" appears in both the findings section and (in near-identical words)
  in `grader-system.md`.
- "The summary is synthesis, not re-narration" is stated twice within the
  summary section itself.
- The give_up-is-valid-data point appears in the opening paragraph and again
  in the score anchors.

The content itself is very good — the `bug_candidates` section in
particular is the best-designed passage in either grader ("before emitting a
candidate, try to disprove it", followed by a concrete exclusion list). But
the file has visibly outrun its proofreading:

- *"ties the grad together"* (grade)
- *"the headlin reason"* (headline)
- the two copy-pasted typos from `grader-system.md` noted above
- inconsistent dash style (ASCII hyphens as sentence dashes in the newer
  sections, em-dashes in the older ones — a fingerprint of which passages
  were added when)

A careful editing pass could take this to ~950 words with zero loss of
instruction, and would likely *improve* compliance: the highest-value rules
(disprove-first, cite steps, one issue one finding) currently compete for
attention with restatements.

### Assert grader (`grader-assert.md`)

**The best prompt in the repo.** ~195 words. *"The trajectory digest … is a
map, NOT the evidence"* is a genuinely great instruction — it inoculates
against the exact shortcut a model would take. The common-sense standard
("would a reasonable person agree") with its two explicit failure conditions
is a complete decision procedure in one paragraph. Use this as the template
for future prompts.

### Drift-report narrative (`drift-report.md`)

**Very good.** The three-field structure with a worked standard for each,
plus the "no authority over the verdict" ground rule, is exactly right for a
narrator bolted onto a deterministic pipeline. "A reviewer is better served
by 'this is not a valid heal' than by a rationalisation" is the kind of
norm-setting sentence that pays for itself. No cuts suggested. One gap: this
prompt has no version pin, unlike its peers in `scripts/` — see cross-cutting
notes.

---

## Findings-pipeline prompts (inline)

### Consolidation / deduper (local and hosted, `consolidate-v1`)

**Excellent, twice.** ~185 words each. The scoping sentence ("a
deterministic retrieval step already decided these few items are worth
comparing; your job is only…") correctly shrinks the model's mandate, and
"there is deliberately no low confidence" forecloses the hedge that would
otherwise poison the unresolved bucket. The ID hygiene rule ("never invent
an id") is essential and present.

The concern is structural, not textual: the local and hosted copies are
near-identical (only "candidates" vs "reports") and intentionally share the
`consolidate-v1` pin — meaning they are supposed to be one instrument — yet
they exist as two string literals in two packages. The first time one is
edited without the other, the shared pin becomes a lie. Hosted code already
imports engine functionality through `src/core/public/`; the prompt could
travel the same road.

### Auto-resolve verifier (`resolve-verify-v1`)

**Exemplary.** ~70 words. Narrow mandate, explicit non-goals ("do not grade
the run, do not report other problems"), and the crucial escape hatch: "if
the snapshots never show the place the issue lives, the answer is
indeterminate." That one sentence is what keeps auto-resolve from resolving
findings on absence of evidence. Nothing to cut, nothing missing.

### Discovery synthesis

**Very good.** ~250 words. "Convergent evidence is the headline" and the
divergence note (power user succeeds where newcomer gives up ⇒ capability
exists but is undiscoverable) encode real analytical method, not just
formatting rules. The citation discipline ("an uncitable claim must be
dropped") matches the deduper's ID hygiene. Appropriately concise for its
position in the pipeline.

---

## Scripts / authoring prompts (inline)

### Rule-card proposer (`rule-proposal-v1`)

**The most ambitious prompt in the repo, and it earns its ~430 words.** The
framing paragraph — "a bad card is a plausible sentence they will approve
without checking, because a wrong approved rule is a false positive on every
future build, forever" — gives the model the *economics* of the task, which
is much stronger than a rule list alone. The six format rules are each
justified in-line ("a merged card is approved once and tested once, and the
second rule quietly vanishes"), and the worked JSON example is complete.

One inconsistency worth noting: this is the only prompt in the system that
parses a fenced JSON block out of a free-text reply instead of forcing a
tool call. If that's deliberate (the plain-text preamble note is part of the
product), it deserves a code comment; if it's historical, it's a robustness
gap relative to every sibling.

### Script authoring loop + handout

**Good architecture; the prompt itself is barely a prompt.** The ~75-word
system message correctly delegates everything to the handout (`BRIEF.md`
~1230 words, `CLIENT.md` ~2400 words) and states only the loop mechanics
("you have no tools, no shell… the loop executes exactly what you returned").
Putting the substance in versioned, reviewable handout templates rather than
a giant system string is the right call, and the per-turn digest
(objections, failing checks, obligation coverage) is well-scoped feedback.
The handout documents themselves were not line-reviewed here; at 3,600+
combined words they are the largest model-facing surface in the repo and
deserve their own pass if suite-authoring quality ever disappoints.

### Script drift revision (`script-revision-v1`)

**Excellent.** ~55-word system prompt whose every clause is a guardrail:
"exactly as strictly as it tested the old one", "never weaken or delete a
check to make it pass", "you return source text only." The dynamic user
prompt supplies all the evidence. This is the conciseness bar the larger
prompts should aim at.

---

## Hosted story-drafting assistant

**Very good pattern, justified length.** The assembled prompt is the largest
in the system (2,000+ words with suite context), but it single-sources the
authoring methodology from `skills/playtest-stories/SKILL.md` verbatim —
skill and hosted assistant cannot diverge — and the hosted addendum confines
itself to genuine deltas (tool substitutions, propose-don't-save, one story
per request, no YAML in chat). The "rationales are shown to a non-technical
person" rule is a nice piece of audience-setting. The suite-context tail
(defaults YAML, case list, personas, environments) is exactly the context a
drafting assistant needs and is generated, not hand-maintained. No changes
suggested.

---

## Skills and shipped personas (`skills/`)

These are prompts for a different audience: the six SKILL.md files instruct a
tool-wielding coding agent (Claude Code or similar) running a workflow, not a
constrained in-run model. Reference-manual length and density is appropriate
here — they load on demand, not on every turn — so they are judged by a
different conciseness standard than the engine prompts. The two persona files
are the exception: they ship as built-in actor personas, so their text rides
the actor system prompt on every turn of every run that uses them.

### `playtest-stories` (~1,690 words)

**Excellent, and doing double duty.** This is both the CLI authoring skill and
the verbatim-embedded body of the hosted drafting assistant, so its quality is
load-bearing twice over. The interview method is the standout: "a thought
partner, not a stenographer", the decision test ("what would they do
differently depending on the result — if nothing changes, drop it"), and the
goal-not-clickpath rule are genuine methodology, not formatting rules. The
gate-selection guidance (when `console_errors: 0` is signal vs noise, why
`element_exists` needs stable hooks) encodes real judgment. Length is
justified by density; no cuts suggested.

### `persona-exploratory` (~125 words)

**Excellent.** A tight behavioral contract — impatient, skims, gives up after
two confusions, reports friction honestly. "Real users leave, they don't
debug" is the whole persona in five words. Note the per-turn cost: persona
text rides every actor turn, and this one is appropriately lean.

### `playtest-bughunt` (~2,000 words)

**The longest prompt in the repository, and mostly earning it — with one
distinct weakness.** The risk-class table is the core asset (twelve portable
trap patterns with force-instructions and observables), the
"force in `story:`, verify in `report:`" rule is the key lesson, and the
anti-pattern table closes real failure modes. The evidence framing (coverage,
not AI blindness, drove misses) grounds the whole design.

The weakness is **internal-study jargon leaking into an ostensibly portable
skill**: "hillclimb lesson", "Fern & Fog SKUs", "M3 bugfinder", "14/26 →
19/26", "study cheat". A reader inside this repo can decode these; any other
consumer of the skill cannot, and the skill otherwise presents itself as
product surface. Either the references should be generalized ("a seeded-fault
study showed…" is already the right form, used once) or the skill should
declare its evidence base in one footnote instead of five scattered asides.
This is the one skill where a ~15% trim would improve, not just shorten.

### `persona-adversarial` (~180 words)

**Excellent.** The re-read-after-every-mutation and recovery-click
disciplines are exactly the recognition behaviors the bughunt evidence called
for, and the security boundary ("never invent XSS… attack payloads") is
stated in the persona itself, where it binds the actor. One overlap: it
documents the `raises` field mechanics, which the actor overlay already
teaches on the same turn — the third place raises are explained (overlay,
bughunt §2b, here). Harmless but a small standing drift surface.

### `playtest-discovery` (~830 words)

**Very good.** The preflight ordering ("most failed studies die here, not in
the YAML"), the hard staging-only guardrail with refusal instruction, and the
mandatory-synthesis rule ("never stop at 'the runs finished'") are the three
things this skill exists to enforce, and all three are unmissable. Cost
honesty before launch is well handled. One coupling to note: the
feature-detect instruction resolves the `@jeremyvun/playtest` package via
`npm root` / `npm ls`, which works under the supported `npm link` install but
silently assumes npm-resolvability — worth revisiting if the install story
ever changes.

### `playtest-hooks` (~900 words) and `playtest-assertions` (~1,140 words)

**Both excellent reference contracts.** Symmetric framing (a hook causes a
precondition before the actor; an assertion observes a side effect after),
honest edges ("Not built yet — only `before_each` exists… don't author
them"; the `inheritable: false` staleness trap), and worked code with the
constraints in comments. The idempotency and handle-choice guidance in hooks
("write 'check, then create-or-move' — never a bare 'create'"; ask the user
which handle, don't assume) preempts the two classic setup bugs. No cuts
suggested for either.

### `playtest-ci` (~830 words)

**Excellent, and the safest-written skill.** Hard rules come first and are
the right ones: never run `baseline accept`/`reject` (human action), never
weaken `story:`/`success:` to make a failure pass ("the YAML is spec, not
config"), exit 2 is infra not test failure. The four-verdict table (app bug /
app changed / agent flake / environment flake) with a concrete action per
verdict is a complete triage procedure. No cuts suggested.

### Skills-level observations

1. **The routing triangle is triplicated by design.** stories ↔ bughunt ↔
   discovery each carry the routing rules to the other two, in frontmatter and
   body. This is the right call — each skill must be self-routing when loaded
   alone — but it is a three-way drift surface, and today the three copies
   agree. Treat any future change to the routing rules as a three-file edit.
2. **The `raises` mechanics are now documented in three layers** (actor
   overlays, bughunt §2b, adversarial persona). Consistent today; same drift
   caveat.
3. **Bughunt is the only skill needing an editing pass** — for jargon
   generalization, not length per se.

---

## First review: cross-cutting observations

1. **Sibling drift is the live failure mode, not verbosity.** Every quality
   problem found — the mobile overlay's mangled paragraph, the duplicated
   typo'd digest paragraph in both graders, the twin consolidation strings —
   is a copy diverging from its sibling. The prompts that are single-sourced
   (skill embed, shared rule-proposer via `core/public/api-suite-scripts.ts`) have no
   such problems. When the next content change forces a version bump anyway,
   that's the moment to factor the shared actor text and the shared grader
   digest paragraph.

2. **Fix the typos at the next version bump.** Four shipped typos, all in
   the two main grader prompts: "tell syou", "toread" (both files), "the
   grad together", "headlin reason" (discovery). Cosmetic individually;
   collectively they mark the two files that most need an editing pass.

3. **The legacy `confused` paragraph is the cheapest token/attention win.**
   It occupies a paragraph in all three actor overlays for a field the
   prompt itself deprecates. Keep the schema compat, drop the advertisement.

4. **Version-pin coverage is good but has two gaps.** The scripts and
   findings prompts all carry instrument pins (`consolidate-v1`,
   `rule-proposal-v1`, `resolve-verify-v1`, `script-revision-v1`), and the
   actor/grader prompts sit under the manifest's `PROMPTS_VERSION`. Unpinned:
   the drift-report narrative prompt and the authoring-loop system string.
   Neither gates comparability today, but the convention is worth completing.

   **Action taken (2026-07-27): all prompt versions reset to v1.** The tool
   has no consumers yet and backward compatibility is explicitly not a goal
   at this stage, so the accumulated history was flattened: `PROMPTS_VERSION`
   went from `prompts-v10` to `prompts-v1` (`src/core/trajectory.ts`, with
   `docs/contracts/artifacts.md`, the pin-assertion test in
   `tests/core/unit/raises.test.ts`, and the committed baseline fixture
   `tests/fixtures/api-example/results/ledger-journey.baseline.json` updated
   to match). Every instrument pin was already at v1 and is unchanged. The
   pre-reset bump history lives in git; from here, v1 is the clean starting
   point and any prompt-byte change bumps from there.

5. **Effectiveness/conciseness ratio, ranked.** Best: grader-assert,
   verify-fix, drift revision, actor-discovery — short prompts where every
   sentence closes a specific failure mode. Solid: consolidation, synthesis,
   drift-report, actor-vision, rule-proposer, grader-system, actor overlays,
   and all of `skills/` except one. Needs an edit: grader-discovery (~25%
   reducible with no instruction loss) and playtest-bughunt (internal-study
   jargon to generalize). Nothing in the repo is bloated in the "pages of
   boilerplate" sense; the system's discipline is above average and the
   fixes are surgical.

## Reconciled execution order

1. **Stop secret leakage from hook guidance.** Correct
   `skills/playtest-hooks/SKILL.md` and its password example. Decide separately
   whether `context.jsonl` should redact setup context; until it does, the skill
   must treat every returned byte as persisted model input.
2. **Restore the skills' source of truth.** Regenerate the four bundled schemas
   from `src/core/schemas/` and add parity tests for schemas and persona copies.
3. **Fix skill correctness contradictions.** Remove tag-default advice and split
   the bughunt worked example; correct assertion scalar wording; clarify CI API
   drift triage and secret-safe discovery preflight.
4. **Add instruction/data boundaries to runtime prompts.** Cover application
   snapshots, fetched evidence, OpenAPI/response content, and prior generated
   code with minimal role-specific language.
5. **Align the hard assertion and grader output contracts.** Make insufficient
   evidence fail an `assert`, require all material claim conditions, and either
   represent or remove “discard with reason.” Enforce report-answer presence
   when questions were supplied.
6. **Do the editorial pass.** Fix the four grader typos and mobile fragment,
   remove legacy `confused` advertising, reduce discovery-grader repetition,
   and generalize bughunt's internal-study jargon.
7. **Reduce future drift.** Single-source or parity-test shared prompt fragments
   and record prompt-specific provenance for durable model-authored artifacts.

For every prompt-byte change, follow the owning version contract. Test
behavioral changes against fixed fixtures before judging them solely by token
count; concision is useful only when task success, grounding, and refusal
behavior do not regress.
