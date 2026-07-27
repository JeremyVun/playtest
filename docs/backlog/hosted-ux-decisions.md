# Hosted web UX — locked decisions (2026-07-10)

Decisions locked with Jeremy after the environment-config design discussion (the
`/tmp/handoff-playtest-env-config-design.md` thread) and a holistic UX review of the
hosted web app. Items marked **done** landed the same day; the rest are the ordered
follow-up work.

## 1. Environment vs suite config — the precedence model (done)

**The environment record is a *project-level* source of defaults for core's existing
`app.envs.<name>` mechanism — not a different kind of thing, and not the winner.**

- Cascade: suite `app.envs.<name>` keys **win per-key** over the environment record's
  declared keys (suite isolation — a suite's own idea of "staging" beats the project's),
  which in turn beat the suite's top-level `app.base_url` (core `--env` semantics,
  unchanged).
- Carve-out: credentials are operator-owned. `auth_states` (minted sessions),
  `secret_env`, and the env's `auth.default` behavior stay environment-authoritative —
  a committed, possibly model-drafted file can never shadow minted credentials.
- Core is untouched; only `src/platform/runner-agent/src/workspace.ts mergeOverlay` composes
  the overlay differently (pinned by `src/platform/runner-agent/tests/unit/workspace.test.ts`,
  recorded in
  [Hosted contracts: Environments, secrets, and target authentication](../contracts/hosted.md#environments-secrets-and-target-authentication)).
- The launch dialog says the resolved target out loud: `POST run-groups/preview` now
  returns `target {resolved_base_url, source, suite_base_url, environment_base_url}`
  and the launcher renders "Will test <url> — from this environment, overriding the
  suite's <url>" with a warning treatment on override or missing URL.

**Closed (2026-07-25).** The "suite's own config (no environment)" option shipped as
the blessed implicit environment rather than an `environment_id: null` launch: every
project owns a `default` environment that declares no URL, so a launch against it
resolves to each suite's `app.base_url`. Suites can also own environments of their
own (`environments.suite_id`, migration 0006), which is what lets a project with no
rings configured run at all. Contract:
[Hosted contracts: Environments, secrets, and target authentication](../contracts/hosted.md#environments-secrets-and-target-authentication).

Still open: stop seeding the junk "production" env in `studies/hosted-ux/seed.mjs`
(fake SSO) — seed a harmless "local" env instead.

## 2. Environments become a top-level rail item (decided, not yet built)

> **Superseded (2026-07-24) by the shipped hosted simplification (M0); the
> contract is [`../contracts/hosted.md`](../contracts/hosted.md).**
> The rail collapses to **Overview · Runs · Findings · Settings**; Environments
> does not become a top-level rail item. The environment *form* (Base URL, auth
> identities, secret references, runner labels, discovery toggle, JSON escape
> hatch) survives — it moves into the **Test targets** section of Settings, which
> absorbs environments, auth providers, and secret references. See
> simplification P1.

- Left rail: Suites · Runs · Review · Findings · Insights · **Environments** · Settings.
  Role-gated (developer+), absorbing the **Auth providers** tab as a section — providers
  exist only to serve environments; splitting them across Settings tabs broke the
  mental model.
- The environment editor becomes a **form** (Base URL, auth identities picker, secret
  references, runner labels, discovery toggle) instead of a raw JSON textarea — the
  JSON blob was the most developer-hostile surface a non-technical user hit. Keep a
  "JSON" escape hatch for the long tail.
- First-run path: the launch modal links "manage environments"; an empty project's
  first launch offers inline environment creation.

## 3. Assistant: project-scoped right rail, propose-approve (decided, not yet built)

> **Superseded (2026-07-24) by the shipped hosted simplification (M0); the
> contract is [`../contracts/hosted.md`](../contracts/hosted.md).**
> The project-wide assistant rail and the proposal-card system are dropped. AI
> assistance narrows to inline, stateless **Help me draft** inside the story form
> (simplification P2): one story per assist flow, no persistent panel, no
> read-tool suite, no launch/create-env/promote proposal cards, no persisted
> sessions or transcripts. The human-only save boundary survives via the ordinary
> suite commit. Batch-2 items 1a–1d and 2 below are withdrawn accordingly.

- One persistent assistant docked as a right-side panel on every page (replacing the
  per-suite Assistant page as the primary entry; deep links keep working).
- **Dynamic page context**: the panel injects where the user is (project, suite, story,
  run, finding) and the relevant projections into the session.
- **Broad read tools**: runs/history, findings, environments (never secret values),
  suite files, health.
- **Mutations stay human-approved** — the existing invariant ("the assistant can never
  write; a human commits") generalizes to proposal cards: story/defaults drafts (exists
  today), "launch suite X against env Y", "create environment", "promote run to
  finding". One uniform review gesture, no free-writing agent.
- Increments: (a) dock the existing suite assistant as a rail with page context,
  (b) add read tools, (c) add proposal tools beyond drafts.

## 4. Naming and affordances (done unless noted)

- **"Versions", not "History"** for suite snapshots; "Run history" is the only
  "history". Versions/Export/Import live inside **Edit files** (was "Files"); the suite
  header is now Edit files · Assistant · + New story · ▶ Run.
- Suites index: row click + slug link only (no third "Open" button). *(Also applies to
  the project home suite table — Open column still there, remove opportunistically.)*
- New suite / project modals: **name first, slug auto-derived** (editable, stops
  syncing once touched).
- Trend pips carry a plain-words title ("last 5 runs: 3 infra · 2 pass").
- Custom themed dropdown (`enhanceSelect` in `src/platform/web/lib/ui.js`) replaces native
  select popups everywhere (macOS Liquid Glass fought the theme); native `<select>`
  stays as the value/change source. New selects: build with `h("select")` as usual and
  route through `formField`/`enhanceSelect`.
- Embedded viewer gets keyboard focus on load (space/arrows work); story Run history
  merges platform run rows so manifest-less runs (infra/lost/canceled) appear instead
  of silently vanishing (`story-history.js`).

Still open (word-list for a sweep, next session): pick **story** everywhere user-visible
(the review flow still says "journey", core API says "case"); translate "Refresh saved
paths", "Record with agent", "Save commit"; move Legal hold + Bundle into an overflow
menu on the run header; enrich the suites index (or land Suites nav on the project-home
table) so the two suite lists stop disagreeing in richness.

## 5. Batch 2 — locked 2026-07-10 (Q&A with Jeremy)

**Status 2026-07-10 (second session): items 1a+1b, 3–10 are implemented** (working
tree; verified — root/server/runner tests green modulo the pre-existing
phase5-retention media failure, plus a 22-check Playwright pass on the dev plane
and a live assistant turn). Still open: 1c+1d (read_file / delete_draft /
findings read / suite digest), 2 (assistant rail + proposal cards), and the §1/§2
open items (explicit "no environment" launch option, environments rail + form
editor, seed cleanup).

1. **Assistant upgrades (proceed, in this order):** (a) environments in the system
   prompt (names + base_urls, never secrets) + the precedence rule; (b) `read_runs`
   tool — recent statuses, failed gate checks, errors for this suite's stories; the
   flagship use is **failed-run diagnosis** ("the gate asserts X, the app said Y —
   here's a fixed draft"); (c) `read_file` (kills the improve-story 3000-char goal
   truncation hack), `delete_draft`, findings read; (d) **suite digest** — cross-story
   summarization the per-run grader structurally can't do (start as an assistant
   capability, not an Insights extension). No collision with the grader: it's core,
   per-run, contract-pinned; the assistant only reads run evidence after the fact.
2. **Rail + proposal cards** (explained & approved): assistant docks as a persistent,
   collapsible right panel on every page with injected page context; ALL mutations
   render as confirm-button cards (generalizing today's draft cards: launch / create
   env / promote finding). Human always pulls the trigger — the "assistant can never
   write" invariant survives with full capability.
3. **Single-story run**: "Run" on each story row + story editor header → the existing
   launch modal preselected via `selection.ids` (server support already exists,
   `dispatcher.js selectCases`). No new modal or endpoint.
4. **Suites: archive as primary, delete only when runless.** Archive = hidden from
   lists/launch, "Archived" filter, unarchivable (column exists; needs
   PATCH /suites/:id + UI). True delete offered only for suites with **zero runs**
   (the typo'd-suite case) — server decides which is legal. Rationale: suites anchor
   runs/baselines/findings evidence; hard delete either cascades away evidence or
   dangles references.
5. **Suite-header honesty fix**: stop regexing playtest.yaml (matches nested
   base_url); parse with the client's existing `lib/caseform.js parseYaml`, show only
   top-level `app.base_url` as "tests <url>"; if only env-scoped URLs exist say
   "no default URL — target is chosen at launch".
6. **Import/export roles**: import is reversible (every import = immutable snapshot),
   so **Import = editor** (confirm dialog: "replaces N files — a new version is
   created; roll back from Versions"), **Export = any reader**. Files page opens to
   editors; code-tier files (hooks/assertions) render read-only below developer.
7. **Perf batch (priority, "unacceptable")**: cache resolved cases **by snapshot id**
   (immutable → perfect key); `story_count` on the suites list projection (kills the
   project-home N+1 tree materializations); `GET /projects/:p/suites/:slug` (kills
   list-then-filter on every suite-scoped page).
8. **Nav cohesion pass**: add Overview rail item (project home currently `nav: null`,
   unreachable from the rail); breadcrumb consistency sweep.
9. **Assistant commit flow**: after drafts commit, offer "Run it now" (launch modal,
   committed stories preselected) / "Open story" — closes the create→run golden path.
10. **Review sign-off receipt** must be server-derived (candidate row), not the
    in-memory `ctl.resolvedNote` that vanishes on navigation.
11. Standing rule from Jeremy: anything that simplifies contracts and surface area
    without functionality loss is pre-approved.

## Verification notes

- `npm test` (root) green, 0 skipped. `npm --prefix src/platform/runner-agent test` green.
- `src/platform/control-plane` integration suite green except `phase5-retention` (clip generation)
  which **fails identically at pristine HEAD** on this machine — pre-existing local
  media-pipeline issue, not caused by these changes.
