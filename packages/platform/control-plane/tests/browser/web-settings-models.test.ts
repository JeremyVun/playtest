import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import { withApp } from "../integration/helpers.ts";

/**
 * Settings → Models is a policy form, and the two things a policy form has to
 * get right are the ones a screenshot cannot show: nothing is written until
 * Save, and a setting the chosen policy has stopped using says so instead of
 * looking answerable.
 *
 * The page is organised by job — running a story, duplicate findings, fixed
 * findings — so this drives it the way a person does: by the group heading and
 * the visible answer, never by a class name.
 *
 * Fixed findings is one question with three rungs, and the third thing to get
 * right is that the rung answers BOTH stored knobs: the pair on the wire is
 * still an enable switch and a mode, and the page must pin exactly what the
 * chosen rung means and nothing else.
 */
test("settings → models commits as one draft and shows what closing by hand makes inert", async () => {
  await withApp(async ({ base, api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "checkout", name: "Checkout" })).body;

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });

      await page.goto(`${base}/p/${project.key}/settings/models`);
      await page.getByRole("heading", { name: "Models", exact: true }).waitFor();

      // Three jobs, not seven questions: the group headings are the page's
      // structure and the reason the settings stopped being one flat column.
      for (const group of ["Running a story", "Duplicate findings", "Fixed findings"]) {
        await page.getByRole("heading", { name: group, exact: true }).waitFor();
      }

      // A clean page carries no buttons: nothing has been decided yet.
      const saveBar = page.locator(".savebar");
      await assert.doesNotReject(saveBar.waitFor({ state: "hidden" }));

      // Closing fixed findings is ONE question with three rungs, not a switch
      // plus a mode that only means anything while the switch is on.
      const resolve = page.getByRole("radiogroup", { name: "Closing a finding a later run has fixed" });
      const never = resolve.getByRole("radio", { name: "By hand" });
      const proven = resolve.getByRole("radio", { name: "Semi-automatic" });
      const verified = resolve.getByRole("radio", { name: "Fully automatic" });
      // There is no "Default" button to press: what this deployment does is
      // simply the selected answer, so the control needs no caption saying so.
      assert.equal(await resolve.getByRole("radio").count(), 3);
      assert.equal(await proven.getAttribute("aria-checked"), "true");
      assert.equal(await page.getByText(/deployment default/i).count(), 0);

      await never.click();
      assert.equal(await never.getAttribute("aria-checked"), "true");

      // Closing by hand makes the model that verifies fixes inert, and says
      // why rather than leaving it looking live.
      const verifyModel = page.locator(".field.inert").filter({ hasText: "Fix verification model" });
      await verifyModel.waitFor();
      assert.equal(await page.getByText("Not in use while findings close by hand.").count(), 1);
      // Inert is dimmed, not disabled — it can still be set before it applies.
      assert.equal(await page.getByRole("button", { name: "Fix verification model" }).isEnabled(), true);

      // Nothing is written until Save: the draft is visible, the project is not
      // touched.
      await saveBar.waitFor({ state: "visible" });
      await page.getByText("Unsaved changes", { exact: true }).waitFor();
      assert.equal((await api.get(`/projects/${project.key}`)).body.auto_resolve ?? null, null);

      // Answering with what the deployment already says is an undo, not a
      // decision to pin: the draft empties and the project keeps following it.
      // One click answers both stored knobs, so both have to come back to null.
      await proven.click();
      await saveBar.waitFor({ state: "hidden" });
      assert.equal(await page.locator(".field.inert").count(), 0);

      // Discard puts the page back to what the server still says.
      await never.click();
      await saveBar.waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Discard changes" }).click();
      await saveBar.waitFor({ state: "hidden" });
      assert.equal(await proven.getAttribute("aria-checked"), "true");
      assert.equal(await page.locator(".field.inert").count(), 0);

      // What no rung can state without saying it three times, and what people
      // get wrong when it goes unsaid: the ladder reaches findings a person has
      // already confirmed, and a live ticket is the only exemption. True on
      // every rung that closes anything, and only there.
      const ticketNote = page.getByText(/findings you have confirmed, too/);
      await ticketNote.waitFor();
      assert.match(await ticketNote.textContent() ?? "", /linked to a ticket/);
      await never.click();
      await ticketNote.waitFor({ state: "hidden" });
      await proven.click();

      // Turning the sweep on reaches findings that are already filed, which is
      // the one consequence "On" does not imply — so it is said only then.
      const dedupe = page.getByRole("radiogroup", { name: "Automatic dedupe" });
      const sweepNote = page.getByText("Saving this also sweeps the findings already queued.");
      assert.equal(await sweepNote.count(), 0);
      await dedupe.getByRole("radio", { name: "On" }).click();
      await sweepNote.waitFor();
      await dedupe.getByRole("radio", { name: "Off" }).click();
      await sweepNote.waitFor({ state: "hidden" });

      // One Save commits every group's pending answer together — a model
      // dropdown in the first group and a policy rung in the third.
      await page.getByRole("button", { name: "Actor model" }).click();
      await page.locator(".select-menu").getByRole("option", { name: "opus", exact: true }).click();
      await never.click();
      await page.getByRole("button", { name: "Save", exact: true }).click();

      await page.getByText("Settings saved", { exact: true }).waitFor();
      await saveBar.waitFor({ state: "hidden" });

      const saved = (await api.get(`/projects/${project.key}`)).body;
      assert.equal(saved.models?.actor_model, "opus");
      assert.equal(saved.auto_resolve, false);
      // Untouched keys stay untouched — a save is the draft, not the whole form.
      assert.equal(saved.auto_dedupe ?? null, null);
      assert.equal(saved.models?.grader_model ?? null, null);
      // The rung answers both stored knobs, and "by hand" is not an answer
      // about the mode: it must not pin one nobody chose.
      assert.equal(saved.auto_resolve_mode ?? null, null);

      // Fully automatic is one click, and it writes the mode the old page
      // needed a second control for.
      await verified.click();
      await saveBar.waitFor({ state: "visible" });
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await saveBar.waitFor({ state: "hidden" });
      const widened = (await api.get(`/projects/${project.key}`)).body;
      assert.equal(widened.auto_resolve, true);
      assert.equal(widened.auto_resolve_mode, "full");

      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
});
