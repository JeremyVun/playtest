// The Applications section, driven in a real browser.
//
// The index answers "what does this project test?"; an application's own page
// answers "how is this one set up?" — its permanent identity, each environment
// in full, and the suites bound to it. Four things about that page are worth a
// browser rather than a unit test, because each is a place where the console
// used to be able to lie or to nag:
//
//   * a key is presented as IDENTITY, not as an editable field;
//   * adding an environment asks ONE question and derives the rest — the URL
//     names it, and the name it derived is on screen where it can be corrected;
//   * an environment's sign-in identities are a real editor whose rows survive
//     a save and reopen, and whose refusals are said before the round trip;
//   * a mobile application never offers a URL, a build path or a device,
//     because no environment holds any of them.
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

test("an application's page reads its identity, its environments and what is bound to it", async () => {
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
      // to change it. Nothing explains the permanence — the absent control is
      // the whole message.
      const identity = page.locator(".identity-card");
      await identity.getByText(application.key, { exact: true }).waitFor();
      await identity.getByText("Web", { exact: true }).waitFor();
      assert.equal(await identity.locator("input").count(), 0, "a key is never an editable field on this page");
      assert.equal(await identity.locator("details").count(), 0, "identity states the facts and argues for none of them");

      // The environment, in full: where it points, and what routes work to it.
      const card = page.locator("section.card").filter({ hasText: ring.key });
      await card.getByText(ring.base_url, { exact: true }).waitFor();
      await card.getByText("Runs on", { exact: true }).waitFor();
      await card.getByText("macos", { exact: true }).waitFor();
      await card.getByText("signed out", { exact: true }).waitFor();
      // A loopback URL means the runner's machine — said under the URL it is
      // true of, which is the only place that sentence appears.
      await card.getByText("On the claiming runner's own machine.", { exact: true }).waitFor();

      // …and the suites that launch against it, as links to themselves.
      await page.getByRole("link", { name: "Smoke suite", exact: true }).waitFor();

      // Breadcrumb home, so the pair reads as one section rather than two pages.
      await page.locator(".crumbs").getByRole("link", { name: "Applications", exact: true }).click();
      await page.waitForURL(`${base}/p/${project.key}/applications`);
    });
  });
});

test("creating an application asks for a name and a surface, and keys it from the name", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "checkout", name: "Checkout" })).body;

    await withPage(async (page: HostedDynamic) => {
      await page.goto(`${base}/p/${project.key}/applications`);
      await page.getByRole("button", { name: "+ New application" }).click();
      const dialog = page.locator("#modal-root .modal");
      const name = dialog.getByLabel("Name");
      await name.waitFor();

      // TWO questions: what it is called, and what it drives. The key is the
      // name slugged, asked nowhere and offered as no field.
      assert.equal(await dialog.locator("input, textarea").count(), 1);

      await name.fill("Checkout Web");
      await dialog.getByRole("button", { name: "Create" }).click();
      await page.waitForURL(`${base}/p/${project.key}/applications/checkout-web`);
    });

    // A second surface, and a name that keys to one the project already has:
    // the refusal names the collision, because nothing on screen showed the key.
    await withPage(async (page: HostedDynamic) => {
      await page.goto(`${base}/p/${project.key}/applications?new=1`);
      const dialog = page.locator("#modal-root .modal");
      await dialog.getByLabel("Name").fill("checkout web");
      await dialog.getByRole("button", { name: "Create" }).click();
      await dialog.getByText(/already has an application keyed “checkout-web”/).waitFor();

      await dialog.getByLabel("Name").fill("Checkout API");
      await dialog.getByLabel("Surface").selectOption("api");
      await dialog.getByRole("button", { name: "Create" }).click();
      await page.waitForURL(`${base}/p/${project.key}/applications/checkout-api`);
    });

    const applications = (await api.get(`/projects/${project.key}/applications`)).body.items;
    assert.deepEqual(
      applications.map((a: HostedDynamic) => [a.key, a.name, a.driver]).sort(),
      [["checkout-api", "Checkout API", "api"], ["checkout-web", "Checkout Web", "web"]],
    );
  });
});

test("a suite can create the application it runs against, in that dialog's own words", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    // An empty project: the state the inline path exists for.
    const project = (await api.post("/projects", { key: "checkout", name: "Checkout" })).body;

    await withPage(async (page: HostedDynamic) => {
      await page.goto(`${base}/p/${project.key}`);
      // An empty project shows the checklist, and its step does the step.
      await page.getByRole("button", { name: "Create a suite" }).click();
      const dialog = page.locator("#modal-root .modal");
      const inline = dialog.locator("fieldset.subform");
      await inline.waitFor();

      await dialog.getByLabel("Name").first().fill("Checkout journeys");
      // The same questions the application dialog asks, in the same order —
      // plus the environment, because a suite created here has to be launchable.
      await inline.getByLabel("Name").fill("Checkout Web");
      await inline.getByLabel("Surface").selectOption("web");
      await inline.getByLabel("Where do runs point?").fill("http://127.0.0.1:4173");
      await dialog.getByRole("button", { name: "Create" }).click();
      await page.waitForURL(`${base}/p/${project.key}/suites/checkout-journeys`);
    });

    // One gesture, three records: the application keyed from its own name, its
    // `local` environment, and the suite bound to it.
    const applications = (await api.get(`/projects/${project.key}/applications?include=rings`)).body.items;
    assert.deepEqual(
      applications.map((a: HostedDynamic) => [a.key, a.name, a.driver, a.rings.map((r: HostedDynamic) => [r.key, r.base_url])]),
      [["checkout-web", "Checkout Web", "web", [["local", "http://127.0.0.1:4173"]]]],
    );
    const suites = (await api.get(`/projects/${project.key}/suites`)).body.items;
    assert.deepEqual(suites.map((s: HostedDynamic) => [s.slug, s.application_id]), [["checkout-journeys", applications[0].id]]);
  });
});

test("the new-suite application picker shows only names for every surface", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "todo", name: "Todo" })).body;
    for (const application of [
      { key: "todo-web", name: "Todo Web", driver: "web" },
      { key: "todo-api", name: "Todo API", driver: "api" },
      { key: "todo-ios", name: "Todo iOS", driver: "mobile", platform: "ios" },
      { key: "todo-android", name: "Todo Android", driver: "mobile", platform: "android" },
    ]) {
      await api.post(`/projects/${project.key}/applications`, application);
    }

    await withPage(async (page: HostedDynamic) => {
      await page.goto(`${base}/p/${project.key}`);
      await page.getByRole("button", { name: "Create a suite" }).click();
      const application = page.locator("#modal-root .modal").getByLabel("Application");
      await application.locator("option", { hasText: "Todo Android" }).waitFor({ state: "attached" });
      assert.deepEqual(await application.locator("option").allTextContents(), [
        "Todo Android",
        "Todo API",
        "Todo iOS",
        "Todo Web",
        "＋ Create an application…",
      ]);
    });
  });
});

test("adding an environment asks where runs point, and names it from the answer", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "checkout", name: "Checkout" })).body;
    // Deliberately with no environment: this is the state a person is in one
    // step after creating an application, and the step they are here to finish.
    const application = (await api.post(`/projects/${project.key}/applications`, {
      key: "checkout-web", name: "Checkout Web", driver: "web",
    })).body;

    await withPage(async (page: HostedDynamic) => {
      await page.goto(`${base}/p/${project.key}/applications/${application.key}`);
      await page.getByRole("heading", { name: "Checkout Web", exact: true }).waitFor();
      await page.getByText("Nowhere to launch yet", { exact: true }).waitFor();

      await page.getByRole("button", { name: "+ Add environment" }).click();
      const dialog = page.locator("#modal-root .modal");
      const url = dialog.getByLabel("Where do runs point?");
      await url.waitFor();

      // ONE question. The dialog that this replaced asked seven; nothing else
      // may creep back into the create path.
      assert.equal(await dialog.locator("input, textarea, select").count(), 1);
      // Nothing is guessed before there is anything to guess from.
      assert.equal(await dialog.locator(".env-naming-line").count(), 0);

      // The URL names it, and the name is on screen rather than assumed.
      await url.fill("https://staging.example.com");
      const naming = dialog.locator(".env-naming-line");
      await naming.getByText("staging", { exact: true }).waitFor();
      // …and the loopback note stays away from a URL that is not loopback.
      assert.equal(await dialog.getByText(/claiming runner's own machine/).count(), 0);

      // A person who disagrees with the guess has one control, not a field they
      // had to fill in first.
      await naming.getByRole("button", { name: "Rename" }).click();
      const name = dialog.getByLabel("Called");
      assert.equal(await name.inputValue(), "staging", "the rename control opens on the guess, not empty");
      await name.fill("Staging EU");
      await dialog.getByText("staging-eu").waitFor();

      await dialog.getByRole("button", { name: "Add environment" }).click();
      await dialog.waitFor({ state: "detached" });

      // Stored as the name a person typed, keyed by what it slugs to.
      const rings = (await api.get(`/applications/${application.id}/rings`)).body.items;
      assert.deepEqual(
        rings.map((r: HostedDynamic) => [r.key, r.name, r.base_url]),
        [["staging-eu", "Staging EU", "https://staging.example.com"]],
      );

      // A second local service is an ordinary thing to have, and gets an
      // ordinary name — never a collision refusal.
      await page.getByRole("button", { name: "+ Add environment" }).click();
      const second = page.locator("#modal-root .modal");
      await second.getByLabel("Where do runs point?").fill("http://127.0.0.1:4173");
      await second.locator(".env-naming-line").getByText("local", { exact: true }).waitFor();
      // THIS one is loopback, so THIS one says so.
      await second.getByText(/claiming runner's own machine/).waitFor();
      await second.getByRole("button", { name: "Add environment" }).click();
      await second.waitFor({ state: "detached" });

      await page.getByRole("button", { name: "+ Add environment" }).click();
      const third = page.locator("#modal-root .modal");
      await third.getByLabel("Where do runs point?").fill("http://127.0.0.1:5173");
      await third.locator(".env-naming-line").getByText("local-2", { exact: true }).waitFor();
      await third.getByRole("button", { name: "Cancel" }).click();
    });
  });
});

test("an environment's sign-in identities are edited as rows, and survive save and reopen", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "checkout", name: "Checkout" })).body;
    const { application } = await createTarget(api, project, { key: "checkout-web", name: "Checkout Web" });
    await api.post(`/applications/${application.id}/rings`, { key: "staging", base_url: "https://staging.example.com" });

    await withPage(async (page: HostedDynamic) => {
      await page.goto(`${base}/p/${project.key}/applications/${application.key}`);
      await page.getByRole("heading", { name: "Checkout Web", exact: true }).waitFor();

      // Identities belong to an environment that exists — a provider bound to
      // one cannot even be offered before it does — so this is the edit
      // surface, reached from the environment's own card.
      const card = page.locator("section.card").filter({ hasText: "staging" });
      await card.getByRole("button", { name: `Edit environment ${application.key}/staging` }).click();
      const dialog = page.locator("#modal-root .modal");
      await dialog.getByText("Sign-in", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "+ Add an identity" }).click();
      await dialog.getByLabel("Identity 1 name").fill("member");
      // No provider exists here, so the row offers the two references a runner
      // can resolve on its own; a stored sign-in state is the one being named.
      await dialog.getByLabel(/Identity .* source/).selectOption("secret");
      await dialog.getByLabel(/Identity .* reference/).fill("member-state");

      // The named fields and the overlay are two views of one document, so the
      // row is already in the JSON before anything is saved.
      await dialog.getByText("Advanced", { exact: true }).click();
      const overlay = dialog.locator("textarea.code");
      assert.match(await overlay.inputValue(), /"member":\s*\{\s*"\$secret": "member-state"\s*\}/);

      await dialog.getByRole("button", { name: "Save" }).click();
      await dialog.waitFor({ state: "detached" });

      // The card says who this environment signs in as, by name — the name a
      // story picks with `auth: member`.
      const saved = page.locator("section.card").filter({ hasText: "staging" });
      await saved.getByText("Signs in as", { exact: true }).waitFor();
      await saved.getByText("member", { exact: true }).waitFor();

      // …and reopening the editor shows the same row, not a paragraph of JSON.
      await saved.getByRole("button", { name: `Edit environment ${application.key}/staging` }).click();
      const edit = page.locator("#modal-root .modal");
      await edit.getByText("Sign-in", { exact: true }).waitFor();
      assert.equal(await edit.getByLabel("Identity 1 name").inputValue(), "member");
      assert.equal(await edit.getByLabel(/Identity .* source/).inputValue(), "secret");
      assert.equal(await edit.getByLabel(/Identity .* reference/).inputValue(), "member-state");

      // Placement DEMONSTRATES the matching rule instead of stating it. The
      // sentence this replaced ("runs go to a runner advertising ALL of these
      // labels — that is the whole matching rule") was the longest hint in the
      // dialog and still left a person to work out whether they had such a
      // runner. Now the field answers that question as they type.
      const labels = edit.getByLabel("Runner labels");
      await edit.getByText(/can take these runs/).first().waitFor();
      await labels.fill("macos, ios-sim");
      await edit.getByText("No registered runner advertises all of these — runs here would wait, then fail.").waitFor();
      await labels.fill("");
      await edit.getByText(/can take these runs/).first().waitFor();

      // A row nothing can select is refused HERE, naming what is missing,
      // rather than saved into an environment no story can name.
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
      await edit.getByText("Sign-in", { exact: true }).waitFor();

      // Naming it, but pointing it at nothing, is refused too — and the message
      // says which identity and what would fix it.
      await edit.getByLabel("Identity 2 name").fill("admin");
      await edit.getByRole("button", { name: "Save" }).click();
      await edit.getByText(/“admin” has nothing to sign in with/).waitFor();

      await edit.getByRole("button", { name: "Cancel" }).click();
      await edit.waitFor({ state: "detached" });

      // Nothing was written by a refused save.
      const rings = (await api.get(`/applications/${application.id}/rings`)).body.items;
      const staging = rings.find((r: HostedDynamic) => r.key === "staging");
      assert.deepEqual(staging.config.auth.identities, { member: { $secret: "member-state" } });
    });
  });
});

test("a mobile application says the runner supplies the build, and its environment holds no URL", async () => {
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

      // The environment's "Where" is a sentence about who holds the build,
      // because the platform holds none of it.
      const card = page.locator("section.card").filter({ hasText: ring.key });
      await card.getByText("the claiming runner supplies the build", { exact: true }).waitFor();

      // …and the page answers "where do I set the build, then?" in place,
      // with the runner's own configuration keys.
      await page.getByText("Where the build comes from", { exact: true }).waitFor();
      await page.getByText(/no environment holds them and nothing on this page can set them/).waitFor();
      await page.getByText(/project: <project key>/).waitFor();
      await page.getByText(/application: <application key>/).waitFor();
      await page.getByText(/environment: <environment key>/).waitFor();
      await page.getByText(/app: \/path\/to\/your\/build/).waitFor();
      await page.getByText(/docs\/guidance\/hosted-runners\.md/).first().waitFor();

      // There is no URL to ask for, so the create dialog asks the one thing a
      // person can answer and shows what a runner will have to hold a build for.
      await page.getByRole("button", { name: "+ Add environment" }).click();
      const adding = page.locator("#modal-root .modal");
      assert.equal(await adding.getByLabel("Where do runs point?").count(), 0);
      await adding.getByLabel("Name").fill("device-lab");
      await adding.getByText(`${application.key}/`).waitFor();
      await adding.getByText("device-lab", { exact: true }).waitFor();
      await adding.getByRole("button", { name: "Cancel" }).click();
      await adding.waitFor({ state: "detached" });

      // The editor offers no URL, no build path, no device: a field for a fact
      // the platform cannot hold would be a field that lies.
      await card.getByRole("button", { name: `Edit environment ${application.key}/${ring.key}` }).click();
      const dialog = page.locator("#modal-root .modal");
      await dialog.getByText(/A mobile environment holds no URL, build path, device or Appium endpoint/).waitFor();
      assert.equal(await dialog.getByLabel("URL").count(), 0, "a mobile environment must offer no URL field");
      assert.equal(await dialog.getByLabel("Cookies").count(), 0, "cookies are a web-only environment field");
      await dialog.getByRole("button", { name: "Cancel" }).click();
    });
  });
});
