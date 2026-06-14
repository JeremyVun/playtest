# Driver interface — design + handoff (mobile, then REST API)

Status: IMPLEMENTED in the working tree (2026-06-14). This was the architectural spec for
VERSION_2 (mobile apps) and the milestone after it (REST API testing); the seam and all
three drivers now exist. The phased build sequence lives in `docs/mobile-driver-plan.md`;
the milestone framing in `VERSION_2.md`. The §9 text has been folded into `docs/CONTRACTS.md`
as the "Drivers (transport seam)" section (§16) and the schema/`pins` bumps are recorded
there — silent contract drift is the one unforgivable sin (CONTRACTS.md preamble). This
document is retained as the design rationale and handoff; CONTRACTS §16 is the live contract.

What shipped: the `Driver` seam (`src/harness/driver.js`) and the `web` (`drivers/web.js`,
`browser.js` now a re-export), `mobile` (`drivers/mobile.js` + `mobile-snapshot.js`), and
`api` (`drivers/api.js`) drivers; the per-driver actor overlays (`prompts/actor-mobile.md`,
`prompts/actor-api.md`); the additive `step.schema.json` action union; the driver-aware
`config.js` validation, `gate.js` dispatch, `preflight.js` (`preflightFor`), and
`new --driver` templates; `driver` in `manifest.pins` **and** `PIN_KEYS`. `npm test` (84,
0 skipped) is green, including `runner-mobile`, `runner-api`, and `driver` suites.

Caveats (as designed, not regressions): the `mobile` driver is exercised against a fake
Appium client (`__setMobileClientFactory`) — real-device validation is still pending;
mobile network capture (§10.1) and mobile perf (§10.2) remain deferred. The `webdriverio`
client is an `optionalDependency`, absent by default.

Repo: this repository (`@jeremyvun/playtest`). Plain JS ESM, Node >= 20, no TypeScript,
no build step. `npm test` is `node --test test/*.test.js`. User errors go through
`DummyConfigError` (src/harness/config.js) with friendly, actionable messages.

---

## 1. Motivation

Playtest today tests **web apps only**: an actor agent reads a pruned a11y snapshot of a
page, decides one action, and a Playwright/Chromium session executes it (`docs/playtest-design.md`).
Mobile (native iOS/Android) is the next milestone; REST API testing follows. Both want
the *same* engine — pinned actor, natural-language stories, deterministic gate, record →
act → heal, the trajectory viewer — pointed at a different surface.

This is already the design's stated intent, not a new direction:

> **The case schema is the stable contract; transport is orthogonal.** Keep the schema
> clean and versioned and file-mode and API-mode stay the same engine. — `NICE_TO_HAVE.md`

> **The step schema is the real interface.** The actor writes into it, the perf
> instrumentation annotates it, act mode executes straight out of it, and the grader and
> viewer read it. Everything else is implementation. — `docs/playtest-design.md`, principle #3

The audit (below) confirms it: ~80% of the harness is already transport-agnostic. The
coupling is concentrated in one class — `browser.js`'s `Session` — and the handful of
modules that name it. The work is to *honor* the existing seam, not invent one.

Design constraints carried over from the existing tool:

- **Do not contaminate the web instrument.** The web path must stay byte-identical:
  same prompts, same `step.schema.json` shape for web verbs, same envelopes, same
  manifests, the whole self-test green and unchanged. A web run recorded before this
  work must still `act` after it.
- **No new top-level commands, and the smallest possible config surface.** One new,
  *defaulted* key (`app.driver`, default `web`). Every existing `playtest.yaml` and case
  file keeps its exact meaning. Story files do not change at all for web.
- **No speculative abstraction** (standing project preference). Three in-tree drivers
  behind one interface, selected by one key — **not** a generic plugin registry, not a
  driver-discovery mechanism, not user-authored drivers. If a fourth transport ever
  appears it is a fourth file, decided then.

---

## 2. The seam: what's already neutral, what's bound

Audit of every module against the transport boundary:

| Module | Bound to web? | Disposition |
|---|---|---|
| `browser.js` (`Session`) | 100% | **Becomes the `web` driver.** This is the interface, made concrete. |
| `snapshot-injected.js` | 100% | Web driver's snapshot source. Mobile/API author their own. |
| `preflight.js` | 100% | `preflightFor(driver)`: web → chromium, mobile → Appium client + platform driver + device, api → none. Detects missing deps and installs/prompts on demand, like today's chromium flow (§2.4). The CLI's preflight call moves *after* case discovery so the driver is known. |
| `env.js` (`prepareEnv`) | mostly | Per-driver env prep (compose+probe / emulator+install / base-url+probe). |
| `gate.js` | partly | `api_called`/`assert` already neutral; `url_matches`/`element_exists`/perf are web. Driver-aware dispatch (§7). |
| `actor.js` | near-neutral | Logic generic; only the prompt prose + action verbs are web. Overlay split (§4). |
| `runner.js` | near-neutral | Generic orchestration that imports the concrete `Session` and leaks into `session.page` twice. Seal both (§2.2). |
| `trajectory.js` (baseline/diff/act) | **neutral** | Keys on opaque `action.type` / `resolution.locator` / `action.text`. Untouched. |
| `grader.js`, `report.js`, `live.js`, `runs-root.js`, `view-server.js` | **neutral** | Read the trajectory/manifest digest. Untouched (grader rubric gains one sentence). |
| `src/viewer/` | **neutral, degrades** | Fed by manifest+trajectory+artifacts; already tolerates missing artifacts. **Additive only**: verb-caption/icon cases for the new actions (§4); no structural change (§8). |

### 2.1 The `Driver` contract

The consumer (`runner.js`) defines the interface; the three drivers implement it.
`ExecResult` and `Snapshot` are almost verbatim what `browser.js` returns today.

```js
createDriver(resolvedCase, env, { runDir, headed }) -> Driver   // factory keyed on app.driver

interface Driver {
  // ---- lifecycle ----
  start(): Promise<ExecResult>          // open the app to its entry state; the returned
                                        // perf+network seed the gate (web: goto base_url ·
                                        // mobile: launch app · api: prime / health request)
  captureSnapshot(stepNum): Promise<Snapshot>
                                        // writes the per-step artifacts it has (a11y.txt
                                        // always; png when the transport has pixels;
                                        // mhtml web-only) and returns what the actor reads
  execute(action): Promise<ExecResult>        // AGENT mode: validate the ref (exists/visible/
                                              // enabled), resolve a durable locator + bbox,
                                              // run inside a measurement window
  executeLocator(actedStep): Promise<ExecResult>  // ACT mode: drive from resolution.locator
  finalPageCheck(query): Promise<boolean>     // element-exists analog; false + note where N/A
  location(): string | null                   // replaces session.page.url()
  effectToken(): Promise<string | null>       // no_effect fingerprint, transport-defined
                                              // (seals the runner's page.evaluate leak)
  consoleErrors(): number                     // 0 where the transport has no console
  close(): Promise<void>

  // ---- pinned capability descriptors (ride into manifest.pins) ----
  readonly id: "web" | "mobile" | "api"
  readonly settle: { name, ... }              // this transport's settle heuristic (§6)
  readonly overlay: { prompt: string, actions: object[] }  // actor system overlay + the
                                              // action sub-schemas valid for this transport (§4)
}

// unchanged from browser.js except: `url` -> `location` semantics (still a string; the
// FIELD name stays `url` in the envelope, see §2.3); `perf` is driver-filled and may be null.
ExecResult { ok, error, resolution: {ref?, locator, bbox} | null, settle_ms,
             location, perf: object | null, network: { requests: [...] }, har_entries: [...] }

Snapshot   { text, location, title, refCount, truncated, screenshot: Buffer | null }
```

`resolution.locator` is, and stays, an **opaque durable handle string** — a Playwright
selector for web, an Appium accessibility-id/predicate for mobile, a `METHOD /path` for
API. `trajectory.js`'s `diffTracks` already keys on it as an opaque string
(`action.type + "|" + (resolution.locator ?? action.url ?? "") + "|" + (action.text ?? "")`),
so record → act → heal works on any driver with **zero** trajectory-layer change.

### 2.2 The two leaks to seal in `runner.js`

The runner is generic except for two reaches through `session` into Playwright. Both move
*into* the driver, behind the interface:

- `runner.js:223` `session.page.url()` (final URL for the gate) → `driver.location()`.
- `runner.js:469-479` `effectToken()` → `session.page.evaluate(...)` (the `no_effect`
  confusion fingerprint: last DOM-mutation time + form values + `location.href`) →
  `driver.effectToken()`. Each transport defines its own "did anything change" token; the
  `no_effect` heuristic ("0 requests AND token unchanged") then generalizes for free.

After sealing these, `import { Session } from "./browser.js"` becomes
`import { createDriver } from "./driver.js"` and `runner.js` no longer mentions Playwright.

### 2.3 Deliberate minimality decisions

- **The envelope field stays named `url`.** Renaming it to `location` would ripple into
  the viewer, `clip`, `report.js`'s `stepLine`, and the movement module for no functional
  gain. It carries a URL for web/api and a screen/route identifier for mobile; the
  contract note documents the widened meaning. The `Driver.location()` *method* uses the
  clearer name; the wire field does not move.
- **No driver-discovery, no registry.** `createDriver` is a three-arm switch on
  `resolvedCase.env.driver`. That is the entire dispatch.

### 2.4 Driver-aware preflight: detect-and-install on demand

The suite already declares its driver (`app.driver`), so preflight can be driver-aware and
self-healing — the same pattern `ensureBrowser` already implements for chromium
(`preflight.js`: check `chromium.executablePath()`; if missing, interactive sessions get a
one-time `Install Chromium now? [Y/n]` running `npx playwright install chromium`,
non-interactive/CI get a `DummyConfigError` with the exact command). Generalize to
`preflightFor(driver)`:

- **web** → today's chromium check, unchanged.
- **mobile** → is the Appium client importable (it is an `optionalDependency`, §5), the
  platform driver installed, a device/emulator reachable? Each missing piece offers its fix
  (`npm i webdriverio`, `appium driver install xcuitest`, "boot a simulator") interactively,
  or a `DummyConfigError` naming it in CI — never a raw `MODULE_NOT_FOUND` or
  appium-connect stack trace.
- **api** → nothing to install; a no-op.

This is the answer to the cross-driver dependency tension: the *same* on-demand flow already
used for Playwright's chromium, extended to whatever the resolved driver needs. Two call-site
consequences: (1) `cli.js` runs `ensureBrowser` unconditionally *before* `discoverCases`
today (`cli.js:301`), so an api/mobile-only run would needlessly prompt for chromium — the
preflight call must move *after* discovery and key off the resolved drivers; (2) `playtest
new` should gain a `--driver` flag and per-driver templates so a mobile/api user's first
case isn't web-shaped by default. Both are sequenced in the plan (P0/P1).

---

## 3. New YAML surface (the whole config change)

### `app.driver: web | mobile | api`

- Default `web`. **Absent ⇒ web**, so every existing defaults/case file is unchanged in
  meaning. Inheritable like the rest of the `app:` block (merges per-key down the chain,
  `config.js` `mergeDoc`).
- Lands on `ResolvedCase.env.driver`. `createDriver` switches on it.
- Validated by enum in both `case.schema.json` and `defaults.schema.json`.

### Per-driver `app.*` sub-keys (all optional, validated only for their driver)

The `app:` block today is `{ base_url, compose, init, storage_state }`. Each driver reads
the subset it needs; a key set for the wrong driver is a config error naming the file
(same strictness `additionalProperties: false` gives today).

| Driver | Reads from `app:` | Meaning |
|---|---|---|
| `web` (default) | `base_url`, `compose`, `init`, `storage_state` | unchanged — today's behavior exactly |
| `mobile` | `app` (path to `.apk`/`.ipa`/`.app`), `platform` (`ios`\|`android`), `device`, `appium_url`, `init` | app binary + target device; managed = boot emulator & install, external = connected device / running Appium |
| `api` | `base_url`, `openapi` (spec path), `auth` (init-provided), `init`, `compose` | base URL + optional OpenAPI spec that becomes the "elements" the actor sees (§5) |

`base_url` is required for `web` and `api`; for `mobile` it is optional (a device/Appium
URL when remote). The "required somewhere in the chain" check in `config.js` becomes
driver-aware.

### Additive success-criteria vocabulary

`success` entries stay one-key objects. Web's four kinds are unchanged. New kinds are
**additive** and each declares the drivers it is valid for; a kind used under the wrong
driver is a `DummyConfigError` naming the file — the exact cross-field pattern `config.js`
already runs for discovery/journey and `vision` (`config.js:198-217`).

| Kind | Valid drivers | Meaning |
|---|---|---|
| `assert` | web, mobile, api | natural-language claim, grader-checked against the final snapshot/response text. Transport-neutral already. |
| `api_called` | web, api | `METHOD /path/glob` in captured network. Native on api and web; mobile has no network capture in v1, so it is a config error there (deferred, §10.1). |
| `url_matches` | web, api | glob on the final URL / last request path. |
| `element_exists` | web | CSS selector on the final page (today's contract, unchanged). |
| `screen_shows` *(new)* | mobile | accessibility-id / predicate that must resolve on the final screen. The mobile analog of `element_exists`. |
| `response_status` *(new)* | api | status of the last (or any) response, e.g. `"201"` or `"2xx"`. |
| `response_matches` *(new)* | api | JSON-path/value over a response body (deterministic, no model). Natural-language response claims use `assert` instead, keeping the gate's single model-judgment escape hatch (§7). |

`perf` keys are likewise driver-scoped: `lcp_ms` / `input_to_paint_ms` / `console_errors`
are web-only and a config error elsewhere; api gains `latency_ms` later (additive); mobile
perf (cold-start, jank) is deferred. See §7.

### Example: a mobile case

```yaml
# tests/mobile/playtest.yaml
app:
  driver: mobile
  platform: ios
  app: ./build/MyApp.app
  init: ./seed/reset.mjs
```
```yaml
# tests/mobile/stories/add-todo.yaml      (story prose is identical in spirit to web)
tags: [smoke]
story: |
  You keep forgetting to buy milk. Add a todo called "buy milk" and confirm it
  shows up in your list.
success:
  - screen_shows: "~todo-cell-buy-milk"
  - api_called: "POST /api/todos"        # mobile: needs network capture; a config error without it (§10.1)
  - assert: "the list shows a todo called buy milk"
```

The story is unchanged from how you'd write it for web. The only structured differences
are the `app.driver`/`platform`/`app` keys (in the *defaults* file, authored once) and the
`screen_shows` criterion in place of `element_exists`.

---

## 4. Action vocabulary & actor overlays

`actor.js` already builds the system prompt from stacked overlays
(`actor.js:147` — system + persona + discovery + vision + story). A driver contributes
**one more overlay**, exactly like discovery and vision do.

- **`actor-system.md` becomes transport-neutral**: the role-play frame ("you are this
  user"), the one-thought/one-action/one-expectation turn shape, the falsifiable-expectation
  discipline, and the `done`/`give_up` honesty rules. None of that is web-specific.
- **`actor-web.md` / `actor-mobile.md` / `actor-api.md`** carry the "What you see" snapshot
  format and "What you do" action vocabulary for that transport.
  **Byte-identical constraint (load-bearing).** Today `actor-system.md` is one block in the
  order [role frame][What you see][What you do][done & give_up], assembled *before* the
  Persona block, with the discovery/vision overlays slotted *after* Persona (`actor.js:147`).
  A naïve split that moves only "What you see/do" into an overlay at the discovery/vision
  slot would leave "done & give_up" before Persona and push see/do after it — **reordering
  the web prompt and changing its bytes.** That fails the byte-identical test
  (`test/grader-discovery.test.js` asserts `new Actor(...).system` equals the pre-change
  assembly) and would force a `prompts_version` bump that severs comparability with every
  existing web run. So the web overlay must reproduce the *entire* current `actor-system.md`
  body (see + do + done/give_up) at the *same* position (right after the role frame, before
  Persona) — it is **not** slotted where discovery/vision go; only the mobile/api overlays
  use the after-Persona slot. A golden-bytes assertion on the assembled web prompt guards
  this in P0 (the self-test's mock-llm also pins the story-extraction; see §8).

> **Superseded by CONTRACTS.md §16 (schema_version 3).** `step.schema.json` moved from the
> additive `oneOf` union described below to a **flat action object** + a per-driver ship/
> validate split in `drivers/overlay.js` (`toolParamsFor` = dumb shipped schema, `stepSchemaFor`
> = strict validator), because the OpenAI-compat endpoint does not constrain decoding so the
> nested `oneOf` only confused weak actor models. Web also gained `back` (`page.goBack()`). The
> verb/field tables below remain accurate as rationale; the union *mechanism* does not.

`step.schema.json` becomes a **versioned, additive union**. Today's web action variants
stay exactly as-is; mobile and api add variants:

```
mobile: tap{ref} · type{ref,text,submit?} · swipe{direction,ref?} · scroll{direction,ref?}
        · back · wait · done · give_up
api:    request{method, path, body?, headers?} · wait · done · give_up
```

`done`/`give_up`/`wait` are shared. The actor is only ever *shown* its driver's verb
subset (`Driver.overlay.actions` builds the forced-tool schema), so it never emits a
foreign verb; validation still runs against the union, so the grader, `diffTracks`, and the
viewer read every run uniformly. This is precisely the design's promise — *"new verbs are
new command types; old tooling skips what it doesn't know"* (playtest-design.md).

`describeAction` (`actor.js:94`) and the viewer's caption derivation gain cases for the new
verbs — a one-line `switch` arm each, additive.

---

## 5. The three drivers

### `web` — `browser.js`, relocated

Behavior-preserving move of today's `Session` behind the interface. `location()` returns
`page.url()`; `effectToken()` is today's `runner.js` fingerprint; `settle` is `settle-v1`
unchanged. **Acceptance: the full suite passes untouched** (P0 gate, see the plan).

### `mobile` — Appium (W3C WebDriver)

Appium is the cross-platform standard (iOS XCUITest, Android UiAutomator2) and maps 1:1
onto the existing model, which is exactly why the seam stays small:

| Web (`Session`) | Mobile (Appium) |
|---|---|
| DOM a11y walk → `[eN] role "name"` text | page-source (AX tree) → the **same** text format ("ax-tree-v1") |
| `data-testid` / `role=name` durable locator | accessibility-id / predicate → `resolution.locator` (still opaque) |
| element bbox → ghost cursor | element `.rect` → `{x,y,w,h}` → ghost cursor works unchanged |
| `click/type/select/scroll/navigate/back` | `tap/type/swipe/scroll/back` |
| screenshot per step | screen capture per step → film strip works unchanged |
| HAR from CDP | **gap** — native apps expose no HAR (proxy or degrade; §10) |
| `prepareEnv`: compose + HTTP probe | boot emulator + install app (managed) / connected device (external); probe = Appium session creates |
| `preflight`: install chromium | Appium reachable + driver installed + a device available |

Because the snapshot uses the same `[eN]` line format and the same locator discipline, the
actor barely changes and **record → act → heal works identically**: acts replay from the
accessibility-id locator just as web acts replay from a test-id.

**New dependency (resolved — see §10.5):** the Appium/WebDriver client (e.g. `webdriverio`)
is declared an **`optionalDependency`**, so `npm i @jeremyvun/playtest` never forces it on
web/api users, and it is lazy-imported inside the mobile driver. Its absence is a friendly,
self-healing case via the driver-aware preflight (§2.4) — a `DummyConfigError` with an
install command, never a raw `MODULE_NOT_FOUND` — exactly the shape of the existing chromium
flow. (Still a new manifest dependency — flagged per the CONTRACTS preamble.)

### `api` — fetch (validates the abstraction)

The API case maps onto the snapshot/step model without strain, which is the strongest
evidence the seam is right:

- **Snapshot** = the API surface as text: base URL + auth state + (when `app.openapi` is
  given) the available operations rendered as the interactable elements —
  `[e1] POST /api/todos — create a todo` — **plus the actual JSON body of the last
  response**, pretty-printed and size-capped. The actor reads real response data, not a
  lossy digest. **Endpoints are the "elements"; a request is the "click"; the JSON response
  is what you "see" next.**
- **No spec ⇒ degraded/exploratory, not parity.** With no `app.openapi` there are no `[e1]`
  operations on turn one, so the actor must infer paths from the story prose — which the
  actor's "never invent a ref" discipline otherwise forbids. No-spec baselines are
  path-guesses, not regression-grade; `openapi` is therefore recommended for journey cases
  (and may be made effectively required). No-spec is for one-off probing only.
- **What's actually tested is the *journey*** — a multi-step stateful sequence
  (create → retrieve → update → delete), an auth handshake, an idempotency or
  error-handling path — not a single request/response. The gate then asserts on the
  captured responses.
- **Action** = `request{method, path, body?, headers?}` (one verb) + `done`/`give_up`.
- **Network + response capture** = every action *is* a request, so `network.requests` (the
  six stable fields) is fully native and `api_called`/`response_status` are first-class. The
  full request + response **bodies** are written to `har.json` (§7), never into the
  trajectory — so `response_matches` and body-level `assert` have a data source without
  jittering committed baselines.
- **No screenshots/bbox** → the viewer drops the film strip and cursor and leans on the
  network panel + a11y-text panel it already has (§8).
- **`settle`** = response received (+ optional inter-request quiet). **`effectToken`** = a
  hash of the last response. **`location`** = base URL / last request path.

---

## 6. Manifest, pins, comparability, settle

- **`manifest.pins` gains `driver`** (and, for mobile, `platform`/`device`). This is **two
  edits, not one**: add `driver` to the per-run pins in `runner.js` `buildManifest`
  (`runner.js:506`) **and** add `"driver"` to the `PIN_KEYS` list in `src/shared/movement.js`
  — `comparablePins` iterates that *fixed* list, so a pin not in it is never read and adding
  it only to the manifest does nothing. With both edits, two runs that both carry `driver`
  but differ (web vs mobile) are correctly non-comparable. The "missing pin = wildcard" rule
  still applies to *legacy* web manifests (no `driver` key): they stay wildcard-comparable to
  new runs unless `driver` is backfilled to `"web"` on read. `PIN_KEYS` is frozen by the
  self-test, so this is a deliberate, reviewed pin-set change — not a free side effect.
- **Settle is driver-owned and pinned per driver.** The design doc calls settle "doubly
  load-bearing" — it closes the perf window *and* gates act-mode progression. Web keeps
  `settle-v1` (DOM-quiet + net-quiet). Mobile pins `settle-mobile-v1` (UI-idle / animation
  + network quiet via proxy when present). API pins `settle-api-v1` (response received).
  Each rides in `manifest.pins.settle` as today; changing one requires a `refresh` of that
  driver's baselines only.
- **`manifest.env`** keeps `{ base_url, managed }` and adds `driver`. No reshaping.

---

## 7. Gate (driver-aware dispatch)

`gate.js` stays the "evaluate every criterion, then every perf threshold, never throw"
shape. Changes:

- `checkSuccess` dispatches the new kinds (`screen_shows` → `driver.finalPageCheck` with an
  accessibility query; `response_status`/`response_matches` → read the last/any
  `network.requests` entry + response capture). `element_exists` stays
  `driver.finalPageCheck(cssSelector)` — same method, web's query language.
- `api_called` is **unchanged** — it already reads `trajectory.flatMap(e => e.network?.requests)`,
  which every driver populates (mobile only when capture is on).
- Perf keys are driver-scoped (validated at config time, §3): a web-only key on a non-web
  case is a config error, so the gate never sees an impossible threshold. API `latency_ms`
  (additive, later) reads per-request timing.

`ctx.session` in the gate ctx becomes `ctx.driver`; `ctx.finalUrl` is fed from
`driver.location()`. The `assert` path needs two small changes (it is **not** unchanged):
(1) the `checkAssertion` system prompt (`grader.js:122`) is generalized from "a web page" to
"the final state under test" — the snapshot text for web/mobile, the response body for api;
(2) for api/mobile it also receives the captured response/screen text as evidence, not only
the a11y snapshot + finalUrl.

**Response/request bodies live in `har.json`, the deep-debug artifact — never copied into a
committed baseline.** Today `har.json` entries carry `request:{method,url}` and
`response:{status,bodySize,mimeType}` but no bodies or headers. The fix (resolving the API
gate's data-source gap): the driver also records the request `postData`, the response body
(text/JSON only, size-capped — binary recorded by size alone), and request/response headers
into each `har.json` entry. Because `har.json` is per-run and never committed, this does
**not** violate the baseline-stability invariant that keeps bodies out of the embedded
`network.requests`. The gate's `response_status`/`response_matches` and body-`assert` read
from `har.json` — its settled status also fixes the `status:0`-at-settle freeze the embedded
list has. This applies to all drivers: for web it additionally enriches the viewer's network
panel.

---

## 8. Viewer impact: near-zero (additive captions only)

The viewer needed no structural change — only the additive verb-caption/icon cases that §4
already anticipated (`tap`/`swipe`/`back`/`request` arms in `ACTION_ICONS` and `describe`,
~8 lines in `src/viewer/app.js`, each falling back to an existing glyph). This holds because
the viewer is fed entirely by the manifest+trajectory+artifacts contract and already
"degrades gracefully when an artifact is missing" (CONTRACTS.md §13):

- **Film strip / ghost cursor** — needs `steps/NNN.png` + `resolution.bbox`. Mobile fills
  both (screen capture + element rect) → works. API fills neither → the strip and cursor
  simply don't render, like an artifact-less run today.
- **"What the agent saw" a11y toggle** — needs `steps/NNN.a11y.txt`. Every driver writes
  it (DOM text / AX-tree text / endpoint-and-response text) → works.
- **Network waterfall** — `network.requests` / har. API populates it natively; mobile when
  capture is on; degrades to the embedded compact list otherwise (already the fallback).
- **Telemetry panel** — web vitals. Absent on mobile/api → the panel renders empty/omitted,
  exactly as it does for acted runs that lack some fields today.
- **Heal/act diff, captions, gate panel, grade panel** — all read transport-neutral
  trajectory/grade fields → work as-is.

Beyond the additive verb captions above, the remaining viewer touches are **optional
cosmetics, deferred**: label "screen" vs "page" by `manifest.pins.driver`, and cleanly hide
the empty vitals panel. Both are post-milestone polish; nothing in mobile or API requires a
*structural* viewer change to function. The viewer self-test (`viewer-smoke.test.js`) stays
green throughout.

---

## 9. `docs/CONTRACTS.md` addition (FOLDED IN — now live as CONTRACTS §16)

This section has been folded into `docs/CONTRACTS.md` as **§16 "Drivers (transport seam)"**,
which is the live contract; the draft below is retained for design-history only and may lag
§16. Read §16 for the authoritative interface.

> ## N. Drivers (transport seam)
>
> `createDriver(resolvedCase, env, { runDir, headed }) -> Driver`, switching on
> `resolvedCase.env.driver` (`web` default | `mobile` | `api`). The web driver is
> `browser.js`'s `Session` (unchanged surface). Every driver implements: `start()`,
> `captureSnapshot(stepNum)`, `execute(action)`, `executeLocator(actedStep)`,
> `finalPageCheck(query)`, `location()`, `effectToken()`, `consoleErrors()`, `close()`,
> and exposes `id`, `settle`, `overlay`. `ExecResult`/`Snapshot` shapes per §1/§4 (the
> envelope field stays named `url`; it holds a screen/route id under the mobile driver).
> `resolution.locator` is an opaque durable handle (Playwright selector / Appium
> accessibility-id / `METHOD /path`); `diffTracks` and act mode treat it as a string.
> `runner.js` depends only on this interface — it never imports a concrete driver and never
> reaches into a transport client. `manifest.pins` carries `driver` (+ `platform`/`device`
> on mobile) and the driver's `settle` descriptor; both key comparability (missing = wildcard).
> Per-driver: prompt overlay (`actor-<id>.md`), action sub-schemas (additive union in
> `step.schema.json`), env prep (`prepareEnv` arm), preflight, and the `app.*` sub-keys /
> success kinds / perf keys each driver validates (config.js, driver-aware cross-field rules).

The `step.schema.json`, `case.schema.json`, and `defaults.schema.json` version bumps and
the new `app.driver` + success/perf keys are recorded in CONTRACTS §1, §2, §6.

---

## 10. Hard parts / open decisions

1. **Mobile network capture — RESOLVED (option b first).** Native apps expose no HAR. Mobile
   v1 ships *without* network capture: using `api_called` on a mobile case is a **config-time
   `DummyConfigError`** ("network capture not configured for the mobile driver"), not a
   silent gate FAIL against an empty request list (the trap the §3 example would otherwise
   spring). Mobile journeys gate on `screen_shows` + `assert`. A proxy (mitmproxy / Appium
   proxy) that fills `network.requests` is a later sub-milestone (P1c) that lifts the config
   error. The §3 example's `api_called` line is annotated accordingly.
2. **Mobile perf.** No web vitals. Cold-start / frame-jank / ANR signals exist but are
   platform-specific; deferred. Until then, perf keys are a config error on mobile cases
   (loud, consistent), so no run silently lacks a threshold it declared.
3. **Settle fidelity on mobile.** "UI idle" is fuzzier than DOM-quiet (animations,
   spinners). `settle-mobile-v1` will need tuning against real apps; it is pinned, so
   tuning is a deliberate `refresh`, not silent drift.
4. **Act-mode determinism on mobile** depends on apps exposing accessibility ids — the same
   "semantic markup" dependency the README already states for web div-soup. Apps without
   them degrade to coordinate replay (brittle); we report it as an accessibility finding,
   exactly as web does, rather than papering over it.
5. **New runtime dependency — RESOLVED.** The `webdriverio`/Appium client is declared an
   `optionalDependency` (web/api `npm i` never pulls it) and lazy-imported inside the mobile
   driver; the driver-aware preflight (§2.4) turns a missing client into a friendly install
   prompt / `DummyConfigError`, never a raw `MODULE_NOT_FOUND`. (Still a new manifest
   dependency — flagged per the CONTRACTS preamble.)
6. **`storage_state` analog.** Web pre-auth is a Playwright storage-state file. Mobile
   pre-auth (signed-in app state) and API auth (tokens) are driver-specific; both route
   through the existing `init` script mechanism (`BASE_URL`/`RUN_ID` env) rather than a new
   key, keeping the config surface flat.
