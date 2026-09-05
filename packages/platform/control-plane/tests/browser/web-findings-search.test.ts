import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { ulid } from "../../src/ulid.ts";
import { withApp } from "../integration/helpers.ts";

test("Findings filters persist, export the same rows, and ignore stale searches", async () => {
  await withApp(async ({ base, app, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "finding-search", name: "Finding search" })).body;
    const checkout = "Checkout discount disappears after returning from payment even though the order summary still says the promotion was applied successfully";
    const looksFixed = "Checkout discount remains after the latest passing run";
    const profile = "Profile avatar is cropped on narrow screens";

    const insert = async ({ title, severity, state = "new", summary = {} }: HostedDynamic) => {
      const id = ulid();
      await app.db.query(
        `INSERT INTO findings (id, project_id, fingerprint, title, severity, state, last_seen, summary)
         VALUES ($1, $2, $1, $3, $4, $5, now(), $6)`,
        [id, project.id, title, severity, state, JSON.stringify(summary)],
      );
      return id;
    };

    await insert({
      title: checkout,
      severity: "major",
      summary: { story_id: "checkout", claim: { observed: "The invoice resets the discount" } },
    });
    await insert({
      title: looksFixed,
      severity: "major",
      state: "accepted",
      summary: { story_id: "checkout", auto_resolve: { suggested: { reason: "A newer checkout run passed" } } },
    });
    await insert({ title: profile, severity: "minor", summary: { story_id: "profile" } });

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });

      await page.goto(`${base}/p/${project.key}/findings?filter=review`);
      const search = page.getByRole("searchbox", { name: "Search findings" });
      const status = page.locator(".findings-controls [role=status]");
      await status.getByText("3 of 3 findings", { exact: true }).waitFor();

      await search.fill("Checkout");
      await search.evaluate((input: HTMLInputElement) => input.setSelectionRange(3, 3));
      await status.getByText("2 of 2 findings", { exact: true }).waitFor();
      assert.deepEqual(await search.evaluate((input: HTMLInputElement) => ({
        focused: document.activeElement === input,
        start: input.selectionStart,
        end: input.selectionEnd,
      })), { focused: true, start: 3, end: 3 });

      const severity = page.getByRole("button", { name: "Filter by severity" });
      await severity.click();
      await page.getByRole("option", { name: "Major", exact: true }).click();
      await status.getByText("2 of 2 findings", { exact: true }).waitFor();
      await page.getByText(checkout, { exact: true }).waitFor();
      await page.getByText(looksFixed, { exact: true }).waitFor();
      await page.getByRole("heading", { name: "Looks fixed (1)", exact: true }).waitFor();
      assert.equal(await page.getByText(profile, { exact: true }).count(), 0);
      const filteredUrl = new URL(page.url());
      assert.equal(filteredUrl.searchParams.get("filter"), "review");
      assert.equal(filteredUrl.searchParams.get("q"), "Checkout");
      assert.equal(filteredUrl.searchParams.get("severity"), "major");

      const [download] = await Promise.all([
        page.waitForEvent("download"),
        page.getByRole("button", { name: "Download findings" }).click(),
      ]);
      const downloadedPath = await download.path();
      assert.ok(downloadedPath);
      const markdown = await fsp.readFile(downloadedPath, "utf8");
      assert.match(markdown, new RegExp(checkout));
      assert.match(markdown, new RegExp(looksFixed));
      assert.doesNotMatch(markdown, new RegExp(profile));
      const exportUrl = new URL(download.url());
      assert.equal(exportUrl.searchParams.get("q"), "Checkout");
      assert.equal(exportUrl.searchParams.get("severity"), "major");
      assert.equal(exportUrl.searchParams.get("include_fix_suggested"), "1");

      await search.fill("does-not-exist");
      await status.getByText("0 of 0 findings", { exact: true }).waitFor();
      await page.getByText("No matching findings", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Clear filters" }).click();
      await status.getByText("3 of 3 findings", { exact: true }).waitFor();
      assert.equal(await search.inputValue(), "");
      assert.equal(await search.evaluate((input) => document.activeElement === input), true);
      const clearedUrl = new URL(page.url());
      assert.equal(clearedUrl.searchParams.get("filter"), "review");
      assert.equal(clearedUrl.searchParams.has("q"), false);
      assert.equal(clearedUrl.searchParams.has("severity"), false);

      await page.route("**/api/v1/projects/finding-search/findings?*", async (route) => {
        const q = new URL(route.request().url()).searchParams.get("q");
        if (q !== "Slow") return route.continue();
        await new Promise((resolve) => setTimeout(resolve, 500));
        try { await route.continue(); } catch { /* the newer search aborted it */ }
      });
      const slowRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname.endsWith("/findings") && url.searchParams.get("q") === "Slow";
      });
      await search.fill("Slow");
      await slowRequest;
      await search.fill("Checkout");
      await status.getByText("2 of 2 findings", { exact: true }).waitFor();
      await page.waitForTimeout(600);
      assert.equal(await search.inputValue(), "Checkout");
      assert.equal(await page.getByText(checkout, { exact: true }).count(), 1);
      assert.equal(await page.getByText("No matching findings", { exact: true }).count(), 0);

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
