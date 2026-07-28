// Placement, in a real browser: where a run would go, and what the console says
// when nothing can take it.
//
// The failure this covers is a run that sits on the claim board for ten minutes
// and then fails with "no runner with the label X has checked in". Everything
// needed to predict it is already on the launch dialog — the labels the preview
// resolved, and the fleet's presence — so the dialog says it up front, and
// keeps saying something true while it is open: a runner that registers and
// then checks in withdraws the warning without anybody reopening anything.
//
// The other half is the Runners tab, which is where a person is sent when that
// warning is right. It hands over a start command and nothing else: what a
// machine can reach is that machine's own business, so this page holds no
// inventory of targets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createTarget, loadSuiteDir, withApp, REPO_ROOT } from "../integration/helpers.ts";
import { claimer, registerRunner } from "../integration/exec-helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";

/** A project with one labelled ring and one launchable suite. */
async function seedLaunchable(api: HostedDynamic) {
  const project = (await api.post("/projects", { key: "checkout", name: "Checkout" })).body;
  const { application, ring } = await createTarget(api, project, {
    key: "checkout-web",
    name: "Checkout Web",
    runnerLabels: ["macos"],
  });
  const suite = (await api.post(`/projects/${project.key}/suites`, { slug: "todos", name: "Todo journeys" })).body;
  const imported = await api.postTar(
    `/suites/${suite.id}/import`,
    writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`)),
  );
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  return { project, application, ring, suite };
}

test("the launch dialog says where a run is placed, and follows the fleet while it is open", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const { project, suite } = await seedLaunchable(api);

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });

      await page.goto(`${base}/p/${project.key}/suites/${suite.slug}`);
      await page.getByRole("button", { name: "▶ Run" }).click();
      const launch = page.locator("#modal-root .modal");

      // "Runs on": the labels, and whose decision they were. The ring's, here —
      // this launch pinned nothing.
      const placement = launch.locator(".launch-placement");
      await placement.getByText("Runs on", { exact: true }).waitFor();
      await placement.getByText("a runner advertising macos", { exact: true }).waitFor();
      await placement.getByText("the ring's labels", { exact: true }).waitFor();

      // Nothing advertises that label, so the dialog says so in the words the
      // failure would have used, and offers the remedy rather than a dead end.
      const warn = launch.locator(".launch-warnings .preview-warn");
      await warn.getByText(/No registered runner advertises the label “macos”/).waitFor();
      await warn.getByRole("link", { name: "Set up a runner" }).waitFor();
      // A warning, never a block: a runner started thirty seconds from now
      // still takes this run.
      assert.equal(await launch.getByRole("button", { name: /Launch/ }).isDisabled(), false);

      // A machine registers with that label. The registration rides the feed, so
      // the open dialog re-reads the fleet — and now says the honest next thing:
      // it matches, but it has never started.
      const runner = await registerRunner(api, project, { name: "adas-laptop", labels: ["macos"] });
      await warn.getByText(/adas-laptop matches, but nothing has checked in recently/).waitFor();

      // …and when it actually checks in — a board poll is a check-in — the
      // warning withdraws itself with no reopening and no reload.
      await claimer(base, runner.credential).poll("?labels=macos");
      await warn.waitFor({ state: "detached" });
      await placement.getByText("a runner advertising macos", { exact: true }).waitFor();

      // Closing the dialog releases the subscription it opened.
      await launch.getByRole("button", { name: "Cancel" }).click();
      await launch.waitFor({ state: "detached" });

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});

test("the Runners tab hands over a start command with --config, and holds no target inventory", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const { project, ring } = await seedLaunchable(api);

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });

      await page.goto(`${base}/p/${project.key}/settings/runners`);
      await page.getByRole("heading", { name: "Runners", exact: true }).waitFor();

      // The tab says where a machine declares what it holds — a file on its own
      // disk — and never lists targets itself.
      await page.getByText(/--config <file>/).first().waitFor();
      await page.getByText(/keyed by application and ring|per application and ring/).first().waitFor();
      assert.equal(
        await page.getByText(ring.base_url, { exact: true }).count(),
        0,
        "a ring's URL is Applications' business; Runners must hold no target inventory",
      );

      // Register: the one and only reveal of the credential, with the exact
      // command to paste — and the mobile addendum beside it.
      await page.getByRole("button", { name: "+ Register runner" }).click();
      const dialog = page.locator("#modal-root .modal");
      await dialog.getByLabel("Name").fill("adas-laptop");
      await dialog.getByLabel("Labels").fill("macos, ios-sim");
      await dialog.getByRole("button", { name: "Register" }).click();

      const reveal = page.locator("#modal-root .modal");
      await reveal.getByText("adas-laptop is registered").waitFor();
      const command = await reveal.getByLabel("Runner start command").textContent();
      assert.match(String(command), /^PLAYTEST_RUNNER_CREDENTIAL='/, "the credential rides the environment, not argv");
      assert.match(String(command), /runner-agent pool --server .* --labels macos,ios-sim/);
      await reveal.getByText(/For mobile runs, add/).waitFor();
      await reveal.getByText(/--config <file>/).first().waitFor();
      await reveal.getByText(/docs\/guidance\/hosted-runners\.md/).first().waitFor();

      await reveal.getByRole("button", { name: "Done" }).click();
      await reveal.waitFor({ state: "detached" });
      await page.getByText("adas-laptop", { exact: true }).first().waitFor();

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
