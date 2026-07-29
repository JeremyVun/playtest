// The Applications section, driven in a real browser.
//
// The index answers "what does this project test?"; an application's own page
// answers "how is this one set up?" — its permanent identity, each ring in
// full, and the suites bound to it. Three things about that page are worth a
// browser rather than a unit test, because each is a place where the console
// used to be able to lie:
//
//   * a key is presented as IDENTITY, not as an editable field;
//   * a ring's sign-in identities are a real editor whose rows survive a save
//     and reopen — and whose refusals are said before the round trip;
//   * a mobile application never offers a URL, a build path or a device,
//     because no ring holds any of them.
//
// Sibling of web-smoke.test.ts and shares its harness: one control plane per
// test against its own temporary data root, one headless Chromium, and a page
// that fails on any console error.
import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { createTarget, withApp } from "../integration/helpers.ts";

/** One browser, one watched page — every test here wants exactly this. */
async function withPage(fn: HostedDynamic) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await fn(page);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

test("an application's page reads its identity, its rings and what is bound to it", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "checkout", name: "Checkout" })).body;
    const { application, ring } = await createTarget(api, project, {
      key: "checkout-web",
      name: "Checkout Web",
      baseUrl: "http://127.0.0.1:4173",
      runnerLabels: ["macos"],
    });
    await api.post(`/projects/${project.key}/suites`, { slug: "smoke", name: "Smoke suite" });

    await withPage(async (page: HostedDynamic) => {
      await page.goto(`${base}/p/${project.key}/applications`);
      await page.getByRole("heading", { name: "Applications", exact: true }).waitFor();

      // The whole row is the link — an application's own page is where every
      // control for it lives.
      await page.locator("a.quiet-link").filter({ hasText: application.key }).click();
      await page.waitForURL(`${base}/p/${project.key}/applications/${application.key}`);
      await page.getByRole("heading", { name: "Checkout Web", exact: true }).waitFor();

      // Identity, as identity: the permanent key is shown and there is no field
      // to change it — only the sentence saying why.
      const identity = page.locator(".identity-card");
      await identity.getByText(application.key, { exact: true }).waitFor();
      await identity.getByText("Web", { exact: true }).waitFor();
      assert.equal(await identity.locator("input").count(), 0, "a key is never an editable field on this page");
      await identity.getByText("Why can't these change?").click();
      await identity.getByText(/Runner configuration binds this key/).waitFor();

      // The ring, in full: where it points, and what routes work to it.
      const card = page.locator("section.card").filter({ hasText: ring.key });
      await card.getByText(ring.base_url, { exact: true }).waitFor();
      await card.getByText("Runs on", { exact: true }).waitFor();
      await card.getByText("macos", { exact: true }).waitFor();
      await card.getByText("signed out", { exact: true }).waitFor();

      // …and the suites that launch against it, as links to themselves.
      await page.getByRole("link", { name: "Smoke suite", exact: true }).waitFor();

      // Breadcrumb home, so the pair reads as one section rather than two pages.
      await page.locator(".crumbs").getByRole("link", { name: "Applications", exact: true }).click();
      await page.waitForURL(`${base}/p/${project.key}/applications`);
    });
  });
});

test("a ring's sign-in identities are edited as rows, and survive save and reopen", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "checkout", name: "Checkout" })).body;
    const { application } = await createTarget(api, project, { key: "checkout-web", name: "Checkout Web" });

    await withPage(async (page: HostedDynamic) => {
      await page.goto(`${base}/p/${project.key}/applications/${application.key}`);
      await page.getByRole("heading", { name: "Checkout Web", exact: true }).waitFor();

      // A second ring, created with an identity in the editor rather than by
      // hand-writing `auth.identities` into the overlay JSON.
      await page.getByRole("button", { name: "+ New ring" }).click();
      const dialog = page.locator("#modal-root .modal");
      await dialog.getByText("Sign-in identities", { exact: true }).waitFor();
      await dialog.getByLabel("Key").fill("staging");
      await dialog.getByLabel("URL").fill("https://staging.example.com");
      await dialog.getByRole("button", { name: "+ Add an identity" }).click();
      await dialog.getByLabel("Identity 1 name").fill("member");
      // No provider exists here, so the row offers the two references a runner
      // can resolve on its own; a stored sign-in state is the one being named.
      await dialog.getByLabel(/Identity .* source/).selectOption("secret");
      await dialog.getByLabel(/Identity .* reference/).fill("member-state");

      // The named fields and the overlay are two views of one document, so the
      // row is already in the JSON before anything is saved.
      const overlay = dialog.locator("textarea.code");
      assert.match(await overlay.inputValue(), /"member":\s*\{\s*"\$secret": "member-state"\s*\}/);

      await dialog.getByRole("button", { name: "Create ring" }).click();
      await dialog.waitFor({ state: "detached" });

      // The card says who this ring signs in as, by name — the name a story
      // picks with `auth: member`.
      const card = page.locator("section.card").filter({ hasText: "staging" });
      await card.getByText("Signs in as", { exact: true }).waitFor();
      await card.getByText("member", { exact: true }).waitFor();

      // …and reopening the editor shows the same row, not a paragraph of JSON.
      await card.getByRole("button", { name: `Edit ring ${application.key}/staging` }).click();
      const edit = page.locator("#modal-root .modal");
      await edit.getByText("Sign-in identities", { exact: true }).waitFor();
      assert.equal(await edit.getByLabel("Identity 1 name").inputValue(), "member");
      assert.equal(await edit.getByLabel(/Identity .* source/).inputValue(), "secret");
      assert.equal(await edit.getByLabel(/Identity .* reference/).inputValue(), "member-state");

      // A row nothing can select is refused HERE, naming what is missing,
      // rather than saved into a ring no story can name.
      await edit.getByRole("button", { name: "+ Add identity" }).click();
      // Adding a row puts the cursor in THAT row — landing back in the first
      // row's name field would silently rename the identity already there.
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
        "Identity 2 name",
      );
      await edit.getByRole("button", { name: "Save" }).click();
      await edit.getByText(/Name every identity/).waitFor();
      // The refusal is a refusal: the dialog is still open and nothing moved.
      await edit.getByText("Sign-in identities", { exact: true }).waitFor();

      // Naming it, but pointing it at nothing, is refused too — and the message
      // says which identity and what would fix it.
      await edit.getByLabel("Identity 2 name").fill("admin");
      await edit.getByRole("button", { name: "Save" }).click();
      await edit.getByText(/“admin” has nothing to sign in with/).waitFor();

      await edit.getByRole("button", { name: "Cancel" }).click();
      await edit.waitFor({ state: "detached" });

      // Nothing was written by a refused save.
      const rings = (await api.get(`/projects/${project.key}/applications?include=rings`)).body.items;
      const staging = rings[0].rings.find((r: HostedDynamic) => r.key === "staging");
      assert.deepEqual(staging.config.auth.identities, { member: { $secret: "member-state" } });
    });
  });
});

test("a mobile application says the runner supplies the build, and its ring holds no URL", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "checkout", name: "Checkout" })).body;
    const { application, ring } = await createTarget(api, project, {
      key: "todo-ios",
      name: "Todo iOS",
      driver: "mobile",
      platform: "ios",
    });

    await withPage(async (page: HostedDynamic) => {
      await page.goto(`${base}/p/${project.key}/applications/${application.key}`);
      await page.getByRole("heading", { name: "Todo iOS", exact: true }).waitFor();
      await page.locator(".identity-card").getByText("iOS", { exact: true }).waitFor();

      // The ring's "Where" is a sentence about who holds the build, because the
      // platform holds none of it.
      const card = page.locator("section.card").filter({ hasText: ring.key });
      await card.getByText("the claiming runner supplies the build", { exact: true }).waitFor();

      // …and the page answers "where do I set the build, then?" in place,
      // with the runner's own configuration keys.
      await page.getByText("Where the build comes from", { exact: true }).waitFor();
      await page.getByText(/no ring holds them and nothing on this page can set them/).waitFor();
      await page.getByText(/app: \/path\/to\/your\/build/).waitFor();
      await page.getByText(/docs\/guidance\/hosted-runners\.md/).first().waitFor();

      // The ring editor offers no URL, no build path, no device: a field for a
      // fact the platform cannot hold would be a field that lies.
      await card.getByRole("button", { name: `Edit ring ${application.key}/${ring.key}` }).click();
      const dialog = page.locator("#modal-root .modal");
      await dialog.getByText(/A mobile ring holds no URL, build path, device or Appium endpoint/).waitFor();
      assert.equal(await dialog.getByLabel("URL").count(), 0, "a mobile ring must offer no URL field");
      assert.equal(await dialog.getByLabel("Cookies").count(), 0, "cookies are a web-only ring field");
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });
  });
});
