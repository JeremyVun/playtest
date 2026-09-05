import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createTarget, loadSuiteDir, withApp, REPO_ROOT } from "../integration/helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";

test("the suite and story editors preserve one source across Form, YAML, and discard", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "editors", name: "Editors" })).body;
    await createTarget(api, project, { key: "todo-web", name: "Todo Web" });
    const suite = (await api.post(`/projects/${project.key}/suites`, {
      slug: "todos",
      name: "Todo journeys",
    })).body;
    const imported = await api.postTar(
      `/suites/${suite.id}/import`,
      writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`)),
    );
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const persona = await api.put(`/suites/${suite.id}/files/stories/personas/tester.yaml`, {
      content: "name: tester\ndescription: Follows the story from the nested suite persona file.\n",
      base_seq: imported.body.snapshot.seq,
    });
    assert.equal(persona.status, 200, JSON.stringify(persona.body));

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });

      await page.goto(`${base}/p/${project.key}/suites/todos/settings`);
      await page.getByRole("heading", { name: "Suite settings", exact: true }).waitFor();
      const suiteToggle = page.locator(".page-head .seg");
      await suiteToggle.getByRole("button", { name: "YAML", exact: true }).click();
      const defaults = page.getByLabel("playtest.yaml");
      const savedDefaults = await defaults.inputValue();
      await defaults.fill("app: [");
      await suiteToggle.getByRole("button", { name: "Form", exact: true }).click();
      await page.getByText("This file isn't valid YAML").waitFor();
      await page.getByRole("button", { name: "Edit in YAML", exact: true }).click();
      assert.equal(await page.getByLabel("playtest.yaml").inputValue(), "app: [");
      const importButton = page.getByRole("button", { name: "Import", exact: true });
      await importButton.click();
      await page.locator("#modal-root").getByRole("button", { name: "Keep editing" }).click();
      assert.equal(await page.getByLabel("playtest.yaml").inputValue(), "app: [");
      const fileChooser = page.waitForEvent("filechooser");
      await importButton.click();
      await page.locator("#modal-root").getByRole("button", { name: "Discard changes" }).click();
      await (await fileChooser).setFiles([]);
      assert.equal(await page.getByLabel("playtest.yaml").inputValue(), savedDefaults);
      await page.getByLabel("playtest.yaml").fill("app: [");
      const rail = page.getByRole("navigation", { name: "Project navigation" });
      await rail.getByRole("link", { name: "Suites", exact: true }).click();
      await page.locator("#modal-root").getByRole("button", { name: "Keep editing" }).click();
      assert.equal(page.url(), `${base}/p/${project.key}/suites/todos/settings`);
      assert.equal(await page.getByLabel("playtest.yaml").inputValue(), "app: [");
      await rail.getByRole("link", { name: "Suites", exact: true }).click();
      await page.locator("#modal-root").getByRole("button", { name: "Discard changes" }).click();
      await page.getByRole("heading", { name: "Suites", exact: true }).waitFor();

      await page.getByRole("link", { name: "Todo journeys", exact: true }).click();
      await page.getByRole("link", { name: 'Add "buy milk" and see it appear in the list.', exact: true }).click();
      await page.getByRole("heading", { name: 'Add "buy milk" and see it appear in the list.', exact: true }).waitFor();
      assert.match(await page.getByRole("button", { name: "Persona", exact: true }).innerText(), /tester — From suite/);
      const storyToggle = page.locator(".page-head .seg");
      await storyToggle.getByRole("button", { name: "YAML", exact: true }).click();
      const story = page.getByLabel("stories/add-todo.yaml");
      const savedStory = await story.inputValue();
      await story.fill("description: [");
      await storyToggle.getByRole("button", { name: "Form", exact: true }).click();
      await page.getByText("This file isn't valid YAML").waitFor();
      await page.getByRole("button", { name: "Edit in YAML", exact: true }).click();
      assert.equal(await page.getByLabel("stories/add-todo.yaml").inputValue(), "description: [");

      const reloadDialog = page.waitForEvent("dialog", { timeout: 5_000 });
      const reload = page.reload().catch(() => null);
      const beforeUnload = await reloadDialog;
      assert.equal(beforeUnload.type(), "beforeunload");
      await beforeUnload.dismiss();
      await reload;
      assert.equal(await page.getByLabel("stories/add-todo.yaml").inputValue(), "description: [");

      await rail.getByRole("link", { name: "Runs", exact: true }).click();
      await page.locator("#modal-root").getByRole("button", { name: "Keep editing" }).click();
      assert.equal(await page.getByLabel("stories/add-todo.yaml").inputValue(), "description: [");
      await rail.getByRole("link", { name: "Runs", exact: true }).click();
      await page.locator("#modal-root").getByRole("button", { name: "Discard changes" }).click();
      await page.waitForURL(`${base}/p/${project.key}/runs`);

      await page.goBack();
      await page.getByRole("heading", { name: 'Add "buy milk" and see it appear in the list.', exact: true }).waitFor();
      await page.getByRole("button", { name: "YAML", exact: true }).click();
      await page.getByLabel("stories/add-todo.yaml").fill("description: [");
      await page.goBack();
      await page.locator("#modal-root").getByRole("button", { name: "Keep editing" }).click();
      assert.equal(await page.getByLabel("stories/add-todo.yaml").inputValue(), "description: [");
      await page.goBack();
      await page.locator("#modal-root").getByRole("button", { name: "Discard changes" }).click();
      await page.getByRole("heading", { name: "Todo journeys", exact: true }).waitFor();

      await page.goForward();
      await page.getByRole("heading", { name: 'Add "buy milk" and see it appear in the list.', exact: true }).waitFor();
      await page.getByRole("button", { name: "YAML", exact: true }).click();
      assert.equal(await page.getByLabel("stories/add-todo.yaml").inputValue(), savedStory);
      await page.getByLabel("stories/add-todo.yaml").fill("description: [");
      await page.goForward();
      await page.locator("#modal-root").getByRole("button", { name: "Keep editing" }).click();
      assert.equal(await page.getByLabel("stories/add-todo.yaml").inputValue(), "description: [");
      await page.goForward();
      await page.locator("#modal-root").getByRole("button", { name: "Discard changes" }).click();
      await page.waitForURL(`${base}/p/${project.key}/runs`);

      assert.equal(savedDefaults.includes("app:"), true);

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});

test("editor saves commit one snapshot and leave newer typing unsaved", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "atomic-editors", name: "Atomic editors" })).body;
    await createTarget(api, project, { key: "todo-web", name: "Todo Web" });
    const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "todos", name: "Todo journeys" })).body;
    const imported = await api.postTar(
      `/suites/${suite.id}/import`,
      writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`)),
    );
    assert.equal(imported.status, 200, JSON.stringify(imported.body));

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${base}/p/${project.key}/suites/todos/settings`);
      await page.getByRole("heading", { name: "Suite settings", exact: true }).waitFor();
      const settingsToggle = page.locator(".page-head .seg");
      await settingsToggle.getByRole("button", { name: "YAML", exact: true }).click();
      const defaults = page.getByLabel("playtest.yaml");
      const savedDefaults = await defaults.inputValue();
      const submittedDefaults = `${savedDefaults}\n# submitted settings\n`;
      const newerDefaults = `${submittedDefaults}# newer settings\n`;
      await defaults.fill(submittedDefaults);

      let releaseDefaults = () => {};
      let markDefaultsStarted = () => {};
      const defaultsGate = new Promise<void>((resolve) => { releaseDefaults = resolve; });
      const defaultsStarted = new Promise<void>((resolve) => { markDefaultsStarted = resolve; });
      const defaultsPattern = `**/api/v1/suites/${suite.id}/files/playtest.yaml`;
      await page.route(defaultsPattern, async (route) => {
        if (route.request().method() !== "PUT") return route.continue();
        markDefaultsStarted();
        await defaultsGate;
        await route.continue();
      });
      const settingsBar = page.locator(".savebar");
      await settingsBar.getByRole("button", { name: "Save", exact: true }).click();
      await defaultsStarted;
      assert.equal(await settingsBar.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
      assert.equal(await settingsBar.getByRole("button", { name: "Discard changes", exact: true }).isDisabled(), true);
      assert.equal(await settingsToggle.getByRole("button", { name: "Form", exact: true }).isDisabled(), true);
      assert.equal(await settingsToggle.getByRole("button", { name: "YAML", exact: true }).isDisabled(), true);
      await defaults.fill(newerDefaults);
      releaseDefaults();
      await page.getByText("Settings saved", { exact: true }).waitFor();
      assert.equal(page.url(), `${base}/p/${project.key}/suites/todos/settings`);
      assert.equal(await defaults.inputValue(), newerDefaults);
      assert.equal(await settingsBar.getByRole("button", { name: "Save", exact: true }).isEnabled(), true);
      assert.equal((await api.get(`/suites/${suite.id}/files/playtest.yaml`)).body.content, submittedDefaults);
      await settingsBar.getByRole("button", { name: "Discard changes", exact: true }).click();
      await page.locator("#modal-root").getByRole("button", { name: "Discard changes" }).click();
      assert.equal(await defaults.inputValue(), submittedDefaults);
      await page.unroute(defaultsPattern);

      await page.goto(`${base}/p/${project.key}/suites/todos/stories/add-todo`);
      await page.getByRole("heading", { name: 'Add "buy milk" and see it appear in the list.', exact: true }).waitFor();
      const storyToggle = page.locator(".page-head .seg");
      await storyToggle.getByRole("button", { name: "YAML", exact: true }).click();
      const story = page.getByLabel("stories/add-todo.yaml");
      const savedStory = await story.inputValue();
      const submittedStory = `${savedStory}\n# submitted story\n`;
      const newerStory = `${submittedStory}# newer story\n`;
      await story.fill(submittedStory);

      let releaseStory = () => {};
      let markStoryStarted = () => {};
      const storyGate = new Promise<void>((resolve) => { releaseStory = resolve; });
      const storyStarted = new Promise<void>((resolve) => { markStoryStarted = resolve; });
      const storyPattern = `**/api/v1/suites/${suite.id}/commit`;
      await page.route(storyPattern, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        markStoryStarted();
        await storyGate;
        await route.continue();
      });
      const storyBar = page.locator(".savebar");
      await storyBar.getByRole("button", { name: "Save", exact: true }).click();
      await storyStarted;
      assert.equal(await storyBar.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
      assert.equal(await storyBar.getByRole("button", { name: "Discard changes", exact: true }).isDisabled(), true);
      assert.equal(await storyToggle.getByRole("button", { name: "Form", exact: true }).isDisabled(), true);
      assert.equal(await storyToggle.getByRole("button", { name: "YAML", exact: true }).isDisabled(), true);
      await story.fill(newerStory);
      releaseStory();
      await page.getByText("Saved", { exact: true }).waitFor();
      assert.equal(page.url(), `${base}/p/${project.key}/suites/todos/stories/add-todo`);
      assert.equal(await story.inputValue(), newerStory);
      assert.equal(await storyBar.getByRole("button", { name: "Save", exact: true }).isEnabled(), true);
      assert.equal((await api.get(`/suites/${suite.id}/files/stories/add-todo.yaml`)).body.content, submittedStory);
      await storyBar.getByRole("button", { name: "Discard changes", exact: true }).click();
      await page.locator("#modal-root").getByRole("button", { name: "Discard changes" }).click();
      assert.equal(await story.inputValue(), submittedStory);
      await page.unroute(storyPattern);

      const detachedStory = `${submittedStory}# saved after leaving\n`;
      await story.fill(detachedStory);
      let releaseDetached = () => {};
      let markDetachedStarted = () => {};
      let markDetachedFinished = () => {};
      const detachedGate = new Promise<void>((resolve) => { releaseDetached = resolve; });
      const detachedStarted = new Promise<void>((resolve) => { markDetachedStarted = resolve; });
      const detachedFinished = new Promise<void>((resolve) => { markDetachedFinished = resolve; });
      await page.route(storyPattern, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        markDetachedStarted();
        await detachedGate;
        const response = await route.fetch();
        await route.fulfill({ response });
        markDetachedFinished();
      });
      await storyBar.getByRole("button", { name: "Save", exact: true }).click();
      await detachedStarted;
      await page.getByRole("navigation", { name: "Project navigation" }).getByRole("link", { name: "Runs", exact: true }).click();
      await page.locator("#modal-root").getByRole("button", { name: "Discard changes" }).click();
      await page.waitForURL(`${base}/p/${project.key}/runs`);
      releaseDetached();
      await detachedFinished;
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
      assert.equal(page.url(), `${base}/p/${project.key}/runs`, "a detached editor cannot redirect after its save finishes");
      assert.equal(await page.locator("#modal-root > *").count(), 0);
      assert.equal((await api.get(`/suites/${suite.id}/files/stories/add-todo.yaml`)).body.content, detachedStory);
    } finally {
      await browser.close();
    }
  });
});

test("the story form's success criteria name each kind, explain it, and write the file", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "criteria", name: "Criteria" })).body;
    await createTarget(api, project, { key: "todo-web", name: "Todo Web" });
    const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "todos", name: "Todo journeys" })).body;
    const imported = await api.postTar(
      `/suites/${suite.id}/import`,
      writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`)),
    );
    assert.equal(imported.status, 200, JSON.stringify(imported.body));

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });

      await page.goto(`${base}/p/${project.key}/suites/todos/stories/add-todo`);
      await page.getByRole("heading", { name: 'Add "buy milk" and see it appear in the list.', exact: true }).waitFor();

      // add-todo's four criteria, each read as a NAME rather than as the opening
      // of a sentence its value finishes ("Outcome, in words", "Console errors
      // at most"), and each with one line under it saying what it checks.
      const kindOf = (n: number) => page.getByRole("button", { name: `Criterion ${n} — what to check` });
      assert.deepEqual(
        await Promise.all([1, 2, 3, 4].map(async (n) => (await kindOf(n).innerText()).replace(/\s*▾\s*$/, ""))),
        ["Element exists", "API called", "Assertion", "Console errors"],
      );
      await page.getByText("by the grader model", { exact: false }).waitFor();
      // A ceiling is typed as a count, with the ceiling said out loud.
      const count = page.getByLabel("Criterion 4 — Console errors");
      assert.equal(await count.getAttribute("type"), "number");
      assert.equal(await count.inputValue(), "0");
      await page.locator(".criterion", { has: count }).getByText("at most").waitFor();

      // Changing a kind carries a value the new kind can still mean (0 stays 0)…
      await kindOf(4).click();
      await page.getByRole("option", { name: "Accessibility issues", exact: true }).click();
      assert.equal(await page.getByLabel("Criterion 4 — Accessibility issues").inputValue(), "0");
      // …and replaces one it never could: a CSS selector is not a count.
      await kindOf(1).click();
      await page.getByRole("option", { name: "Console errors", exact: true }).click();
      assert.equal(await page.getByLabel("Criterion 1 — Console errors").inputValue(), "0");

      // A claim is a sentence, and a sentence does not fit on one line of an
      // input. It grows to what it says instead of scrolling out of sight, and
      // it still opens grown after the form is rebuilt (the YAML toggle).
      const claim = page.getByLabel("Criterion 3 — Assertion");
      const claimHeight = () => claim.evaluate((el: HTMLElement) => el.clientHeight);
      const oneLine = await claimHeight();
      await claim.fill("The results show that the buyer is not eligible for any government home-buying scheme, and the reason given names their household income");
      const grown = await claimHeight();
      assert.ok(grown > oneLine, `a wrapped claim must grow: ${oneLine} → ${grown}`);
      // Enter is not a newline: the schema types a claim as one string.
      await claim.press("End");
      await claim.press("Enter");
      assert.ok(!(await claim.inputValue()).includes("\n"), "a claim must stay one line");

      const seg = page.locator(".page-head .seg");
      await seg.getByRole("button", { name: "YAML", exact: true }).click();
      await seg.getByRole("button", { name: "Form", exact: true }).click();
      await claim.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(await claimHeight() > oneLine, "a rebuilt form opens the claim grown");
      await claim.fill('the list shows a todo called "buy milk"');

      // The cosmetic label the form has always PRESERVED is now editable, and
      // it is offered on the row you are working in — so reach it as a person
      // does, by being on that row.
      const claimRow = page.locator(".criterion", { has: claim });
      await claimRow.hover();
      await claimRow.getByRole("button", { name: "Name it" }).click();
      await page.getByLabel("Criterion 3 — name (optional)").fill("Milk is on the list");

      await seg.getByRole("button", { name: "YAML", exact: true }).click();
      const yaml = await page.getByLabel("stories/add-todo.yaml").inputValue();
      assert.match(yaml, /console_errors: 0/);
      assert.match(yaml, /accessibility_violations: 0/);
      assert.match(yaml, /assert: the list shows a todo called "buy milk"\n    label: Milk is on the list/);
      // A criterion the form never touched keeps its kind and its value, and so
      // does every key outside `success` — the story's block literal included.
      assert.match(yaml, /api_called: POST \/api\/todos/);
      assert.match(yaml, /^tags: \[smoke\]\n/);
      assert.match(yaml, /^story: \|\n/m);

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
