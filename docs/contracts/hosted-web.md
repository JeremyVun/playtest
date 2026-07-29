# Hosted web contracts

This file owns hosted-console information architecture, vocabulary, and
cross-page UX invariants. [Hosted platform contracts](hosted.md) own data and
authorization; [Hosted runner contracts](hosted-runners.md) own placement;
[Hosted findings contracts](hosted-findings.md) own findings and authoring.

Implementation modules own exact routes, markup, copy, and styling. This file
records product-level behavior that must remain consistent across surfaces.

## Information architecture

The console is desktop-first and narrows to Playtest's core loop: author
stories, run them, inspect evidence, and make human decisions.

Project navigation has five items: **Suites**, **Runs**, **Findings**,
**Personas**, and **Settings**. The project switcher and user menu remain in the
top bar. Review queues, baseline candidates, applications, and insights do not
add permanent rail items; they are contextual surfaces under the owning area.

Every page maps to exactly one rail item. Suite detail, story editor, suite
settings, versions, and suite run history map to Suites. Changed-story review
maps to Runs. Deep links retain project context on not-found pages.

Below the supported width, the console preserves the top bar and presents a
desktop requirement with an explicit **Continue anyway** escape hatch.

## Suites and authoring

Suites is the project landing page and only suite index. It summarizes current
attention, recent pass rate with its denominator, latest result, and confirmed
open-finding counts. Machine claims awaiting review are shown separately.

Suite creation asks for an application because the binding is immutable. A
developer may create the first application inline; an editor may select only
existing applications. An empty project tells an editor that a developer must
create one.

The console calls the platform's `ring` resource an **environment** everywhere
a person reads it. `ring` remains the schema, API, and runner-protocol term.

The console edits stories and shared suite defaults, not an arbitrary file
tree. Story and defaults editing is form-first with a YAML view over the same
bytes; comments and untouched keys survive. Personas, hooks, assertions, and
other code-tier files move through import/export and are edited with the CLI.

Authoring asks product questions. A new story path derives from its description,
is read-only by default, and becomes editable only under Advanced. Persona
selection uses the project/built-in catalog rather than free text. Discovery
selection states its resulting run count.

Suite settings contains shared limits, concurrency, model, and browser-display
controls where relevant:

- form and YAML views edit identical bytes and preserve accepted scalar/object
  spellings;
- inherited values name their concrete resolution;
- changing one viewport dimension preserves the other, including a YAML-authored
  null height; and
- custom model entry writes nothing until a non-empty qualified name is given.

A suite never owns the hosted physical target. Application environments own
URL, credentials, and routing labels. Suite settings therefore has no hosted
base-URL or per-environment target form. It may still author logical
`app.envs.<ring>` values. Hosted execution replaces authored physical target
fields at launch; those fields remain valid for direct CLI use.

API rule cards are a contextual suite page. It shows always-enforced Level 0
rules first, then candidates, approved cards, and denied cards. Each assisted
card exposes provenance, approval/rejection/edit controls, and the owner note
that travels to authoring.

## Applications and environments

Applications are developer-editable and viewer-readable contextual project
state. Their surfaces show immutable keys and drivers, bound suites, and
environments. Web/API environment editing includes URL, routing labels, browser
cookies, identities, and secret references.

Mobile application surfaces expose no URL, binary, device, or Appium control.
They state that the claiming runner supplies those facts and link to runner
guidance.

The environment says where a run points. Selection lists only the suite's
application and names the resolved web/API host or the mobile runner-supplied
build. Changing suites re-derives the selection.

Adding an environment asks one question — where runs point — and derives the
rest from the answer. A loopback host is `local`; a host naming a deployment
(`staging.acme.com`, `acme-uat.example`) takes that word; anything else is
`production`. Guessing production for a deployment that is not one costs a
rename, while guessing anything else for one that is would suppress the
production warning, so an unrecognized host resolves toward the warning. The
derived name is displayed, never merely assumed, with one control to override
it. Routing labels, cookies, identities, and the raw overlay are edited on an
environment that exists; they are not asked for before it does. A mobile
environment has no URL to derive from and asks for a name instead.

Machine identifiers derive from names, receive a unique numeric suffix on
conflict, and remain immutable. Names are the visible headline; keys are
read-only identifiers for URLs, CLI, and API use.

## Launching and runs

The launch dialog leads with the two choices that spend money or touch a real
application:

- the environment; and
- **Auto** versus **Agent** execution.

Auto replays saved paths and records when none is usable. Agent records every
story and saves each passing recording as its new path. Recording without
keeping the recording is not offered. The wire's refresh intent is resolved
before mode.

Suite and selected stories are context, not controls. Launches opened from one
story stay scoped to it. The plan, persona fan-out, effective models, limits,
target, routing labels, matching-runner presence, and cost estimate are visible
before confirmation. Optional per-story limit overrides remain behind a
disclosure whose summary states the active limits.

The dialog never preselects a production-like environment when a safer one
exists. It prefers the suite's last environment, then the first non-production
environment.

Runs is a triage table grouped by suite. One row represents one run regardless
of state and summarizes outcomes, target, wall clock, cost, and the one relevant
action: cancel while spending, retry eligible never-started work, or synthesize
completed discovery evidence. Expanding reveals stories in place.

The tabs are **All runs**, **Needs attention**, and **In flight**. Attention is
server-filtered to current product failures and missing verdicts. In-flight
filtering may use the newest loaded page because active runs sort ahead of
completed work.

Automatic expansion is limited to recent finished failures and explicit filter
results. A user's expand/collapse choice wins. A run deep link opens the runs
index with that row expanded and visible.

Each completed story links directly to **Replay**. A story with no verdict shows
the cause instead. Replay provides previous/next and a picker over sibling
stories in the same run.

Pending baseline change is presented as a **changed story**, not a top-level
object. The run's Diff view owns Accept and Reject. Batch review appears only
when several candidates exist and remains contextual.

### Live runs

A live row ticks elapsed time and cost, shows completed versus in-flight work,
and carries one concise current-progress line. Expanded stories show mode,
step/budget, cost, elapsed time, and recent actor action. Queued stories are
summarized because they have no evidence or progress.

The console run surface and embedded viewer use separate push channels and
neither polls: the page consumes platform events, while the viewer consumes the
run's live evidence route. The iframe is remounted only if it initially opened
before any staged evidence, never while streaming.

An executing run is live, not passing or failing. A run with `infra`,
`canceled`, or `lost` is **didn't run**, uses a non-product-failure treatment,
states the cause, and never offers finding creation. If it streamed before
failure, replay shows those steps and states that no sealed bundle exists.

Timeouts are named before downstream gate failures and show the configured
limits. Queued stories are not described as live.

## Findings

The UI vocabulary mirrors the four disjoint buckets:

- **Needs review**: `new`;
- **Open**: `accepted` (displayed as confirmed) and `reopened`;
- **Resolved**; and
- **Rejected**.

Machine-filed claims are findings needing review, never “suspected bugs” or
baseline candidates. Confirmation says a finding is real. Automatic
fix-suggestions appear as distinct review work and never as alarms.

Every finding and synthesized claim links to evidence. Resolutions name their
source run and reason. Missing or pruned evidence is explicit. External handoff
is a human confirmation/copy action, not an automatic tracker action.

## Personas

Personas has permanent navigation because personas are project-wide. Built-ins
appear as locked cards showing the actor's prose; project personas support
create, edit, and delete. Story pickers use the same catalog.

## Settings and operations

Settings contains:

- **Runners**: register, inspect labels/presence/current work, and revoke;
- **Runs**: project concurrency;
- **Models**: project model and finding-automation policy;
- **Team**: members, roles, and admin project deletion; and
- **Audit**.

Secret values are never rendered. Project API-token management remains API/CLI
only. Retention, plugins, and generic integrations are not console settings.

Runner registration reveals the credential exactly once. The credential—not a
constructed command—is the primary copy target because it cannot be recovered.
The example start line contains no credential or labels; it references the
credential environment variable and links to runner guidance for full setup.

Revoking removes a runner on the next repaint unless it is still executing. An
in-flight revoked runner remains visibly marked until the claim lands. Each row
states presence in words as well as color: online, running linked work, offline
with silence duration, never started, revoked, or expired. Runner and run events
trigger refetch; a local clock updates silence without polling.

System health is an always-on status bar, not a page. Non-developers see feed
state. Developers additionally see a quiet summary of running/waiting work and
model spend. Healthy machinery emits no fault chip. Capacity exhaustion and a
stalled reconciler are the two fault classes and are named in words.

Operational detail—capacity, board pickup, reconciliation timing, and dispatch
ledger—opens in a drawer. Ledger rows use human-readable run names, never
shortened ULIDs. Event-driven refresh handles state changes; a slow,
hidden-tab-paused refresh handles clock-derived health such as a silent
watchdog.

Placement failures are explained as runner availability, not application
failure. The console distinguishes no registered runner, label mismatch, no
polling runner, and silent claim holder, and links to Settings → Runners. Run
provenance names the runner and its reported isolation.

## Experience invariants

- Primary copy says story, suite, and run. Journey means the recorded path.
  Internal “case” and “run group” do not appear in product copy.
- Engine tokens pass through one vocabulary mapping. Unknown tokens degrade to
  readable text while retaining the raw value as provenance.
- Plain-language names lead; paths, selectors, URLs, and ids use code styling.
  Runs use launch notes or trigger/time, never shortened ULIDs.
- One shared run-stat derivation owns counts, labels, and tones across list,
  detail, and legacy projections.
- Gate verdicts carry primary visual weight. Scores and movement remain
  secondary and never borrow verdict colors.
- Platform run timestamps own time on every hosted surface; bundle timestamps
  do not override them.
- Cost is visible before fan-out and after completion.
- Missing, delayed, failed, or pruned data names its provenance and a useful
  next step.
- Statements about target, version restore, cost, or current state must be true
  when rendered. Versions offers actual restore as a new snapshot.
- Destructive or spending actions confirm first and name their consequence.
  Danger remains visible before hover; default confirm focus is Cancel.
- Live state resumes from durable cursors and exposes reconnecting state once,
  in the status bar.
- Status never relies on color, shape, or hover title alone. Every equivalent is
  keyboard and touch reachable.
- All modals use one accessible primitive: Escape closes, Tab stays inside,
  initial focus is deliberate, and close restores opener focus.
- Repeated controls name their object through accessible labels. Placeholders
  are never the sole input name.
- A rule a form must state in prose is a rule the form should enforce, derive,
  or demonstrate instead. Where a field's rule can be shown as feedback on what
  was typed — which runners a label set reaches, what a cookie string parses
  to — it is shown, and conditional facts appear only under the input they are
  true of.
- Settings ask one question per decision, not one per stored key. Where stored
  policy keys are dependent — an enable switch plus a mode that only applies
  while it is on — the console presents them as a single ordered choice whose
  options are the reachable policies, and answers every underlying key from the
  chosen option. Tri-state inheritance is preserved per key, so choosing the
  option the deployment already provides pins nothing.
- Automatic resolution is presented as that single choice, on the by
  hand / semi-automatic / fully automatic scale the stored mode already names.
  Option text explains where semi-automatic stops by the distinction the sweep
  actually makes — a finding grounded in something recorded versus a finding
  that is only a written claim — never by internal tier names. The console
  states the two facts the options cannot carry: the policy applies to confirmed
  findings, and a finding with a live external reference stays semi-automatic
  whatever is set.
- A dialog longer than the viewport scrolls its own body and pins its actions
  and its refusal, so neither is discoverable only by scrolling.
- Role-restricted developer and admin controls are progressively disclosed.

## Contract changes

Update this file when navigation, cross-page vocabulary, review presentation,
launch decisions, live-run semantics, operational visibility, or accessibility
invariants change. Exact markup, style, copy, and route inventories do not
belong here by themselves.
