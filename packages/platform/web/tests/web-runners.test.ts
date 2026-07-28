// Settings → Runners, the launch dialog's placement line, and the words a
// placement failure gets. These modules are DOM-free on purpose (siblings of
// web-ia.test.ts), so the offline gate can pin what a runner surface lives or
// dies on: the exact command a person pastes, that the credential is a genuine
// one-time reveal, that presence is derived rather than polled for, and that a
// run nothing can claim says so BEFORE anyone spends money on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startCommand, oneShot, runnerLabelsText, runnerPresence, labelsMatch,
  placementReadiness, poolPlacementCause, labelProblem, parseLabels,
} from "../src/lib/runners.js";
import { SETTINGS_SECTIONS, visibleSections } from "../src/lib/settings-sections.js";
import { ago } from "../src/lib/labels.js";

const POOLED = { pool_dispatch: true };

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

test("runners: a label the start command could not carry is refused in the form", () => {
  // The field is comma separated, so a comma inside a label is not a label with
  // a comma in it — it is two labels, silently, all the way down to the agent's
  // `--labels`. And the command is pasted into a shell, where a space or a
  // metacharacter is worse than a typo.
  assert.deepEqual(parseLabels(" macos , ios-sim ,, macos "), ["macos", "ios-sim"]);
  assert.equal(labelProblem(["macos", "ios-sim", "ci-run-1234567", "node_20", "macos.14"]), null);
  assert.equal(labelProblem([]), null);
  for (const bad of ["ios sim", "pool:checkout", "$(whoami)", "it's", "a/b"]) {
    const problem = labelProblem([bad]);
    assert.ok(problem, `${bad} must be caught before the round trip`);
    assert.ok(problem.includes(bad), problem);
    assert.match(problem, /letters, digits/);
  }
  assert.match(labelProblem(Array.from({ length: 33 }, (_, i) => `l${i}`))!, /at most 32 labels/);
  assert.match(labelProblem(["x".repeat(65)])!, /at most 64 characters/);
  // The command a conforming label produces is unchanged.
  assert.equal(
    startCommand({ server: "https://playtest.example.com", credential: "ptr_x", labels: parseLabels("macos, ios-sim") }),
    "PLAYTEST_RUNNER_CREDENTIAL='ptr_x' ./node_modules/.bin/runner-agent pool --server https://playtest.example.com --labels macos,ios-sim",
  );
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

test("runners: presence is derived from the last check-in, never from a poll", () => {
  const now = Date.parse("2026-07-27T12:00:00Z");
  const at = (secondsAgo: WebDynamic) => new Date(now - secondsAgo * 1000).toISOString();
  const p = (runner: WebDynamic) => runnerPresence(runner, { now, windowS: 120 });

  assert.equal(p({ last_seen_at: at(10) }).state, "online");
  assert.equal(p({ last_seen_at: at(10) }).tone, "on");
  // A runner executing a group heartbeats instead of polling; both are check-ins.
  const busy = p({ last_seen_at: at(20), claim: { run_group_id: "g1" } });
  assert.equal(busy.state, "working");
  assert.equal(busy.tone, "busy");
  // Silence past the window the SERVER publishes is what offline means — the
  // clock alone produces it, with no request and no timer talking to anybody.
  const gone = p({ last_seen_at: at(600) });
  assert.equal(gone.state, "offline");
  assert.equal(gone.tone, "off");
  assert.match(gone.detail, /nothing heard/);
  // A registration nobody has started is not "offline" — it has never run, and
  // the remedy is the start command rather than a health check.
  assert.equal(p({}).state, "never");
  assert.match(p({}).detail, /has not checked in yet/);
  // Revoked and expired outrank presence: a credential that stopped working is
  // not a machine that is merely quiet.
  assert.equal(p({ last_seen_at: at(5), revoked_at: at(1) }).state, "revoked");
  assert.equal(p({ last_seen_at: at(5), expires_at: at(1) }).state, "expired");
  // The window is the server's, so a deployment that waits longer says so.
  assert.equal(runnerPresence({ last_seen_at: at(300) }, { now, windowS: 600 }).state, "online");
  // Every state carries a word as well as a tone — colour is never alone.
  for (const state of [{}, { last_seen_at: at(10) }, { last_seen_at: at(600) }, { revoked_at: at(1) }]) {
    assert.ok(p(state).label.length > 2 && p(state).detail.length > 10);
  }
});

test("runners: label matching is the claim board's subset rule, restated", () => {
  assert.equal(labelsMatch(["macos"], ["macos", "ios-sim"]), true);
  assert.equal(labelsMatch(["macos", "ios-sim"], ["macos"]), false, "every label the job wants must be advertised");
  assert.equal(labelsMatch([], ["macos"]), true, "no labels means any runner in the project");
  assert.equal(labelsMatch(["macos"], []), false);
  assert.equal(labelsMatch(null, null), true);
});

test("launch: a run nothing can claim says so before it is launched", () => {
  const now = Date.parse("2026-07-27T12:00:00Z");
  const fresh = new Date(now - 10_000).toISOString();
  const stale = new Date(now - 900_000).toISOString();
  const read = (labels: WebDynamic, runners: WebDynamic) => placementReadiness({ labels, runners, now, windowS: 120 });

  // The green path names the machine, so "it will run" is a fact, not a hope.
  const ready = read(["macos"], [{ name: "adas-mac", labels: ["macos", "ios-sim"], last_seen_at: fresh }]);
  assert.equal(ready.state, "ready");
  assert.match(ready.message, /adas-mac/);

  // A project with no runners at all: the remedy is registration, and the
  // sentence says the run would WAIT and then FAIL rather than "unavailable".
  const empty = read(["macos"], []);
  assert.equal(empty.state, "empty");
  assert.match(empty.message, /Settings → Runners/);
  assert.match(empty.message, /waits on the board and then fails/);

  // Registered, but nothing advertises what this environment asks for — the
  // exact shape of the unclaimed-timeout failure, predicted.
  const unmatched = read(["ios-sim"], [{ name: "linux-box", labels: ["linux"], last_seen_at: fresh }]);
  assert.equal(unmatched.state, "unmatched");
  assert.match(unmatched.message, /“ios-sim”/);
  assert.match(unmatched.message, /waits on the board and then fails/);

  // Matching, but nobody is home: the machine exists, the process does not.
  const asleep = read(["macos"], [{ name: "adas-mac", labels: ["macos"], last_seen_at: stale }]);
  assert.equal(asleep.state, "asleep");
  assert.match(asleep.message, /adas-mac/);
  assert.match(asleep.message, /Start the runner process/);

  // Busy is not a warning: it is a queue, and it resolves itself.
  const busy = read(["macos"], [{ name: "adas-mac", labels: ["macos"], last_seen_at: fresh, claim: { run_group_id: "g1" } }]);
  assert.equal(busy.state, "busy");
  assert.match(busy.message, /waits its turn/);

  // A revoked runner is not a runner. It must never make a launch look placeable.
  assert.equal(read(["macos"], [{ name: "old", labels: ["macos"], last_seen_at: fresh, revoked_at: fresh }]).state, "empty");
  // No labels asked for: any live runner will do.
  assert.equal(read([], [{ name: "any", labels: [], last_seen_at: fresh }]).state, "ready");
});

test("runs: a placement failure is recognised, so the remedy can be the runner", () => {
  // The four sentences the pool adapter writes onto the stories that never ran.
  assert.deepEqual(
    poolPlacementCause("no runner has checked in for 10 minutes — this deployment places runs on self-hosted runners, and this project has none registered."),
    { kind: "no-runners", labels: [] });
  const unmatched = poolPlacementCause(
    'no runner with the labels "macos", "ios-sim" has checked in for 10 minutes — 2 runners are registered in this project.');
  assert.deepEqual(unmatched, { kind: "unmatched", labels: ["macos", "ios-sim"] });
  assert.deepEqual(
    poolPlacementCause('no runner with the label "jeremys-mac" has checked in for 10 minutes — 1 runner is registered'),
    { kind: "unmatched", labels: ["jeremys-mac"] });
  assert.equal(poolPlacementCause('no runner claimed this run for 10 minutes — 1 eligible runner is registered')?.kind, "idle");
  assert.equal(poolPlacementCause('runner "adas-mac" claimed this run and stopped checking in 300s ago')?.kind, "lost");
  // Everything else is an ordinary infrastructure failure and keeps its own
  // explanation — a connection refusal must not offer to go set up a runner.
  assert.equal(poolPlacementCause("connect ECONNREFUSED 127.0.0.1:4173"), null);
  assert.equal(poolPlacementCause(null), null);
});

test("runners: the section is a developer surface on a deployment that HAS a pool", () => {
  const ids = SETTINGS_SECTIONS.map((s: WebDynamic) => s.id);
  assert.deepEqual(ids, ["test-targets", "runners", "runs", "models", "team", "audit"]);
  const runners = SETTINGS_SECTIONS.find((s: WebDynamic) => s.id === "runners");
  assert.equal(runners.min, "developer", "registering a runner is a developer act, like the environment it serves");
  assert.equal(runners.label, "Runners");
  // A viewer cannot register or revoke, so the section is not offered at all.
  assert.equal(visibleSections((min: WebDynamic) => min === "viewer", POOLED).some((s: WebDynamic) => s.id === "runners"), false);
  assert.equal(visibleSections(() => true, POOLED).some((s: WebDynamic) => s.id === "runners"), true);
  // And under any other placement adapter there is no board to claim from, so
  // the whole surface is absent rather than present and then explained away.
  assert.equal(visibleSections(() => true, { pool_dispatch: false }).some((s: WebDynamic) => s.id === "runners"), false);
  assert.equal(visibleSections(() => true).some((s: WebDynamic) => s.id === "runners"), false);
});
