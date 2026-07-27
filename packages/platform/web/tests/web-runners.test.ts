// Settings → Runners, the minimal R1 surface. These modules are DOM-free on
// purpose (siblings of web-ia.test.ts), so the offline gate can pin the two
// properties a runner surface lives or dies on: the exact command a person
// pastes, and that the credential is a genuine one-time reveal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startCommand, oneShot, runnerLabelsText } from "../src/lib/runners.js";
import { SETTINGS_SECTIONS, visibleSections } from "../src/lib/settings-sections.js";
import { ago } from "../src/lib/labels.js";

test("runners: registering yields one pasteable command, and the credential never rides argv", () => {
  const command = startCommand({
    server: "https://playtest.example.com/",
    credential: "ptr_2vT7lqf",
    labels: ["macos", "ios-sim"],
  });
  assert.equal(
    command,
    "PLAYTEST_RUNNER_CREDENTIAL='ptr_2vT7lqf' ./node_modules/.bin/runner-agent pool --server https://playtest.example.com --labels macos,ios-sim",
  );
  // The secret is an environment assignment, never an argument: it must not be
  // readable from another user's `ps` on that machine.
  const args = command.slice(command.indexOf("./node_modules")).split(" ");
  assert.equal(args.some((a) => a.includes("ptr_")), false, command);
  // A runner that advertises nothing takes any of its project's work, and the
  // command says nothing about labels rather than passing an empty flag.
  assert.equal(
    startCommand({ server: "http://127.0.0.1:4177", credential: "ptr_x" }),
    "PLAYTEST_RUNNER_CREDENTIAL='ptr_x' ./node_modules/.bin/runner-agent pool --server http://127.0.0.1:4177",
  );
  assert.match(startCommand({ server: "http://h", credential: "ptr_x", isolation: "container" }), /--isolation container$/);
});

test("runners: the credential is revealed exactly once and is never retrievable again", () => {
  const secret = oneShot("ptr_2vT7lqf");
  assert.equal(secret.spent(), false);
  assert.equal(secret.take(), "ptr_2vT7lqf");
  // A re-render, a reopened dialog, a back button: all get nothing, because the
  // server stores only a hash and cannot show it again either.
  assert.equal(secret.take(), null);
  assert.equal(secret.take(), null);
  assert.equal(secret.spent(), true);
});

test("runners: a listed runner reads as its labels and when it last checked in", () => {
  assert.equal(runnerLabelsText(["macos", "ios-sim"]), "macos, ios-sim");
  // An unlabelled runner is not "—": it means something specific, so say it.
  assert.equal(runnerLabelsText([]), "any job in this project");
  assert.equal(runnerLabelsText(null), "any job in this project");

  // Last-seen uses the console's one relative-time vocabulary.
  assert.equal(ago(new Date(Date.now() - 30_000).toISOString()), "just now");
  assert.equal(ago(new Date(Date.now() - 5 * 60_000).toISOString()), "5 min ago");
  assert.equal(ago(null), "—", "a runner that never checked in has no time to show");
});

test("runners: the section is a developer surface, listed beside the targets it serves", () => {
  const ids = SETTINGS_SECTIONS.map((s: WebDynamic) => s.id);
  assert.deepEqual(ids, ["test-targets", "runners", "runs", "models", "team", "audit"]);
  const runners = SETTINGS_SECTIONS.find((s: WebDynamic) => s.id === "runners");
  assert.equal(runners.min, "developer", "registering a runner is a developer act, like the environment it serves");
  assert.equal(runners.label, "Runners");
  // A viewer cannot register or revoke, so the section is not offered at all.
  assert.equal(visibleSections((min: WebDynamic) => min === "viewer").some((s: WebDynamic) => s.id === "runners"), false);
  assert.equal(visibleSections(() => true).some((s: WebDynamic) => s.id === "runners"), true);
});
