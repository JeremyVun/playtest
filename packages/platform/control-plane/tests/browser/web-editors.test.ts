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
      await page.locator(".savebar").getByRole("button", { name: "Discard changes" }).click();
      await page.locator("#modal-root").getByRole("button", { name: "Discard changes" }).click();
      assert.equal(await page.getByLabel("playtest.yaml").inputValue(), savedDefaults);

      await page.goto(`${base}/p/${project.key}/suites/todos/stories/add-todo`);
      await page.getByRole("heading", { name: "add-todo", exact: true }).waitFor();
      const storyToggle = page.locator(".page-head .seg");
      await storyToggle.getByRole("button", { name: "YAML", exact: true }).click();
      const story = page.getByLabel("stories/add-todo.yaml");
      const savedStory = await story.inputValue();
      await story.fill("description: [");
      await storyToggle.getByRole("button", { name: "Form", exact: true }).click();
      await page.getByText("This file isn't valid YAML").waitFor();
      await page.getByRole("button", { name: "Edit in YAML", exact: true }).click();
      assert.equal(await page.getByLabel("stories/add-todo.yaml").inputValue(), "description: [");
      await page.locator(".savebar").getByRole("button", { name: "Discard changes" }).click();
      await page.locator("#modal-root").getByRole("button", { name: "Discard changes" }).click();
      assert.equal(await page.getByLabel("stories/add-todo.yaml").inputValue(), savedStory);

      assert.deepEqual(errors, []);
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
      await page.getByRole("heading", { name: "add-todo", exact: true }).waitFor();

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
      assert.equal(await claimHeight(), grown, "a rebuilt form opens the claim grown");
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
