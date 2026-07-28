import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { withApp } from "../integration/helpers.ts";

test("hosted web loads a project and follows the suite hot path", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "checkout", name: "Checkout" })).body;
    await api.post(`/projects/${project.key}/suites`, { slug: "smoke", name: "Smoke suite" });

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

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
