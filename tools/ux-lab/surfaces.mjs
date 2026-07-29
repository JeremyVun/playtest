// The inventory of hosted console surfaces a UX pass has to look at: every
// route, plus the states a route can be in that a plain GET can't reach
// (modals, overflow menus, tabs, in-flight runs, empty projects).
//
// A surface is `{ id, title, path(data), act?, note? }`.
//   path  the URL to open, given the seeded ids
//   act   an async (page) step run after the page settles — open the modal, pick
//         the tab, expand the menu — before the screenshot is taken
//   note  what a reviewer should be looking at here
//
// `act` steps use accessible names on purpose: if a control cannot be reached
// by its visible label, that is itself an audit finding. `act` also receives the
// seeded ids, so a surface that needs the SERVER to move while its page is open
// (sealing a live run under the run page) can do that too.

// Exact accessible-name match first (a substring match once clicked the "Runs"
// rail link while reaching for a "Run" button); fall back to a contains match
// so labels carrying a glyph like "▶ Run" still resolve.
const clickText = (text, sel = "button, a, [role=option], [role=menuitem]") => async (page) => {
  const all = page.locator(sel);
  const exact = all.filter({ hasText: new RegExp(`^\\s*[▶+⋯]?\\s*${text}\\s*[▾]?\\s*$`) });
  const target = (await exact.count()) ? exact.first() : all.filter({ hasText: text }).first();
  await target.click({ timeout: 5000 });
  await page.waitForTimeout(500);
};

export const SURFACES = [
  // --- entry, first run, navigation --------------------------------------
  {
    id: "root-redirect",
    title: "Landing (/) → first project",
    path: () => "/",
    note: "What a returning user sees first. Is the landing choice explained?",
  },
  {
    id: "projects-list",
    title: "All projects",
    path: () => "/projects",
    note: "Project cards show key + name. Does the key earn its place?",
  },
  {
    id: "projects-new-modal",
    title: "New project modal",
    path: () => "/projects",
    act: clickText("New project"),
    note: "Name + Key. Two fields for one concept — the flagged case.",
  },
  {
    id: "project-empty",
    title: "Project home — empty (first run)",
    path: (d) => `/p/${d.emptyProjectKey}`,
    note: "The true first-run screen. Does it teach the next action?",
  },
  {
    id: "project-empty-new-suite",
    title: "New suite modal (from empty project)",
    path: (d) => `/p/${d.emptyProjectKey}`,
    act: clickText("New suite"),
    note: "Name + Slug. Same redundancy as the project modal.",
  },
  {
    id: "project-home",
    title: "Project home — populated",
    path: (d) => `/p/${d.projectKey}`,
    note: "Overview is also the suite index. Pass rate, attention list, suites.",
  },
  {
    id: "project-switcher",
    title: "Project switcher open",
    path: (d) => `/p/${d.projectKey}`,
    act: async (page) => {
      await page.locator(".proj-switch button").first().click();
      await page.waitForTimeout(300);
    },
  },
  {
    id: "user-menu",
    title: "User menu open",
    path: (d) => `/p/${d.projectKey}`,
    act: async (page) => {
      await page.locator(".usermenu > button").first().click();
      await page.waitForTimeout(300);
    },
    note: "Theme toggle lives here. Is a three-state toggle discoverable?",
  },

  // --- suites and stories -------------------------------------------------
  {
    id: "suite-stories",
    title: "Suite — stories",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}`,
  },
  {
    id: "suite-empty",
    title: "Suite — no stories yet",
    path: (d) => `/p/${d.projectKey}/suites/${d.emptySuiteSlug}`,
  },
  {
    id: "suite-launch-modal",
    title: "Launch dialog",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}`,
    act: clickText("Run"),
    note: "Two decisions: where it runs and whether the agent drives. Plan and price sit beside Launch.",
  },
  {
    id: "suite-launch-modal-envs",
    title: "Launch dialog — choosing a ring",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}`,
    act: async (page) => {
      await clickText("Run")(page);
      await page.locator(".modal .field", { hasText: "Ring" }).locator(".select-btn").click();
      await page.waitForTimeout(200);
    },
    note: "Every option names the host it points at (key · host, discovery if allowed).",
  },
  {
    id: "suite-launch-modal-agent",
    title: "Launch dialog — record with agent",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}`,
    act: async (page) => {
      await clickText("Run")(page);
      await clickText("Agent")(page);
    },
    note: "The costly, path-replacing mode. Is the consequence stated before Launch?",
  },
  {
    id: "suite-launch-modal-blocked",
    title: "Launch dialog — discovery blocked by the target",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}`,
    act: async (page) => {
      await clickText("Run")(page);
      await page.locator(".modal .field", { hasText: "Ring" }).locator(".select-btn").click();
      await clickText("production")(page);
      await page.waitForTimeout(500);
    },
    note: "Refusal as an explanation, with the one-click way out. Launch must be disabled.",
  },
  {
    id: "suite-launch-modal-limits",
    title: "Launch dialog — limits opened",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}`,
    act: async (page) => {
      await clickText("Run")(page);
      await page.locator(".launch-limits > summary").click();
      await page.waitForTimeout(200);
    },
    note: "Folded overrides. The summary must already state the budget in force.",
  },
  {
    id: "suite-launch-modal-production",
    title: "Launch dialog — production target",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}/stories/add-todo`,
    act: async (page) => {
      await clickText("Run")(page);
      await page.locator(".modal .field", { hasText: "Ring" }).locator(".select-btn").click();
      await clickText("production")(page);
      await page.waitForTimeout(500);
    },
    note: "The compact launcher must keep the real-browser production warning prominent.",
  },
  {
    id: "suite-settings",
    title: "Suite settings",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}/settings`,
    // Rings are read-only here now — a suite belongs to one application and
    // launches only against that application's rings; adding or taking one away
    // happens on the Applications page (captured separately below).
    note: "Rings: read-only, owned by the suite's application. Does the Manage link reach them?",
  },
  {
    id: "story-new",
    title: "New story",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}/new`,
  },
  {
    id: "story-new-assist",
    title: "New story — Help me draft",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}/new?assist=1`,
    note: "The only AI surface left. Does it explain what it will produce?",
  },
  {
    id: "story-edit",
    title: "Story editor",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}/stories/add-todo`,
  },
  {
    id: "story-edit-discovery",
    title: "Story editor — discovery story",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}/stories/export-study`,
    note: "Mode changes the meaning of every field below it.",
  },
  {
    id: "story-history",
    title: "Story run history",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}/stories/add-todo/history`,
  },
  {
    id: "suite-files",
    title: "Edit files",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}/files`,
    note: "Raw YAML editor + versions/export/import. The developer escape hatch.",
  },
  {
    id: "suite-versions",
    title: "Suite versions",
    path: (d) => `/p/${d.projectKey}/suites/${d.suiteSlug}/history`,
  },

  // --- runs ----------------------------------------------------------------
  {
    id: "runs-list",
    title: "Runs",
    path: (d) => `/p/${d.projectKey}/runs`,
    note: "Mixed verdicts: pass, fail, changed, infra, explored, and four runs in flight at once. "
      + "One row per run whatever it is doing — live ones carry a meter, a ticking clock and a "
      + "one-line 'now'. Only a recent run holding a failure opens itself.",
  },
  {
    id: "runs-live",
    title: "Runs — in flight",
    path: (d) => `/p/${d.projectKey}/runs?live=1`,
    note: "The watching tab: every run still queued or running, each opened to its live story "
      + "blocks. This is where the full trail lives, so the dense default list never has to carry it. "
      + "Each live story carries ● Watch, in the column a finished story keeps ▶ Replay.",
  },
  {
    id: "runs-launch-modal",
    title: "Launch dialog — from the runs index",
    path: (d) => `/p/${d.projectKey}/runs`,
    act: clickText("Launch"),
    note: "The one entry point that picks a suite too. Does the extra control fit the same shape?",
  },
  {
    id: "runs-attention",
    title: "Runs — needs attention",
    path: (d) => `/p/${d.projectKey}/runs?attention=1`,
    note: "The triage filter: only runs holding a failed check or a story that never ran, expanded.",
  },
  {
    id: "run-group",
    title: "Run deep link (index, expanded)",
    path: (d) => `/p/${d.projectKey}/runs/${d.groups.at(-2).id}`,
    note: "A run's URL opens the index with that run expanded — the dashboard page is gone.",
  },
  {
    id: "run-group-live",
    title: "Run in flight (live rows on the index)",
    path: (d) => `/p/${d.projectKey}/runs/${d.liveGroupId}`,
    note: "Live story blocks: pulsing mode chip, right-aligned vitals, step-budget meter, one-line fading ↳ action trail, queued stories summarised on one line; Cancel on the run's row.",
  },
  {
    id: "run-group-explored",
    title: "Discovery run (index, expanded, Synthesize)",
    path: (d) => `/p/${d.projectKey}/runs/${d.exploredGroupId}`,
  },
  {
    id: "run-detail-live",
    title: "Run evidence — streaming (an open run)",
    path: (d) => (d.liveRun ? `/p/${d.projectKey}/runs/${d.liveRun.group}/${d.liveRun.id}` : null),
    note: "A run still executing. The header wears the ● live badge and one line of what it is "
      + "doing; the embedded viewer plays the steps that have landed so far and holds a pending "
      + "row for the one in flight. Nothing here polls — the iframe owns the live stream, the "
      + "page owns the event feed. The 404s on grade.json and har.json are the design: an open "
      + "run has no grade and no HAR yet, and the viewer degrades to showing neither.",
  },
  {
    id: "run-detail-seal",
    title: "Run evidence — the seal landing",
    path: (d) => {
      const run = d.nextSealRun?.();
      return run ? `/p/${d.projectKey}/runs/${run.groupId}/${run.runDbId}` : null;
    },
    // Sealed underneath the open page, which is the only way to photograph the
    // handoff: the chrome's verdict arrives on the feed, the iframe's grade
    // arrives on its own live poll, and they have to land together.
    act: async (page, d) => {
      await d.sealCurrentRun();
      await page.waitForTimeout(4000);
    },
    note: "The same page a moment later. The badge became a verdict, the provenance gained its "
      + "duration and bundle, and the replay reloaded in place — check that nothing flashed empty "
      + "and that the two halves agree.",
  },
  {
    id: "run-detail-pass",
    title: "Run evidence — pass",
    path: (d) => `/p/${d.projectKey}/runs/${d.passRun.group}/${d.passRun.id}`,
  },
  {
    id: "run-detail-fail",
    title: "Run evidence — fail",
    path: (d) => `/p/${d.projectKey}/runs/${d.failRun.group}/${d.failRun.id}`,
    note: "The most important screen in the product: why did this fail?",
  },
  {
    id: "run-detail-infra",
    title: "Run evidence — infra error",
    path: (d) => `/p/${d.projectKey}/runs/${d.infraRun.group}/${d.infraRun.id}`,
    note: "Not the app's fault. Is that distinction legible, and is it actionable?",
  },
  {
    id: "run-detail-changed",
    title: "Run evidence — changed (diff view)",
    path: (d) => `/p/${d.projectKey}/runs/${d.changedRun.group}/${d.changedRun.id}?view=diff`,
    note: "Accept/Reject a baseline change. The core review gesture.",
  },
  {
    id: "run-detail-explored",
    title: "Run evidence — explored",
    path: (d) => `/p/${d.projectKey}/runs/${d.exploredRun.group}/${d.exploredRun.id}`,
  },
  {
    id: "run-detail-overflow",
    title: "Run evidence — overflow menu",
    path: (d) => `/p/${d.projectKey}/runs/${d.failRun.group}/${d.failRun.id}`,
    act: clickText("More"),
  },

  // --- review, findings, candidates ---------------------------------------
  {
    id: "review",
    title: "Review — changed stories",
    path: (d) => `/p/${d.projectKey}/review`,
  },
  {
    id: "findings",
    title: "Findings",
    path: (d) => `/p/${d.projectKey}/findings`,
  },
  {
    id: "finding-detail",
    title: "Finding detail",
    path: (d) => `/p/${d.projectKey}/findings/${d.findingId}`,
  },
  {
    id: "findings-review",
    title: "Findings — needs review",
    path: (d) => `/p/${d.projectKey}/findings?filter=review`,
    note: "Machine-filed claims as unreviewed findings, with inline Confirm/Dismiss.",
  },
  {
    id: "finding-review-detail",
    title: "Unreviewed finding detail",
    path: (d) => (d.candidateId ? `/p/${d.projectKey}/findings/${d.candidateId}` : null),
    note: "The needs-review banner, claim, and Confirm / Dismiss / merge verbs.",
  },
  {
    id: "consolidation",
    title: "Consolidation",
    path: (d) => `/p/${d.projectKey}/consolidation`,
  },

  // --- personas -------------------------------------------------------------
  {
    id: "personas",
    title: "Personas",
    path: (d) => `/p/${d.projectKey}/personas`,
    note: "Two tiers on one page: editable project personas over read-only built-ins. "
      + "The description IS the actor's prompt — does the page make that legible without a wall of grey?",
  },
  {
    id: "personas-empty",
    title: "Personas — none of your own yet",
    path: (d) => `/p/${d.emptyProjectKey}/personas`,
    note: "Built-ins only. Does it say what a persona is FOR before asking for one?",
  },
  {
    id: "personas-new-modal",
    title: "New persona modal",
    path: (d) => `/p/${d.projectKey}/personas`,
    act: clickText("New persona"),
    note: "Name, immutable slug, and the prompt text. Is the slug's permanence stated before it is fixed?",
  },
  {
    id: "personas-edit-modal",
    title: "Edit persona",
    path: (d) => `/p/${d.projectKey}/personas`,
    act: async (page) => {
      await page.getByRole("button", { name: /^Edit the Warehouse picker persona$/ }).click();
      await page.waitForTimeout(400);
    },
    note: "The full prompt, editable, with Delete where the person already committed attention.",
  },
  {
    id: "personas-builtin-modal",
    title: "Built-in persona — read only",
    path: (d) => `/p/${d.projectKey}/personas`,
    act: async (page) => {
      await page.getByRole("button", { name: /^View the adversarial persona$/ }).click();
      await page.waitForTimeout(400);
    },
    note: "The longest built-in prompt in full. Is 'copy it to change it' the obvious next move?",
  },

  // --- settings -----------------------------------------------------------
  // Test targets moved out of Settings entirely: an application owns its
  // rings, and the rail links to it directly (redirects.ts sends the old
  // /settings/test-targets path here now).
  {
    id: "applications",
    title: "Applications",
    path: (d) => `/p/${d.projectKey}/applications`,
    note: "Applications, their rings, auth identities, secrets. The densest form in the app.",
  },
  {
    id: "settings-models",
    title: "Settings — Models",
    path: (d) => `/p/${d.projectKey}/settings/models`,
    note: "Four model choices and two automation policies. Does the page read as groups or as a list of questions?",
  },
  {
    id: "settings-models-edited",
    title: "Settings — Models, mid-edit",
    path: (d) => `/p/${d.projectKey}/settings/models`,
    act: async (page) => {
      // Closing by hand is the one answer that changes the shape of the page:
      // the model that verifies fixes goes inert, and the save bar appears
      // because there is now an uncommitted decision.
      await page.getByRole("radiogroup", { name: "Closing a finding a later run has fixed" })
        .getByRole("radio", { name: "By hand" }).click();
      await page.waitForTimeout(200);
    },
    note: "Does an answered-but-inactive setting read as inactive, and is the pending change obvious?",
  },
  {
    id: "settings-team",
    title: "Settings — Team",
    path: (d) => `/p/${d.projectKey}/settings/team`,
  },
  {
    id: "settings-audit",
    title: "Settings — Audit",
    path: (d) => `/p/${d.projectKey}/settings/audit`,
  },

  // --- failure and edge states --------------------------------------------
  {
    id: "not-found",
    title: "Unknown route",
    path: () => "/p/todo-app/nope/nope",
  },
  {
    id: "project-not-found",
    title: "Project that doesn't exist",
    path: () => "/p/does-not-exist",
  },
  {
    id: "run-not-found",
    title: "Run that doesn't exist",
    path: (d) => `/p/${d.projectKey}/runs/01AAAAAAAAAAAAAAAAAAAAAAAA/01BBBBBBBBBBBBBBBBBBBBBBBB`,
  },

  // Last on purpose: the drawer's open state is remembered in localStorage, so
  // opening it mid-walk would leave it open behind every surface after this one.
  {
    id: "zz-statusbar-dispatches",
    title: "System status bar — dispatch drawer open",
    path: (d) => `/p/${d.projectKey}/runs`,
    act: clickText("Dispatches"),
    note: "The always-on footer. Does the bar read at a glance, and does the drawer explain its numbers?",
  },
];
