# Hosted console — adversarial UX/UI audit (2026-07-25)

> **Status: implemented in full (2026-07-25).** Every finding below — P1, P2 and
> P3 — was fixed in the console. Three decisions were taken by Jeremy where the
> audit left a choice open: the project/suite key is derived and immutable,
> shown read-only in Settings; the findings lifecycle words are **Open ·
> Confirmed · Resolved · Rejected**; and the launch dialog defaults to the
> environment a suite last ran against, then one that allows discovery, then the
> first non-production one. The resulting rules live in
> `docs/contracts/hosted.md` ("Hosted information architecture" and "Web
> experience invariants") — that contract, not this document, is now the source
> of truth. This file stays as the record of what was wrong and why.
>
> One finding was corrected during implementation: G2's `NEXT RUN: record`
> is fixed server-side (the hosted `/cases` projection reads the `baselines`
> table, not the materialized tree), and the "notes on evidence" caveat about
> story-history times proved real — that page read the bundle manifest's clock
> while every other surface read the platform run row, so it now reads the run
> row too.

An end-to-end pass over every screen, dialog, and flow in `src/platform/web`,
read adversarially: not "does it work" but "what does this ask a person to
understand, and what happens when they get it wrong".

**Method.** Built [`tools/ux-lab`](../../tools/ux-lab/) — a throwaway control
plane seeded with a rich project (pass / fail / infra / changed / explored /
in-flight runs, findings, candidates, two environments) and an empty one, then
walked 39 surfaces with Playwright in both themes. Evidence: 80 screenshots plus
`out/report.json`, which records the accessible name of every visible control on
every screen. Reproduce with `node tools/ux-lab/lab.mjs shoot`.

**Verdict.** The console is competent and unusually honest — the failure banner,
the launch dialog's resolved-target sentence, the "nothing to replay" state, and
the never-color-alone status chips are all better than the category norm. What
holds it back is not layout: it is that **the product's internal model leaks
through the UI at almost every touchpoint**. Users are asked to supply, read,
and reconcile machine identifiers (keys, slugs, story ids, file paths, category
enums, ULIDs), and the same concept is named three different ways depending on
which screen you are standing on. The second problem is safety asymmetry:
spending money and destroying work are one unconfirmed click away, while the
things that are safe are the ones behind confirmations.

Findings are grouped by theme, ordered by impact within each. P1 = fix before
showing this to a paying user; P2 = fix in the next pass; P3 = polish.

---

## A. The machine model leaks into the interface

### A1 (P1) — "Name" + "Key" on New project, "Name" + "Slug" on New suite
`pages/projects.js:37-60, 199-221`

Both dialogs ask for two fields that carry one idea. The second is auto-derived,
and its own hint explains it as an implementation detail ("auto-derived from the
name — edit if you want a different URL slug"). Nobody creating their first
project has an opinion about their URL slug, and nothing later in the product
requires them to know it.

It gets worse after creation: the project card shows the **key** as the primary
eyebrow line with the name underneath; the project home repeats the key as the
page subtitle; the suites table links the **slug** and shows the name as
secondary text. So the identifier a user was made to invent is then given more
visual weight than the name they actually chose.

> **Fix.** Ask for the name only. Derive the key/slug silently, guarantee
> uniqueness with a numeric suffix, and expose it for editing in Settings for
> the rare person who cares. Everywhere a key or slug is currently the headline,
> swap it with the name. This is one dialog, one table cell, and two page
> subtitles.

### A2 (P1) — Story ids are the headline; the story is the caption
`pages/suite.js:180-181`

The suite table renders `add-todo` in monospace blue as the row title, with
"Add "buy milk" and see it appear in the list." beneath it in muted grey. For a
product whose pitch is *plain-language user journeys*, the plain language is the
subtitle and the kebab-case identifier is the title. Same inversion on the
findings table (titles are English sentences typeset as code) and the runs table
(`nightly regression` in monospace).

> **Fix.** Description first, at full contrast. Id demoted to a small monospace
> tag beside it, or dropped from the table entirely — it is already in the URL.
> Reserve monospace for things that really are code: selectors, URLs, ids in
> provenance lines.

### A3 (P2) — Raw enum values shown to humans

Observed on screen, verbatim: `no_effect`, `data_mismatch`,
`expectation_violation`, `persona_report`, `element_exists`, `api_called`,
`console_errors`, `locus: /todos list-header`, `signal persona_report`. The
candidate queue's CATEGORY column is nothing but these.

> **Fix.** One display map, next to `lib/labels.js`, the way run modes already
> have one. "no_effect" → "Nothing happened"; "data_mismatch" → "Wrong data
> shown"; "element_exists" → "an element is present". Keep the raw token in a
> `title` or a provenance line for people who grep.

### A4 (P2) — File-system vocabulary in the authoring flow
`pages/story.js` (breadcrumb, "File path" field), `pages/files.js`

The story editor's breadcrumb is `Suites / todos / stories/add-todo.yaml`, and
New story exposes a **File path** input. A person writing "what is this user
trying to do?" should not be choosing a filename. Edit files is the right place
for that; the form is not.

> **Fix.** Derive the path from the story id, show it read-only in a
> provenance/advanced line, and put the yaml path back in the breadcrumb only
> when the YAML tab is active.

### A5 (P2) — Identity shown as ULIDs
`pages/findings.js`, `pages/settings.js` (Audit)

Finding detail: "confirmed just now by **01KYC20S**". Audit: actor
`user:YZ9PE9`, entity `finding NAXNC8`, and a DETAIL column that prints raw JSON
including `strict_key`/`loose_key` sha256s, clipped mid-string with no way to
expand. The server knows this user is "Dev Admin"; the UI shows a truncated
primary key.

> **Fix.** Resolve actor ids to names (fall back to the id). In Audit, render
> detail as a short human sentence per action type with the JSON behind a
> disclosure, and make entity ids links.

### A6 (P3) — "no tracker reference yet — use Copy for tracker, or set one through the finding API"
`pages/findings.js`

A UI telling a UI user to go use the API is a dead end. Either give it a field
or drop the sentence.

---

## B. One concept, several names

### B1 (P1) — story / journey / case
"Story" in the suite table and editor. "1 changed **journey** pending" on
Review. "this **journey** changed and is waiting for a reviewer" on the run
page. "case" throughout the API and in `Case-level progress` on the Runs page
subtitle. The decisions doc already resolved this ("pick **story** everywhere
user-visible") and it is still unresolved in the shipped UI.

> **Fix.** Sweep for "journey" and "case" in `src/platform/web`. Keep "journey"
> only where it means the recorded path being compared, if that distinction is
> worth a word at all.

### B2 (P1) — Findings have three lifecycles depending on where you look
`pages/findings.js`

- Row chips say: `new`, `confirmed`
- Filter tabs say: `Open`, `Dismissed`, `Resolved`
- The API and the audit log say: `accepted`, `rejected`, `resolved`, `reopened`

A user cannot work out which filter contains a "confirmed" finding without
experimenting. And "accepted" on the Overview attention row ("1 occurrence ·
accepted") reads to a newcomer like the finding was *closed*, when it means the
opposite — a human confirmed it is real.

> **Fix.** Pick one set of four words and use them in chips, filters, and
> buttons: e.g. **Needs triage → Confirmed → Fixed / Not a bug**. Map the API
> states to them in one place.

### B3 (P2) — "Candidate" means two unrelated things
`app.js` routes, `pages/candidates.js` vs `pages/review.js`

`/p/:key/candidates` is the unassigned **bug** queue. The Review flow's API
resource, also called candidates, is a **baseline-change** awaiting accept or
reject. The code comments acknowledge the collision ("`/candidates` already
means a baseline-change candidate, hence the `/bug-candidates` prefix") — but
the collision was resolved in the API and left standing in the UI.

> **Fix.** In the UI, the bug queue is **Untriaged** (or "Suspected bugs") and
> the baseline queue is **Changed stories**. Neither is a "candidate".

### B4 (P2) — Run status words are internal mode vocabulary
`lib/labels.js`

On screen: `checked — fail`, `recorded`, `tried to heal`,
`changed — tried to heal → passed`, `infra — never finished`, `checking`,
`explored`, plus the launch dialog's `Refresh saved paths`. "Healing", "infra",
and "refresh saved paths" are all terms of art with no in-product definition.
These chips are the single most-read text in the console.

> **Fix.** `changed — tried to heal → passed` → "the app changed; the story
> still worked". `infra` → "didn't run". `Refresh saved paths` → "Re-record from
> scratch (ignore saved paths)". Add a one-line legend under the runs table.

### B5 (P2) — API resource names surfaced as UI nouns
"Launch **run group**" is the title of the primary launch dialog; RUN GROUP is a
table header. A user launches *a run*, of *some stories*, against *an
environment*.

### B6 (P3) — Git vocabulary for saving a story
"Save commit" / "Commit note" / "Discard" (`pages/story.js`). The immutability
story is good and worth keeping; the words don't have to be git's. "Save" with
an optional "What changed?" note does the same job.

> **Shipped, then narrowed.** The words are plain now, and the "What changed?"
> box is gone from both editors. Asking an author to narrate an edit they are
> looking at is a code-review habit, not a web-app one. Versions still reads as
> a log because the note is DERIVED on save: `added story <id>` / `edited story
> <id>` from the story editor, and `changed app.base_url` (the settings that
> actually moved) from suite settings. "What changed" survives only where the
> app is telling you rather than asking: the Versions column and the review
> diff heading.

---

## C. First run teaches nothing

### C1 (P1) — There is no path from empty project to first run
`pages/projects.js:132-133`

A new project shows: a pass-rate summary reading "— no graded runs this week", a
"No suites yet" card, and two identical New suite buttons (header + empty
state). Nothing anywhere says that a run also needs a **test target** — an
environment with a base URL, which lives three clicks away under Settings → Test
targets and is required before Launch can do anything useful. The user's likely
next move is: create suite → land on an empty suite → write a story → press Run
→ get an environment they didn't configure, or a launch dialog defaulting to
something wrong.

> **Fix.** A three-step checklist on the empty project home — *1. Create a suite
> · 2. Point it at your app · 3. Write your first story* — each step linking to
> the thing that does it, each ticking off as it completes. Drop the pass-rate
> summary until there is at least one run. Drop one of the two New suite
> buttons.

### C2 (P2) — The empty-suite header opens with a warning
`pages/suite.js:140-142`

A brand-new suite reads "0 stories · **no app URL configured — stories must each
carry their own**". That is an alarming, and misleading, first sentence: at
launch the environment supplies the URL anyway. Meanwhile ▶ Run is enabled on a
suite with zero stories.

> **Fix.** On an empty suite say nothing about URLs; say what to do next.
> Disable Run (with a tooltip) until there is a story.

### C3 (P3) — `/` lands on the alphabetically first project
`app.js:29-32`

With two projects, a returning user is dropped into "Acme Checkout" — the empty
one — because it sorts first. Remember the last project (localStorage) or land
on `/projects`.

### C4 (P3) — Empty suites sort above real ones and offer nothing
Project home lists `onboarding` (0 stories, no results) above `todos` (4
stories, live run). Sort by activity, and give a 0-story row an inline "Add a
story" link.

---

## D. Costly and destructive actions are the least protected

### D1 (P1) — Destructive buttons look exactly like safe ones until hovered
`style.css:180` — `.btn.danger` sets a colour **only** on `:hover`

Settings → Test targets carries four `Delete` buttons and three `Edit` buttons
in identical grey. On a touch screen, and for anyone navigating by keyboard, the
danger styling never appears at all. (The confirm dialogs behind them are good;
the affordance is the problem.)

> **Fix.** Give `.btn.danger` a resting treatment — red text or a red-tinted
> border — and reserve the filled red for the confirm dialog's action.

### D2 (P1) — Cancelling an in-flight run has no confirmation
`pages/runs.js:174`

One click on `Cancel` kills a running group — real browser time, real model
spend, no undo, no dialog. Every *delete* in Settings confirms; the one action
that destroys work in progress does not.

### D3 (P1) — "Discard" silently throws away unsaved story edits
`pages/story.js:86`

It navigates away immediately. The same file has a careful confirm for the
concurrent-edit conflict case, so the omission looks accidental.

### D4 (P1) — The launch dialog preselects the riskiest environment
`pages/runs.js:327+`

With `production` and `staging` configured, the dialog opens on **production**
(first by order, not by safety). The dialog is otherwise excellent — it names
the resolved URL, warns when discovery is disallowed, offers a one-click "Use
staging", and estimates cost — which makes the default choice the one thing out
of step. It also offers no story selection at all: it launches everything, and
running a subset is only possible from the per-row ▶ Run.

> **Fix.** Default to the last environment used for this suite, else the one
> that allows discovery, else the first non-production; never default to a name
> matching `prod*`. Add a story picker (all / changed only / pick).

### D5 (P2) — Import promises a rollback that doesn't exist
`pages/suite.js:249` vs `pages/files.js`

The import confirm says "A new version is created — **you can roll back from
Versions**". The Versions page offers exactly one action per row: `Export`.
There is no restore.

> **Fix.** Either add "Restore this version" (the snapshot machinery is already
> there) or correct the sentence.

### D6 (P3) — Model spend without a number
"Synthesize findings" on a discovery group and "Run consolidation" both spend
model calls. Consolidation is exemplary — it states its scope and says "no model
call needed" when true. Synthesize says nothing.

---

## E. Navigation loses the user

### E1 (P1) — Six page types render with no active rail item
`lib/shell.js` + `lib/nav.js` vs the `nav:` values passed by pages

`RAIL` contains `overview | runs | findings | settings`. But `pages/suite.js`,
`story.js`, `files.js`, `history.js`, and `story-history.js` all pass
`nav: "suites"`, and `review.js` passes `nav: "review"` — values that match
nothing. Result: on the suite list, the story editor, Edit files, Versions, run
history, and Review — the authoring surfaces people spend the most time in —
**every rail item is inactive** and the user has no indication of where they are
in the app.

> **Fix.** Map `suites → overview` (Overview is the suite index) and
> `review → runs`, or add the mapping to `RAIL`. One line in `renderFrame`.

### E2 (P2) — Two breadcrumb vocabularies for the same parent
The suite page says `Overview / todos`. The story editor says
`Suites / todos / stories/add-todo.yaml`, where "Suites" is a link to a route
that only exists as a redirect back to Overview.

### E3 (P2) — Error pages are dead ends
- Unknown project: an `<h1>` of the raw slug, "No such project, or you are not a
  member", and no link anywhere. No rail (`renderFrame({})`), so the only way
  out is the browser's Back button.
- Unknown run: "Couldn't load this / **no run "01BBBB…"** / Try again" — an
  internal error string, an id the user never typed, and a retry that can never
  succeed.
- 404: drops the project rail entirely, so a mistyped sub-path ejects you from
  the project.

> **Fix.** Keep the frame. Every dead end gets one real next step ("Back to
> Runs", "See all projects"). Replace "no run <id>" with "That run doesn't exist
> — it may have been deleted by the retention policy."

---

## F. Accessibility and keyboard

### F1 (P1) — The dialog primitive used by every form has no Escape, focus, or trap
`lib/ui.js:70-79`

`formModal` mounts a scrim and returns `close`. It does not bind Escape, does
not move focus into the dialog, does not trap Tab, and does not restore focus on
close. It backs New project, New suite, **Launch**, New environment, New auth
provider, Add secret, Add member, Promote to finding, and both dismiss dialogs.
`confirmModal` immediately above it does handle Escape — so the two primitives
behave differently, and the busier one is the weaker.

> **Fix.** Lift the Escape/focus/restore logic out of `confirmModal` and share
> it. Autofocus the first field.

### F2 (P1) — Unlabelled inputs in the story editor
From `out/report.json`: every Success-criteria **value** input has no
`<label>` — its only name is a placeholder (`[data-testid=…]`, `POST /api/…`,
`the observable outcome, in words`, `0`). The New story **File path** input has
no accessible name at all. Four `⌫` remove-criterion buttons announce as "⌫".

This matters more here than in most products: `lib/ui.js:165` says the shared
field builder exists so labels point at the visible control — "a11y — the tool
scores other apps on exactly this". The tool's own authoring form is the screen
that misses it.

### F3 (P2) — Several controls per screen share one accessible name
`Delete` ×4 and `Edit` ×3 on Settings → Test targets; `▶ Run` ×6 on the suite
table. A screen-reader user cannot tell which environment they are deleting.

> **Fix.** `aria-label="Delete staging"`, `aria-label="Run add-todo"`.

### F4 (P3) — Trend pips encode with colour and a `title`
`pages/suite.js:174-178`. The title text is good ("last 5 runs: 3 pass · 2
fail") but `title` is unreachable by keyboard and on touch. Add a visually
hidden text equivalent.

### F5 (P2) — Hard block below 900px, with no branding and no way forward
`index.html` + the `#scope-gate` media query. Below 900px the entire app is
replaced by two centred paragraphs — no logo, no link, no sign-in state, no
"continue anyway". A half-width window on a laptop hits this. The decision to be
desktop-first is defensible; presenting it as an unbranded wall is not.

> **Fix.** Keep the top bar. Add "Continue anyway" for people who know what they
> are doing, and let read-only surfaces (a run's failure summary) render.

---

## G. Things the UI says that aren't quite true

### G1 (P1) — The suite header claims a target that runs won't use
`pages/suite.js:137-139`

The header reads "5 stories · tests `http://app:4173`" — the suite's own
`playtest.yaml`. The launch dialog then says, correctly, "Will test
`https://todos.example.com` — from this environment, **overriding** the suite's
`http://app:4173`". So the most prominent statement of *where this suite points*
is the one that loses at run time, and the honest version is behind a dialog.

> **Fix.** Show the environment that this suite last ran against, or "target
> chosen at launch", and keep the file's URL in Edit files.

### G2 (P1) — "Next run: record" on stories that already ran and passed
The suite table shows `NEXT RUN: record` beside `LAST: ✓ pass 3 h ago` on the
same row. It is correct in the model (the snapshot tree carries no baselines;
the platform's baselines table is the real source) but it reads as "this has
never been recorded", contradicting the cell next to it.

> **Fix.** Derive `next_run` from the platform's baselines, or drop the column
> from the hosted table — it is a CLI concept.

### G3 (P2) — One authored story appears as N rows
A two-persona discovery story renders as `export-study@curious-newcomer` and
`export-study@power-user`, with identical descriptions, and the header counts
them ("5 stories" for four authored files).

> **Fix.** One row per story with a "2 personas" chip; expand on click.

### G4 (P2) — The changed-run panel tells a web user to run a CLI command
The diff explanation ends with a copy-box containing
`playtest baseline accept 2026-07-25T0709-aec7/add-todo` — roughly 600px below
an **Accept** button that does exactly that. This is viewer copy leaking into
the hosted context.

> **Fix.** In the embedded viewer, suppress the CLI instruction (or swap it for
> "use Accept above").

### G5 (P2) — Infra failures are dressed as product failures
An `ECONNREFUSED` run shows the same red failure banner as a real gate failure,
prints the raw errno, offers **Create finding** (inviting a bug report about an
app that was never reached), and offers no **Retry** — the one thing a person
wants after a connection refusal.

> **Fix.** Amber "didn't run" treatment, plain-English cause ("Playtest couldn't
> reach `http://127.0.0.1:4173` — check the environment's base URL"), a Retry
> button, and no Create finding.

### G6 (P2) — The embedded viewer stays light inside the dark console
Every run evidence page in dark mode renders a bright white viewer panel below a
dark header. The tokens are supposed to be shared between
`src/platform/web/style.css` and `src/run-viewer/style.css`; the theme choice is
not propagated into the iframe.

> **Fix.** Pass the console theme through the viewer URL contract and honour it.

### G7 (P3) — Same row, two words for one state
An in-flight run reads `STATUS: checking` and `PROGRESS: running · 28s`.

### G8 (P3) — "Score trend / ▼ regression" over duration numbers
`pages/story-history.js:87-100`. The badge sits above chips that read "−158ms vs
prev" — a run that got *faster* is filed under "regression". The badge is about
score; the chips are about duration and steps; nothing separates them.

### G9 (P3) — Launch dialog arithmetic
"5 runs — 3 to check · 2 to explore · 2 persona runs" reads as 3 + 2 + 2 = 7.
The last term re-describes the middle one.

---

## What is working — don't regress it

- The **failure banner**: gate spec in code voice, expected-vs-observed in plain
  English, and "Copy failure summary". This is the best thing in the product.
- The **launch dialog's** resolved-target sentence, discovery-not-allowed
  warning with an inline "Use staging" fix, and cost estimate.
- **Status chips**: glyph + word, never colour alone.
- **Empty states** that define the concept rather than just saying "nothing
  here" — "A suite is a set of user-journey stories for one app", "Nothing to
  replay. This run ended before its evidence bundle was uploaded."
- **Consolidation** presented as a proposal you review before anything changes,
  with its scope and "no model call needed" stated up front.
- **Delete confirmations** that name the specific consequence ("Environments
  referencing it will fail until replaced").
- Keyboard hints where they exist (`j/k · Enter · a accept · r reject`;
  `←/→ steps · space play`).

---

## Suggested order of work

1. **Vocabulary + identifier pass** (A1, A2, B1, B2, B3, B5) — mostly copy and
   two table cells; removes the largest share of the confusion for the least
   code.
2. **Safety pass** (D1, D2, D3, D4) — four small diffs, all in the "user loses
   money or work" class.
3. **Navigation and dead ends** (E1, E3) — E1 is a one-line map.
4. **Accessibility** (F1, F2, F3) — F1 is a shared primitive; F2/F3 are label
   attributes.
5. **First run** (C1, C2) — the checklist is the only net-new UI in this list.
6. **Truthfulness** (G1, G2, G4, G5, G6).

## Notes on evidence

Screenshots and the control inventory are regenerable, not committed
(`tools/ux-lab/out*` is gitignored). Two observations were made against
synthetic manifests and should be re-checked on a real run before acting:
story-history renders each run's time from the bundle manifest while every other
surface uses the platform's run row (they agree in production, but they are two
sources), and the seeded candidate evidence cites an arbitrary run, so the
"cited evidence" row on candidate detail is not representative.
