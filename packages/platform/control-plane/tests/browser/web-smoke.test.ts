import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createTarget, loadSuiteDir, withApp, REPO_ROOT } from "../integration/helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";

test("hosted web loads a project and follows the suite hot path", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "checkout", name: "Checkout" })).body;
    // A suite binds to an application at creation, so the target comes first.
    const { application, ring } = await createTarget(api, project, { key: "checkout-web", name: "Checkout Web" });
    await api.post(`/projects/${project.key}/suites`, { slug: "smoke", name: "Smoke suite" });
    // A second, launchable suite: the launch dialog needs stories to size, and
    // the empty one above is what proves the empty state still reads.
    const todos = (await api.post(`/projects/${project.key}/suites`, { slug: "todos", name: "Todo journeys" })).body;
    const imported = await api.postTar(
      `/suites/${todos.id}/import`,
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

      await page.goto(`${base}/p/${project.key}`);
      await page.getByRole("heading", { name: "Suites", exact: true }).waitFor();
      const suite = page.getByRole("link", { name: "Smoke suite", exact: true });
      assert.equal(await suite.count(), 1);

      await suite.click();
      await page.waitForURL(`${base}/p/${project.key}/suites/smoke`);
      await page.getByRole("heading", { name: "Smoke suite", exact: true }).waitFor();
      await page.getByText("No stories yet", { exact: true }).waitFor();

      // Applications is a first-class section now, and it is where the environment a
      // suite launches against is managed — so the rail item has to resolve and
      // the page has to render both halves of the pair. The index is a scan, so
      // an environment reads as its host; the full URL is on the application's own page
      // (tests/browser/web-applications.test.ts).
      await page.getByRole("link", { name: "Applications", exact: true }).click();
      await page.waitForURL(`${base}/p/${project.key}/applications`);
      await page.getByRole("heading", { name: "Applications", exact: true }).waitFor();
      await page.getByText(application.key, { exact: true }).first().waitFor();
      await page.getByText(new URL(ring.base_url).host, { exact: true }).first().waitFor();

      // New suite asks for the application, because a suite runs against
      // exactly one and the binding is immutable.
      await page.getByRole("link", { name: "Suites", exact: true }).click();
      await page.waitForURL(`${base}/p/${project.key}`);
      await page.getByRole("button", { name: "+ New suite" }).click();
      const dialog = page.locator("#modal-root .modal");
      await dialog.getByText("Application", { exact: true }).waitFor();
      // The themed dropdown mirrors the selected option into its own button, so
      // that is what a person actually reads.
      await dialog.locator(".select-val").filter({ hasText: application.key }).first().waitFor();
      await dialog.getByRole("button", { name: "Cancel" }).click();

      // The launch dialog selects (suite, environment) and states what the environment
      // resolves to — the one place the silent-wrong-target trap used to live.
      await page.getByRole("link", { name: "Todo journeys", exact: true }).click();
      await page.waitForURL(`${base}/p/${project.key}/suites/todos`);
      await page.getByRole("button", { name: "▶ Run" }).click();
      const launch = page.locator("#modal-root .modal");
      await launch.getByText("Environment", { exact: true }).waitFor();
      await launch.locator(".select-val").filter({ hasText: ring.key }).first().waitFor();
      await launch.locator(".launch-target-url").getByText(ring.base_url, { exact: true }).waitFor();
      await launch.getByRole("button", { name: "Cancel" }).click();

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
