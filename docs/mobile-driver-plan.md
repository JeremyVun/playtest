# Mobile + API drivers — phased implementation plan

Status: LARGELY LANDED in the working tree (updated 2026-06-14). P0 (the Driver seam) and
the offline parts of P1/P2 are coded and green; what remains is real-device/Appium
execution, mobile network capture (P1c), and mobile perf. Per-item status is called out at
the head of each phase below. The live contract is `docs/CONTRACTS.md` §16; the design
rationale is `docs/driver-interface.md` (Status: IMPLEMENTED). Milestone framing: `VERSION_2.md`.

What's in-tree now: `src/harness/driver.js` (`createDriver`) + `drivers/{web,mobile,api}.js`
+ `drivers/{mobile-snapshot,overlay,har}.js`; the per-driver actor overlays
(`prompts/actor-{mobile,api}.md`, web kept in `actor-system.md`); the additive
`step.schema.json` action union; driver-aware `config.js` validation; `gate.js` driver
dispatch (`screen_shows`/`response_status`/`response_matches`); `preflight.js`
(`preflightFor`); `new --driver` templates; and `driver` in `manifest.pins` + `PIN_KEYS`.

What remains (the genuinely hard parts, deferred as designed — driver-interface §10):
real-device/Appium validation (the mobile driver is exercised against a fake Appium client
today), mobile network capture via proxy (P1c), and mobile perf signals.

Repo: `@jeremyvun/playtest`. Plain JS ESM, Node >= 20, no TypeScript, no build step.
`npm test` is `node --test test/*.test.js` (current suite includes `config-discovery`,
`driver`, `grader-discovery`, `harness`, `install-skill`, `llm-coercion`, `movement`,
`runner-api`, `runner-discovery`, `runner-mobile`, `view-server`, `viewer-smoke`,
`vision-discovery`). Mobile transport is **Appium** (decided 2026-06-13).

The sequencing principle: **P0 makes the seam without adding a transport, and the web
suite must stay byte-for-byte green at the end of it.** P1 (mobile) and P2 (API) then add
drivers behind a proven interface. Each phase is independently reviewable and shippable.

---

## Resolutions & corrections (2026-06-13)

Decisions from review that amend the phase steps below; the body is otherwise as originally
planned. (Mirrors `docs/driver-interface.md`'s same-dated edits.)

- **R1 (P0, step 3): rename `session.goto()` → `driver.start()`.** The interface defines
  `start()` (driver-interface §2.1); the original P0 change-list named the two `.page` seals
  but omitted the `goto`→`start()` call-site rename. Add it.
- **R2 (P0, step 5 + P1): driver-aware preflight, relocated.** `cli.js` calls `ensureBrowser`
  *before* `discoverCases` (`cli.js:301`, `:467`), so a mobile/api run would prompt for an
  unused Chromium. Move the preflight call *after* discovery and make it `preflightFor(driver)`
  (web → chromium, mobile → Appium client + driver + device, api → no-op), each missing piece
  installing/prompting on demand exactly like the chromium flow (driver-interface §2.4). Also
  give `playtest new` a `--driver` flag + per-driver templates (P1) so a mobile/api first case
  isn't web-shaped.
- **R3 (P0, step 6): add `"driver"` to `PIN_KEYS`, not just the manifest.** `comparablePins`
  iterates the fixed `PIN_KEYS` list in `src/shared/movement.js`; adding `driver` only to
  `manifest.pins` does nothing. Add it to both (`PIN_KEYS` is frozen by the self-test — a
  deliberate pin-set change) + a test that a web and a mobile manifest of the same case id are
  non-comparable. Legacy web manifests (no `driver` pin) stay wildcard-comparable unless
  `driver` is backfilled to `"web"` on read.
- **R4 (P0, step 8): golden-bytes assertion on the assembled web actor prompt.** The
  overlay split must keep the web system prompt byte-identical (the web overlay reproduces
  today's whole `actor-system.md` body at the same pre-Persona position — NOT at the
  discovery/vision slot — see driver-interface §4). `test/grader-discovery.test.js` already
  asserts `new Actor(...).system`; keep it green, which keeps `prompts_version` at `prompts-v1`.
- **R5 (P1, step 3): Appium client = `optionalDependency` + preflight install.** Declare
  `webdriverio` (or chosen client) in `optionalDependencies` so web/api `npm i` never pulls
  it; the mobile preflight arm (R2) detects a missing client and emits a `DummyConfigError`
  with `npm i webdriverio`, never a raw `MODULE_NOT_FOUND`.
- **R6 (P1): ship a provisional `settle-mobile-v1` definition.** Settle is "doubly
  load-bearing" (closes the perf window + gates act progression) and gates `screen_shows`
  reliability, so it cannot be left as prose. Pin an initial concrete heuristic — e.g.
  *AX-tree stable for 400ms AND no running UI animation AND (network-quiet 500ms when a proxy
  is present), capped at ~10s* — recorded in `manifest.pins.settle`. Tuning it later is a
  deliberate `refresh`, exactly like `settle-v1`.
- **R7 (P1, step 2): driver-aware config validation is NEW code (extends, not reuses).**
  `config.js`'s `SUCCESS_KINDS` is a flat list and the existing cross-field block keys on
  `mode`/`vision`, not driver. Add a `{kind → allowed drivers}` table consulted after
  `env.driver` resolves, for BOTH success kinds and perf keys: `element_exists`/`url_matches`
  ⇒ not mobile/api; `screen_shows` ⇒ mobile; `response_*` ⇒ api; `lcp_ms`/`input_to_paint_ms`/
  `console_errors` ⇒ web only; `api_called` on a capture-less mobile case ⇒ config error
  (R-net). Each emits the existing file-naming `DummyConfigError` — never a silent global-add
  that fails mysteriously at the gate. Also widen `resolveCase`'s fixed `env` literal to carry
  `driver`/`app`-binary/`platform`/`device`, add those to `loadYaml`'s relative-path list, and
  make the required-`base_url` check driver-aware — the "one defaulted key" is really a small
  cluster of `config.js`/schema edits (all in P1 step 1–2).
- **R8 (P2): response capture resolved; OpenAPI needs no dep; the real work is the renderer.**
  Request + response **bodies** are captured into `har.json` (size-capped, text/JSON; never
  the committed trajectory), and the gate reads `response_status`/`response_matches`/body-
  `assert` from there (driver-interface §7) — this is also a small *web* enrichment. The api
  snapshot is the OpenAPI operations + the **actual JSON response**; OpenAPI ingestion uses the
  existing `yaml`/`JSON.parse` (no new dependency). `response_matches` is JSON-path only;
  natural-language response claims go through `assert`. The genuinely non-trivial P2 item is
  the jitter-safe JSON-digest snapshot renderer, not the fetch transport — re-scope P2b
  accordingly. No-spec api runs are exploratory only (not baseline-grade).

---

## P0 — Extract the `Driver` interface (web stays byte-identical)

**Status: LANDED.** The seam, the web driver relocation, the runner/gate/preflight/pins
edits, and `test/driver.test.js` are all in-tree; the web suite stays green and
`prompts_version` is still `prompts-v1`. (CONTRACTS §16.)

Goal: introduce the seam with **no behavior change**. Web is the only driver; the full
suite passes untouched. This phase is pure refactor + net-neutral line count.

### Changes
1. **`src/harness/driver.js` (new)** — `export function createDriver(resolvedCase, env, opts)`:
   a switch on `resolvedCase.env.driver`. P0 has one arm (`web`) returning the web driver;
   the `default`/unknown arm throws `DummyConfigError`. (`mobile`/`api` arms added in P1/P2.)
2. **`src/harness/drivers/web.js`** — move `browser.js`'s `Session` here behind the
   interface. Add `location()` (= `page.url()`), `effectToken()` (= the fingerprint moved
   from `runner.js:469-479`), and the readonly `id`/`settle`/`overlay` descriptors. Keep
   `snapshot-injected.js` as the web driver's snapshot source. `launch` → the driver's
   constructor/factory. *No logic change to capture/execute/settle/HAR.*
3. **`src/harness/runner.js`** — replace `import { Session } from "./browser.js"` with
   `createDriver`; delete the local `effectToken` (now `driver.effectToken()`); replace
   `session.page.url()` (`:223`) with `driver.location()`; rename the `session` local to
   `driver` and pass `driver` (not `session`) into the gate ctx. Nothing else moves.
4. **`src/harness/gate.js`** — `ctx.session` → `ctx.driver` (only `finalPageCheck` is
   called on it; `element_exists` semantics unchanged).
5. **`src/harness/preflight.js`** — extract the chromium logic behind a
   `preflightFor(driver)` shape; P0 keeps web's behavior exactly (one arm).
6. **`manifest.pins.driver`** — set to `"web"` in `buildManifest` (`runner.js:506`).
   `movement.js` treats a pin missing on the *prior* side as a wildcard, so pre-P0
   manifests stay comparable.
7. Keep `browser.js` as a one-line re-export of the web driver for one release (anything
   importing `Session` keeps working), or update the two importers and delete it — reviewer's
   call; the self-test names the public surface, not the file path.

### Tests & acceptance
- The **entire existing suite passes with zero edits** to test files. This is the gate:
  if a web test needs changing, the refactor changed behavior — back it out.
- Add `test/driver.test.js`: `createDriver` returns the web driver for `driver: web` and
  for an absent key; throws `DummyConfigError` for an unknown driver.
- Record a web case, then `act` it: identical envelopes/manifest shape to pre-P0 (the
  `runner-discovery` / `harness` tests already cover record→act→heal).
- `manifest.pins.driver === "web"`; a pre-P0 baseline still `act`s and stays comparable.

### Risk
Low. The only true relocation is `effectToken` and `page.url()`; both are mechanical. The
`url`→`location` rename is method-only — the envelope field name does **not** change (design
§2.3), so no consumer moves.

---

## P1 — Mobile driver (Appium)

**Status: MOSTLY LANDED (offline).** Config & schema, the `mobile` driver +
`mobile-snapshot.js`, the `createDriver` arm, the actor overlay split, the `step.schema.json`
union, the mobile mock-llm rules, `preflightFor("mobile")`, the manifest pins, and
`test/runner-mobile.test.js` are in-tree and green — exercised against a **fake Appium
client** (`__setMobileClientFactory`). **Remaining:** real-device/emulator validation, mobile
network capture (P1c, below), and mobile perf (driver-interface §10.1–10.2). The `webdriverio`
client is an `optionalDependency`, absent by default.

Goal: `app.driver: mobile` runs a native iOS/Android app through the same record → act →
heal loop, viewer included. Depends only on the P0 interface.

### Config & schema (additive)
1. **`case.schema.json` + `defaults.schema.json`** — add `app.driver` (enum
   `web|mobile|api`, default `web`) and the mobile `app.*` keys (`app`, `platform`,
   `device`, `appium_url`). Add the `screen_shows` success kind. Bump the schema notes.
2. **`config.js`** — driver-aware resolution: `base_url` required only for `web`/`api`;
   `app` (binary) required for `mobile`; per-driver success-kind validation
   (`screen_shows` ⇒ mobile only, `element_exists`/`url_matches` ⇒ not mobile) as a
   `DummyConfigError` naming the file — mirror the existing discovery/vision cross-field
   block (`config.js:198-217`). Web-only perf keys are a config error on mobile cases.
   `ResolvedCase.env.driver` carried through.

### Driver
3. **`src/harness/drivers/mobile.js`** — implements the full `Driver` interface over an
   Appium/WebDriver client (`webdriverio`, **new mobile-only dependency, lazy-imported** —
   flagged per CONTRACTS preamble):
   - `captureSnapshot`: walk Appium page-source (AX tree) → the same `[eN] role "name"`
     text format (`ax-tree-v1`); screen capture → `steps/NNN.png`; element rects available
     for bbox. No mhtml.
   - `execute`/`executeLocator`: resolve by accessibility-id/predicate (durable locator);
     `tap/type/swipe/scroll/back`; bbox from element `.rect`.
   - `effectToken`: hash of (current activity/screen + visible AX-tree digest).
   - `location`: current screen/route id. `consoleErrors`: 0 (or logcat errors, later).
   - `settle`: `settle-mobile-v1` (UI idle + network quiet when the proxy is on).
   - `finalPageCheck(query)`: accessibility-id/predicate resolves on the final screen.
4. **`src/harness/drivers/mobile-snapshot.js`** — the AX-tree → text walker (mobile's
   analog of `snapshot-injected.js`), zero-dependency, never throws.
5. **`createDriver`** — add the `mobile` arm.

### Env & preflight
6. **`env.js`** — `prepareEnv` mobile arm: managed = boot emulator/simulator + install the
   app binary; external = connected device / running Appium session; probe = Appium session
   creates and the app launches. `init` runs with `BASE_URL`/`RUN_ID` as today (the mobile
   pre-auth path).
7. **`preflight.js`** — mobile arm: Appium server reachable, the platform driver installed,
   a device/emulator available; one-time-setup guidance on failure (analogous to the
   chromium install prompt).

### Actor prompt
8. **Split `actor-system.md`** → transport-neutral core + `actor-web.md` (today's
   "What you see / What you do", moved verbatim so web prompts stay byte-identical) +
   **`actor-mobile.md`** (AX-tree format + `tap/type/swipe/scroll/back`). `actor.js` stacks
   the driver overlay (`Driver.overlay.prompt`) like it already stacks discovery/vision.
9. **`step.schema.json`** — add the mobile action variants to the union (additive; bump the
   description). `describeAction` + the viewer caption switch gain arms for the new verbs.
10. **mock-llm** — add a mobile rule-set (drive the mobile self-test app's AX names) so the
    offline e2e covers mobile; the web rules are untouched (web prompt is byte-identical).

### Manifest/pins
11. `manifest.pins` carries `driver: "mobile"` + `platform`/`device`; `settle` =
    `settle-mobile-v1`. Comparability isolates mobile runs from web automatically.

### Tests & acceptance
- A tiny **mobile self-test fixture app** (smallest possible RN/native todo, or a
  WebView-in-shell if a real native build is too heavy for CI) + a `tests/mobile/` suite.
- `test/runner-mobile.test.js` (offline, mock-llm): record → act → heal produces envelopes
  with `resolution.locator` (accessibility-id), bbox, screenshots; `screen_shows` gate
  passes/fails correctly; manifest pins carry `driver: mobile`.
- **Viewer**: `viewer-smoke.test.js` gains a mobile run case — film strip + ghost cursor +
  a11y toggle + heal diff render with **no viewer code change** (proves §8). Vitals panel
  is empty/omitted without error.
- **Web regression gate**: every web test still green; a pre-P1 web baseline still `act`s.
- Decision checkpoint (design §10.1): is `api_called` in mobile v1? If no, it is a config
  error on mobile cases with a "network capture not configured" message; if yes, P1
  includes the proxy capture sub-task.

### Risk
Medium. Real risks are environmental (Appium/device setup in CI), settle fidelity on
animated UIs, and network capture. None touch the web path. CI may run mobile against an
emulator on a self-hosted runner or gate it behind a label until the runner exists.

---

## P2 — REST API driver (validates the abstraction)

**Status: LANDED (offline).** The `api` driver (`drivers/api.js` over `fetch`), the
`createDriver` arm, the `actor-api.md` overlay + `request` verb, the `response_status`/
`response_matches` gate kinds, request/response body capture into `har.json` (`drivers/har.js`),
the api mock-llm rules, and `test/runner-api.test.js` are in-tree and green against the zero-dep
`src/todo-app` fixture. (The `latency_ms` perf key remains a future additive.)

Goal: `app.driver: api` exercises a JSON/REST API through the same loop, where endpoints
are the "elements" and a request is the "action." This phase should be small if P0/P1 got
the seam right — that smallness is the proof.

### Config & schema (additive)
1. **schemas** — `app.openapi` (spec path), the `request` action variant, and the
   `response_status` / `response_matches` success kinds; `latency_ms` perf key.
2. **`config.js`** — `api` validation: `base_url` required; `response_*` ⇒ api only;
   `element_exists`/`screen_shows` ⇒ not api.

### Driver
3. **`src/harness/drivers/api.js`** — fetch-based:
   - `captureSnapshot`: render base URL + auth state + last-response digest + (if
     `app.openapi`) the operations as `[eN] METHOD /path — summary` lines → `steps/NNN.a11y.txt`.
     `screenshot: null`.
   - `execute`/`executeLocator`: perform the `request`; `resolution.locator = "METHOD /path"`;
     `network.requests` filled natively; capture the response body for the gate.
   - `effectToken`: hash of the last response. `location`: base URL / last path.
     `consoleErrors`: 0. `settle`: `settle-api-v1` (response received).
   - `finalPageCheck`: N/A → false + note.
4. **`createDriver`** — add the `api` arm. **No env/preflight beyond base-url + probe** (api
   reuses the web-shaped `prepareEnv` probe arm; `compose` still boots a backend).
5. **`actor-api.md`** overlay + `request` verb in the union + `describeAction`/caption arms.
6. **mock-llm** api rule-set; `test/runner-api.test.js`.

### Tests & acceptance
- `api_called`, `response_status`, `response_matches`, `assert` all gate correctly against
  a zero-dep fixture API (the existing `src/todo-app` already exposes `/api/todos` — reuse it).
- **Viewer**: an API run renders the network panel + a11y-text panel + captions + gate/grade
  + heal diff with **no viewer code change**; film strip/cursor simply absent.
- Web and mobile suites stay green.

### Risk
Low–medium. The open question is response-body assertion ergonomics (`response_matches`:
JSON-path vs. natural-language-via-grader). Recommend starting with the grader `assert`
path (already neutral) + a simple status/JSON-path `response_*`, and expanding only if
authors ask.

---

## Cross-cutting: what must never regress

- **The web path is the control.** After every phase, `npm test` is green with **zero**
  edits to pre-existing web test assertions, and a web baseline recorded before this work
  still `act`s. Any web-test edit is a signal the seam leaked behavior — stop and fix the
  seam, not the test.
- **Viewer code is frozen** through P0–P2 (only additive caption `switch` arms for new
  verbs, which `viewer-smoke` covers). Cosmetic polish (driver-aware "screen"/"page" label,
  hiding the empty vitals panel) is a separate, post-milestone change.
- **CONTRACTS.md is updated in the same commit as the code** for each phase (the new
  "Drivers" §, the schema/`pins` bumps) — the self-test freezes the contract side, so drift
  fails the build by design.
- **`trajectory.js` is not touched.** If a phase wants to change baseline/diff/act, the seam
  is wrong — those layers are transport-blind and must stay so.

## Suggested commit/PR breakdown

1. P0 refactor (one PR; the green-suite gate is the review checklist).
2. P1a: schema + config + actor overlay split + step-schema union (no driver yet; web still
   byte-identical, new keys validate).
3. P1b: mobile driver + env/preflight + mock-llm rules + fixture app + tests + viewer case.
4. P1c (optional, gated by §10.1 decision): mobile network capture via proxy.
5. P2a: schema + config + api overlay. P2b: api driver + tests + viewer case.
