---
name: playtest-bughunt
description: >
  Author a Playtest defect-detection study — forced-risk discovery stories and
  thorough (adversarial) personas that walk dangerous corners of a real app so
  bugs actually fire. Use when the human wants to find bugs, raise defect
  detection, stress functional edge states in a flow, run a "bug hunt" or QA
  risk pass, write adversarial stories, or stop happy-path-only discovery from
  missing edge failures. Do not use for load, throughput, concurrency, or
  latency testing. Not a new Playtest mode: same mode:discovery machinery.
  Prefer this over playtest-stories when the goal is catching breakage, not UX
  insight or regression gates.
---

# Playtest bug hunt (authoring)

You help someone **find more real defects** on a staging app by writing
missions that *force* risky corners — and personas that re-read, try bad
inputs, and flag contradictions. You are not writing a security red-team, and
you are **not** inventing a new Playtest mode.

**Evidence from seeded-fault evaluation:** most misses were **coverage** — the
story never opened the trap — not AI blindness. Forced-risk stories paired with
an adversarial persona improved recall. Recognition misses need re-read and
contradiction discipline in the persona and report questions, not more happy
paths.

Keep jargon light with non-technical people. Internally stay precise.

## 0. What this is / is not

| This skill | Not this skill |
|---|---|
| Author **discovery** cases that force one risk per story | New `mode: bughunt` (forbidden) |
| Default **`persona: adversarial`** (built-in) + optional careful second | Replacing journey regression |
| Portable **risk classes** (empty submit, bad input, recovery CTA, …) | Writing stories from a known fault catalog |
| Hand off run → **playtest-discovery** | Automatic issue filing (not required for detection) |

**Route away:**

- “Make sure checkout still works” → **playtest-stories** (journey).
- “Where do users get stuck finding export?” → **playtest-stories** (discovery insight).
- “Did CI break a journey?” → **playtest-ci**.

If they want *both* insight and bug hunt, say so and split: trunk discovery
stories (natural paths) vs `risk/` forced cells — same suite is fine.

## 1. Interview — surfaces and risks, not a happy path

Settle:

1. **Which product surfaces** exist on *their* app (forms, cart/checkout, pay,
   search, inventory, account, post-purchase, empty states, sort/filter).
2. **What “broken” means** to them (wrong data, silent failure, dead control,
   misleading copy, loop, missing recovery) — not “feels slow.”
3. **Staging URL + how to reset** (empty cart, stock N, a declined card, a
   past order). Without reset, forced preconditions are fiction.
4. **Budget** — each story × each persona is a full agent run. Prefer
   **risk stories × adversarial** (1 persona). Add a careful persona only where
   human-like reaction matters (e.g. contradiction readability). Cap concurrent
   browsers if they say the machine is small (≤3 is a safe default).

Push:

- Don’t accept “test everything.” Converge on **the flow under scrutiny** plus
  the risk classes that apply.
- For each candidate story: “What precondition *must* be true for this trap to
  fire?” If they can’t name it, the story is still a happy path — rewrite.
- **Decision test:** what would they fix if the mission reports failure? Drop
  stories that change nothing.

**Research:** use the boundary already stated in the request. If it is
unresolved, ask once whether to stay black-box or inspect staging/code. Use code
for setup (how to seed/reset) and, after the user-visible risk goal is fixed, to
identify a stable `data-testid` or ARIA hook for a later regression gate. Never
put selectors or implementation paths in actor stories, and never add a
`success` gate to these discovery cases. Read bundled
`schemas/case.schema.json` + `defaults.schema.json` (or `packages/core/src/schemas/` in
the Playtest repo) as the key contract.

## 2. Risk classes (portable checklist)

Map **only classes that exist on their app**. One class → one case when
possible. Force the precondition in the **story body**, not only in `report:`.

| Class | Force in the story | What to observe |
|---|---|---|
| **Empty / missing precondition** | Open pay/submit/export with nothing selected / empty cart | Guard vs form-for-nothing vs crash |
| **Invalid / boundary input** | Bad email, empty required, over-max qty, unspaced/malformed payment fields | Error shown? Fields wiped? Silent swallow? |
| **Declined / failing dependency** | Use a known-bad card / fail path they document | Clear failure vs swallowed |
| **Last unit / inventory edge** | Add exactly stock N, then N+1 if relevant | Can buy last unit? Over-sell? |
| **No-results / empty search** | Search a guaranteed nonsense query | Jargon vs clear empty; clear-control works |
| **Sort / filter inert** | Note first items; apply sort/filter; re-read same metric | Order/filter actually changed |
| **Label ↔ control contradiction** | Open known OOS / disabled / limited state; quote label vs button | Agree or contradict |
| **Silent mutation** | Add/save/pay; re-read cart badge, list, total, toast, confirmation | Expected change present? |
| **Recovery after terminal** | After success/empty/error, click primary Continue / Clear / Back to X | Lands somewhere useful, not a loop |
| **Missing affordance after prior success** | After order/save, look for history, local continue, crumb, receipt ETA | Control present and honest |
| **Form reset / wipe** | Invalid submit then inspect other fields | Unrelated fields cleared? |
| **Stale UI after nav** | Mutate → browser Back / re-open surface | Badge, qty, sort still correct? |

Invent app-specific *instances* of these portable classes. Do not copy paths or
entities from an evaluation fixture into unrelated products.

**Out of scope for this skill:** XSS, auth bypass, injection, rate-limit abuse.
If they ask for security testing, refuse and point at a security tool.

## 2b. Actor raises (structured sticky notes)

The harness lets the actor attach optional `raises` on each step (not free-form
thought): `kind: "finding"` or `kind: "confusion"`, with a quotable `note`, up
to five per turn. Prefer this channel for anything a reviewer should scan.
Legacy `confused`/`confused_reason` is sugar for one confusion raise.

You do not author raises in the YAML — the **persona + story** make the actor
more likely to use them. Adversarial personas should re-read and flag
contradictions; report questions should ask for the same observations so the
grader has both actor raises and Q&A evidence.

## 3. Personas

### Default: built-in `adversarial`

Prefer `persona: adversarial` (shipped with Playtest). Behavioral contract
(also bundled as `persona-adversarial.md` next to this skill for offline
reference):

- Completes the mission; stresses forms with **one** invalid/boundary input
  when the story does not already force it.
- **Re-reads** after every mutation; states whether the expected thing changed.
- After terminal states, clicks **primary recovery** and notes where it lands.
- Flags **label ↔ control** contradictions.
- `give_up` with a clear reason — never fake `done`.
- **No** attack payloads.

### When to add custom personas

| Need | Do |
|---|---|
| Domain voice (retail buyer, admin, patient) | `personas/<slug>.yaml` with `name` + `description` that **includes** the adversarial contract above, not a vague “is careful” |
| Human-like reaction on a contradiction cell | Second persona: careful first-timer or exploratory — list `[adversarial, careful-…]` on that case only |
| Speed / rush stress | Optional rusher persona on add-to-cart / pay cells only — not on every risk cell |

Do **not** fan out every risk story across 4 personas — cost explodes for little
detection gain. Recommended coverage: **risk × adversarial** (+ optional one
careful persona on recognition cells).

```yaml
# personas/careful-first-timer.yaml  (optional second)
name: careful-first-timer
description: |
  You are new here and read labels carefully. You complete the mission, re-read
  after changes, and say when copy and controls disagree. You do not invent
  attack payloads. If blocked twice, give up with a clear reason.
```

## 4. Author the suite

Layout (discovery study, not journey baselines):

```
studies/<name>/                 # or any suite dir
  playtest.yaml                 # mode: discovery, app.base_url, models
  personas/                     # only customs; built-in adversarial needs no file
  risk/                         # forced-risk cases (recommended folder)
    risk-empty-checkout.yaml
    risk-invalid-email.yaml
    …
  # optional trunk/ for natural-path discovery — not this skill’s focus
```

**`playtest.yaml` essentials:**

```yaml
mode: discovery
app:
  base_url: http://localhost:PORT   # staging only — never production
  # init / compose if they need a clean reset each case
# Prefer a capable actor when detection matters; pin explicitly.
# actor_model: …   # whatever their gateway accepts
# grader_model: …
```

**Every risk case:**

```yaml
description: One line — which corner this forces (for run lists).
tags: [risk]                      # always; enables filtering
story: |
  Second person. 3–8 lines. MUST force the precondition and the action
  in the story body (navigate empty checkout; submit bad email; sort then
  re-read prices). One primary risk per file. Quote what to compare when
  the risk is a contradiction.
persona: [adversarial]            # or [adversarial, careful-…] on recognition cells
report:
  - Did the forced precondition actually happen? Quote evidence.
  - What did the UI do (message, disabled control, wipe, loop, silence)?
  - Any contradiction between labels and controls, or expectation vs result?
  - What would a real user conclude is broken or misleading?
```

Rules of thumb:

1. **Force in `story:`, verify in `report:`** — report-only questions do not
   make the actor walk into the trap.
2. **One risk per case** — multi-trap stories leave half unfired.
3. **Seed, don’t hope** — if the story needs stock=1 or a past order, wire
   `app.init` / hooks / documented fixture; say when they must seed manually.
4. **`success:` is illegal** on discovery — config error. Detection here is
   graded findings + report answers, not a pass/fail gate. Promote a proven
   defect later to a **journey** with a forced pin via playtest-stories if they
   want regression.
5. Always set **`description`**.

## 5. Validate

```
playtest list <dir> --json
playtest lint <dir>
playtest personas   # from suite dir — adversarial must resolve
```

Check: every risk case present; fan-out ids are
`<case>@adversarial` (and optional second); `next_run: explore`; no journey
`success` keys; tags include `risk`.

## 6. Hand off — run and synthesize for *defects*

Run with **playtest-discovery** (preflight, cost honesty, staging guard,
`playtest <dir>`). Before they launch, state cell count = stories × personas
and that this is a detection pass, not a UX interview.

When synthesizing (or when discovery synthesizes this suite), **lead with
defects**, not “where users looked first”:

1. **Broken / misleading behaviors** with run-dir + step evidence.
2. Group by **risk class** (empty guard, validation wipe, contradiction, …).
3. Separate **soft UX / taste** from **correctness** (silent fail, wrong total,
   dead control, loop).
4. Note **coverage gaps**: risk classes on the checklist with no cell yet.
5. Do **not** claim “Playtest detected” for issues the human only found by
   reading source.

Optional filter: `playtest <dir> --tag risk` when trunk and risk share a suite.

## 7. Anti-patterns (detection killers)

| Anti-pattern | Why it kills detection |
|---|---|
| Happy-path only stories | Traps never spring |
| Report Q without forced story body | Actor never enters the state |
| 4 personas × all risk cells | Cost wall; people thin the suite badly |
| Security payloads | Wrong product; noise and refusal |
| Journey mode for open hunting | Baseline/heal path; wrong instrument |
| Writing faults from a known plant list as if portable | Cheats the metric; doesn’t transfer |
| Soft “explore checkout” with adversarial persona only | Persona helps *inside* a mission; does not invent empty-cart |

## 8. Worked shape (generic SaaS, not a plant shop)

```yaml
# risk/risk-empty-submit.yaml
description: Submit the invite form with empty required fields.
tags: [risk]
story: |
  Open the team invite screen. Do not fill the email field. Click the primary
  invite / send control once. Report whether required-field errors appear, the
  button no-ops, or a request fires anyway.
persona: [adversarial]
report:
  - What happened on empty submit? Quote any error or lack of one.
  - Anything broken, silent, or misleading?
```

Author invalid-input handling and unrelated-field preservation as separate
cases so each case forces and diagnoses one primary risk.

That is the whole product idea: **same discovery harness, missions that force
risk, persona that refuses to shrug.**
