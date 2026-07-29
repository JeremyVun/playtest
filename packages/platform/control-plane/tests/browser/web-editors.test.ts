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
