// Applications and rings, as the console models them. Both are DOM-free
// modules so the offline gate can hold them to the rules that actually matter:
// a key is permanent and a collision is named before anything is created, a
// ring's URL is required for web/API and refused for mobile, the five physical
// fields are unrepresentable in a ring's overlay, and the picker never opens on
// production.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DRIVERS, PLATFORMS, driverLabel, driverGist, applicationLine, keyFromName, keyProblem,
  ringUrlProblem, ringConfigProblem, ringOptionLabel, isProdRing, defaultRingId,
  launchTargetWords, hostOf, PHYSICAL_APP_KEYS, LOGICAL_APP_KEYS,
} from "../src/lib/rings.js";
import { initialDefaultsYaml } from "../src/lib/defaults-form.js";

test("application: the three surfaces each read as themselves", () => {
  assert.deepEqual([...DRIVERS], ["web", "api", "mobile"]);
  assert.deepEqual([...PLATFORMS], ["ios", "android"]);
  for (const d of DRIVERS) {
    assert.ok(driverLabel(d) && !driverLabel(d).includes("_"), d);
    assert.ok(driverGist(d).length > 20, `${d} needs a sentence, not a token`);
  }
  assert.equal(applicationLine({ key: "todo-ios", driver: "mobile", platform: "ios" }), "todo-ios · mobile · ios");
  assert.equal(applicationLine({ key: "todo-web", driver: "web", platform: null }), "todo-web · web");
});

test("application: a key is suggested from the name, and shaped like the server's", () => {
  assert.equal(keyFromName("Todo Web"), "todo-web");
  assert.equal(keyFromName("  Checkout — Journeys!  "), "checkout-journeys");
  assert.equal(keyFromName("###"), "");
  assert.equal(keyProblem(keyFromName("Todo Web"), []), null);
});

test("application: a key is permanent, so a bad one is refused before it exists", () => {
  // Shape first — the server's own KEY_RE, said in words a person can act on.
  assert.match(String(keyProblem("", [])), /give this application a key/i);
  assert.match(String(keyProblem("Todo Web", [])), /lowercase letters, digits and hyphens/);
  assert.match(String(keyProblem("-leading", [])), /lowercase letters, digits and hyphens/);
  // A collision NAMES what is in the way, in the scope that owns it.
  assert.match(String(keyProblem("todo-web", [{ key: "todo-web" }])), /already has an application keyed “todo-web”/);
  assert.match(
    String(keyProblem("local", [{ key: "local" }], { kind: "ring", scope: "Application “todo-web”" })),
    /Application “todo-web” already has a ring keyed “local”/,
  );
  // A key that only permanence makes dangerous still says so.
  assert.match(String(keyProblem("", [], { kind: "ring" })), /for good/);
});

test("ring: a URL is required for web and API, and refused for mobile", () => {
  assert.equal(ringUrlProblem("https://staging.example.com", "web"), null);
  assert.equal(ringUrlProblem("http://127.0.0.1:4173", "api"), null);
  // The runner's network position is the stated semantic, so the empty-field
  // message is where a person learns what a loopback URL means.
  assert.match(String(ringUrlProblem("", "web")), /claiming runner's network position/);
  assert.match(String(ringUrlProblem("staging.example.com", "web")), /isn't a URL/);
  assert.match(String(ringUrlProblem("ftp://example.com", "web")), /http:\/\/ or https:\/\//);
  // Mobile holds no URL at all, and the refusal says who does hold the facts.
  assert.equal(ringUrlProblem("", "mobile"), null);
  assert.match(String(ringUrlProblem("https://example.com", "mobile")), /own configuration file/);
});

test("ring: the overlay is an allowlist, so the physical five are unrepresentable", () => {
  assert.equal(ringConfigProblem({}), null);
  assert.equal(ringConfigProblem(null), null);
  assert.equal(ringConfigProblem({ auth: { identities: { member: { $session: "sso/member" } }, default: "member" } }), null);
  assert.equal(ringConfigProblem({ secret_env: { TOKEN: { $secret: "staging" } } }), null);
  for (const key of LOGICAL_APP_KEYS) {
    assert.equal(ringConfigProblem({ app: { [key]: {} } }), null, key);
  }
  // The URL has a first-class home, so its overlay position points at it.
  assert.match(String(ringConfigProblem({ app: { base_url: "https://x.test" } })), /its own URL field/);
  // The mobile trio names who resolves it rather than merely refusing.
  for (const key of PHYSICAL_APP_KEYS.filter((k) => k !== "base_url")) {
    assert.match(String(ringConfigProblem({ app: { [key]: "x" } })), /claiming runner resolves/, key);
  }
  assert.match(String(ringConfigProblem({ app: { compose: {} } })), /boot a different application/);
  assert.match(String(ringConfigProblem({ app: { driver: "web" } })), /the application's/);
  assert.match(String(ringConfigProblem({ app: { envs: {} } })), /cannot nest another/);
  assert.match(String(ringConfigProblem({ nope: {} })), /not part of a ring's configuration/);
  assert.match(String(ringConfigProblem({ auth: { providers: {} } })), /not part of a ring's authorization/);
  assert.match(String(ringConfigProblem({ app: [] })), /must be an object/);
  assert.match(String(ringConfigProblem([])), /must be a JSON object/);
  // The allowlist is applied at ONE depth. Data that merely happens to be named
  // `device` or `app` deeper down is legitimate and must survive.
  assert.equal(ringConfigProblem({ auth: { identities: { device: {}, app: {} } } }), null);
  assert.equal(ringConfigProblem({ secret_env: { appium_url: { $secret: "s" } } }), null);
});

test("launch: a ring option names the host it resolves to", () => {
  assert.equal(hostOf("https://staging.acme.test/path"), "staging.acme.test");
  assert.equal(hostOf("http://127.0.0.1:4173"), "127.0.0.1:4173", "the port carries the meaning between two local services");
  assert.equal(hostOf(null), "");
  assert.equal(
    ringOptionLabel({ key: "staging", base_url: "https://staging.acme.test", discovery_allowed: true }),
    "staging · staging.acme.test · discovery",
  );
  assert.equal(ringOptionLabel({ key: "prod", base_url: "https://acme.test" }), "prod · acme.test");
  // A mobile ring has no URL to name, so it says who supplies the build.
  assert.equal(ringOptionLabel({ key: "local" }, "mobile"), "local · build from the runner");
});

test("launch: the picker never opens on production unless production is all there is", () => {
  const local = { id: "r1", key: "local", base_url: "http://127.0.0.1:4173" };
  const staging = { id: "r2", key: "staging", base_url: "https://staging.test", discovery_allowed: true };
  const prod = { id: "r3", key: "prod", base_url: "https://acme.test" };
  assert.ok(isProdRing(prod));
  assert.ok(isProdRing({ key: "prod-eu" }));
  assert.ok(isProdRing({ key: "eu", name: "Production" }));
  assert.ok(!isProdRing(local));

  // Where this suite last ran wins — that is the answer a person means.
  assert.equal(defaultRingId([local, staging, prod], {
    suiteId: "s1",
    groups: [{ suite_id: "s1", ring_id: "r3" }],
  }), "r3");
  // A group for ANOTHER suite is not this suite's history.
  assert.equal(defaultRingId([local, staging, prod], {
    suiteId: "s1",
    groups: [{ suite_id: "s2", ring_id: "r3" }],
  }), "r2", "discovery-allowed, non-production, comes next");
  assert.equal(defaultRingId([local, prod], { suiteId: "s1" }), "r1");
  // Production alone is still offered — refusing to choose would be worse.
  assert.equal(defaultRingId([prod], { suiteId: "s1" }), "r3");
  assert.equal(defaultRingId([], { suiteId: "s1" }), "");
});

test("launch: the target line is the ring's URL, or who supplies the build", () => {
  const web = launchTargetWords({
    application: { key: "todo-web", driver: "web", platform: null },
    ring: { key: "staging" },
    resolved_base_url: "https://staging.acme.test",
    build_supplied_by_runner: false,
  });
  assert.equal(web.where, "https://staging.acme.test");
  assert.equal(web.source, "todo-web / staging");

  // Mobile: the platform never inspects a binary, so it never claims to.
  const mobile = launchTargetWords({
    application: { key: "todo-ios", driver: "mobile", platform: "ios" },
    ring: { key: "local" },
    resolved_base_url: null,
    build_supplied_by_runner: true,
  });
  assert.equal(mobile.where, "the build the claiming runner supplies");
  assert.equal(mobile.source, "todo-ios / local · ios");

  // A ring with no URL is a warning, not a lie.
  assert.equal(launchTargetWords({ ring: { key: "local" }, application: { key: "a" } }).where, "no URL on this ring");
  assert.equal(launchTargetWords(null).where, "no URL on this ring");
});

test("new suite: the dialog commits the transport only — never a target", () => {
  // A suite runs against its application's ring, and hosted execution applies
  // that ring's URL after the authored merge, so a URL written here would be
  // the value that loses.
  assert.equal(initialDefaultsYaml({ driver: "web" }), "");
  assert.equal(initialDefaultsYaml({ driver: "mobile" }), "app:\n  driver: mobile\n");
  assert.equal(initialDefaultsYaml({ driver: "api" }), "app:\n  driver: api\n");
});
