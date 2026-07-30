// Applications and environments, as the console models them. Both are DOM-free
// modules so the offline gate can hold them to the rules that actually matter:
// a URL names the environment it points at, a key is permanent and a collision
// is named before anything is created, an environment's URL is required for
// web/API and refused for mobile, the five physical fields are unrepresentable
// in its overlay, and the picker never opens on production.
//
// The console prints "environment" and the wire says `ring`; these modules are
// the seam, so the assertions here are on the words a person reads.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DRIVERS, PLATFORMS, driverLabel, driverGist, applicationPickerLabel, keyFromName, keyProblem,
  ringUrlProblem, ringConfigProblem, ringOptionLabel, isProdRing, defaultRingId,
  environmentKeyFromUrl, isLoopbackUrl,
  launchTargetWords, hostOf, PHYSICAL_APP_KEYS, LOGICAL_APP_KEYS,
  identityRows, identityValue, withIdentities, identityProblem, sessionRefOptions,
} from "../src/lib/rings.js";
import { initialDefaultsYaml } from "../src/lib/defaults-form.js";

test("application: the three surfaces each describe themselves", () => {
  assert.deepEqual([...DRIVERS], ["web", "api", "mobile"]);
  assert.deepEqual([...PLATFORMS], ["ios", "android"]);
  for (const d of DRIVERS) {
    assert.ok(driverLabel(d) && !driverLabel(d).includes("_"), d);
    assert.ok(driverGist(d).length > 20, `${d} needs a sentence, not a token`);
  }
});

test("application: the suite picker shows only the name for every surface", () => {
  assert.equal(applicationPickerLabel({ key: "todo-web", name: "Todo Web" }), "Todo Web");
  assert.equal(applicationPickerLabel({ key: "todo-api", name: "Todo API" }), "Todo API");
  assert.equal(applicationPickerLabel({ key: "todo-ios", name: "Todo iOS" }), "Todo iOS");
  assert.equal(applicationPickerLabel({ key: "todo-android", name: "Todo Android" }), "Todo Android");
  assert.equal(applicationPickerLabel({ key: "legacy-app" }), "legacy-app");
});

test("application: a key is suggested from the name, and shaped like the server's", () => {
  assert.equal(keyFromName("Todo Web"), "todo-web");
  assert.equal(keyFromName("  Checkout — Journeys!  "), "checkout-journeys");
  assert.equal(keyFromName("###"), "");
  assert.equal(keyProblem(keyFromName("Todo Web"), []), null);
});

test("application: a key is permanent, so a bad one is refused before it exists", () => {
  // Shape first — the server's own KEY_RE, said in words a person can act on.
  assert.match(String(keyProblem("", [])), /give this application a name/i);
  assert.match(String(keyProblem("Todo Web", [])), /lowercase letters, digits and hyphens/);
  assert.match(String(keyProblem("-leading", [])), /lowercase letters, digits and hyphens/);
  // A collision NAMES what is in the way, in the scope that owns it.
  assert.match(String(keyProblem("todo-web", [{ key: "todo-web" }])), /already has an application keyed “todo-web”/);
  assert.match(
    String(keyProblem("local", [{ key: "local" }], { kind: "environment", scope: "Application “todo-web”" })),
    /Application “todo-web” already has an environment keyed “local”/,
  );
  // A key that only permanence makes dangerous still says so.
  assert.match(String(keyProblem("", [], { kind: "environment" })), /for good/);
  // Nothing a person reads says "ring" — that word belongs to the schema.
  for (const message of [
    keyProblem("", [], { kind: "environment" }),
    keyProblem("Local", [], { kind: "environment" }),
    keyProblem("local", [{ key: "local" }], { kind: "environment", scope: "Application “x”" }),
    ringUrlProblem("", "web"),
    ringUrlProblem("https://x.test", "mobile"),
    ringConfigProblem({ nope: {} }),
    ringConfigProblem({ app: { device: "x" } }),
  ]) {
    assert.doesNotMatch(String(message), /\bring\b/i, String(message));
  }
});

test("environment: the URL names the environment, so nobody is asked twice", () => {
  // The two a person actually types, read straight off the host.
  assert.equal(environmentKeyFromUrl("http://127.0.0.1:4173"), "local");
  assert.equal(environmentKeyFromUrl("http://localhost:3000"), "local");
  assert.equal(environmentKeyFromUrl("https://staging.example.com"), "staging");
  // A deployment word anywhere in the host, on a label boundary.
  assert.equal(environmentKeyFromUrl("https://gss-staging.acme.io"), "staging");
  assert.equal(environmentKeyFromUrl("https://pr-42.preview.acme.dev"), "preview");
  assert.equal(environmentKeyFromUrl("https://acme-uat.example"), "uat");
  // Longest first: `production.acme.com` is production, not prod.
  assert.equal(environmentKeyFromUrl("https://production.acme.com"), "production");
  assert.equal(environmentKeyFromUrl("https://prod.acme.com"), "prod");
  // …and never a substring: `latest` is not a test environment.
  assert.equal(environmentKeyFromUrl("https://latest.acme.com"), "production");
  // Anything unnamed is production — the safe direction to guess in, because a
  // wrong "production" costs a rename while a wrong anything-else hides the
  // warning that matters.
  assert.equal(environmentKeyFromUrl("https://acme.com"), "production");
  assert.equal(environmentKeyFromUrl("https://checkout.acme.com"), "production");
  // A taken key is a suffix, never a refusal: two local services are ordinary.
  assert.equal(environmentKeyFromUrl("http://127.0.0.1:5173", [{ key: "local" }]), "local-2");
  assert.equal(environmentKeyFromUrl("http://127.0.0.1:6173", [{ key: "local" }, { key: "local-2" }]), "local-3");
  // Nothing to derive from yet — the form shows no name rather than a guess.
  assert.equal(environmentKeyFromUrl(""), "");
  assert.equal(environmentKeyFromUrl("https:/"), "");
  assert.equal(environmentKeyFromUrl("not a url"), "");
});

test("environment: a loopback URL is the one surprising rule, so it is detectable", () => {
  // The note this drives ("resolved on the claiming runner's own machine") is
  // shown under the URL it is true of, and nowhere else.
  for (const url of ["http://127.0.0.1:4173", "http://localhost:3000", "http://[::1]:8080", "http://mac.local:4173"]) {
    assert.equal(isLoopbackUrl(url), true, url);
  }
  for (const url of ["https://staging.acme.test", "https://127.0.0.1.example.com", "", null]) {
    assert.equal(isLoopbackUrl(url), false, String(url));
  }
});

test("environment: a URL is required for web and API, and refused for mobile", () => {
  assert.equal(ringUrlProblem("https://staging.example.com", "web"), null);
  assert.equal(ringUrlProblem("http://127.0.0.1:4173", "api"), null);
  // Short, because it is a refusal and not a lecture: what a loopback URL means
  // is `isLoopbackUrl`'s note, shown under a URL that actually is one.
  assert.match(String(ringUrlProblem("", "web")), /Add the URL that runs here point at/);
  assert.match(String(ringUrlProblem("staging.example.com", "web")), /isn't a URL/);
  assert.match(String(ringUrlProblem("ftp://example.com", "web")), /http:\/\/ or https:\/\//);
  // Mobile holds no URL at all, and the refusal says who does hold the facts.
  assert.equal(ringUrlProblem("", "mobile"), null);
  assert.match(String(ringUrlProblem("https://example.com", "mobile")), /supplies the build/);
});

test("environment: the overlay is an allowlist, so the physical five are unrepresentable", () => {
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
  assert.match(String(ringConfigProblem({ nope: {} })), /not part of an environment's configuration/);
  assert.match(String(ringConfigProblem({ auth: { providers: {} } })), /not part of an environment's authorization/);
  assert.match(String(ringConfigProblem({ app: [] })), /must be an object/);
  assert.match(String(ringConfigProblem([])), /must be a JSON object/);
  // The allowlist is applied at ONE depth. Data that merely happens to be named
  // `device` or `app` deeper down is legitimate and must survive.
  assert.equal(ringConfigProblem({ auth: { identities: { device: {}, app: {} } } }), null);
  assert.equal(ringConfigProblem({ secret_env: { appium_url: { $secret: "s" } } }), null);
});

test("identities: the three shapes a person authors are recognized, and anything else is admitted", () => {
  const rows = identityRows({
    auth: {
      default: "member",
      identities: {
        member: { $session: "sso/member" },          // a session a provider mints
        legacy: "$session:sso/admin",                 // …and its older string form
        stored: { $secret: "member-state" },          // a stored storage-state secret
        onDisk: ".playtest-env/member.json",          // a path the runner already has
        weird: { cookies: [{ name: "sid" }] },        // a shape this form doesn't edit
      },
    },
  });
  assert.deepEqual(rows.map((r) => [r.name, r.kind, r.ref]), [
    ["member", "session", "sso/member"],
    ["legacy", "session", "sso/admin"],
    ["stored", "secret", "member-state"],
    ["onDisk", "path", ".playtest-env/member.json"],
    ["weird", "custom", ""],
  ]);
  // Stored order is presentation order — a re-render must not shuffle rows a
  // person is typing into.
  assert.deepEqual(rows.map((r) => r.name), ["member", "legacy", "stored", "onDisk", "weird"]);
  // Nothing declared, and nothing to misread as a declaration.
  for (const cfg of [null, {}, { auth: {} }, { auth: { identities: null } }, { auth: { identities: [] } }]) {
    assert.deepEqual(identityRows(cfg), [], JSON.stringify(cfg));
  }
});

test("identities: every row writes back what it read, and a custom one verbatim", () => {
  const stored = {
    member: { $session: "sso/member" },
    stored: { $secret: "member-state" },
    onDisk: ".playtest-env/member.json",
    weird: { cookies: [{ name: "sid", value: "x" }] },
  };
  const rows = identityRows({ auth: { identities: stored } });
  // Round trip: read the stored map, write it back untouched. The legacy string
  // form is the ONE deliberate normalization — it means the same thing.
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.name, identityValue(r)])), stored);
  assert.deepEqual(identityValue({ name: "legacy", kind: "session", ref: "sso/admin", value: "$session:sso/admin" }), { $session: "sso/admin" });
  // A shape the form cannot edit survives BECAUSE it is carried, not rebuilt.
  const custom = rows.find((r) => r.name === "weird");
  assert.equal(identityValue(custom!), stored.weird, "a custom row hands back the very object it was given");
});

test("identities: the form writes into the one document, never a fresh one", () => {
  const doc = {
    app: { storage_state: ".playtest-env/state.json" },
    secret_env: { TOKEN: { $secret: "staging" } },
    auth: { default: "member", identities: { member: { $secret: "old" } } },
  };
  const out = withIdentities(doc, [
    { name: "member", kind: "session", ref: "sso/member", value: null },
    { name: "admin", kind: "secret", ref: "admin-state", value: null },
  ]);
  // Keys no field knows about are carried, not re-derived — the same discipline
  // the suite-defaults editor keeps with YAML.
  assert.equal(out.app, doc.app, "an untouched branch is the same object");
  assert.equal(out.secret_env, doc.secret_env);
  assert.deepEqual(out.auth, {
    default: "member",
    identities: { member: { $session: "sso/member" }, admin: { $secret: "admin-state" } },
  }, "auth.default belongs to the ring, not to the identity editor");
  // …and the input document is not mutated under the caller.
  assert.deepEqual(doc.auth.identities, { member: { $secret: "old" } });

  // Removing the last identity removes the map; removing the last thing in
  // `auth` removes `auth`, so an empty editor leaves no empty scaffolding for
  // the overlay allowlist to complain about.
  assert.deepEqual(withIdentities({ auth: { identities: { member: "x" } } }, []), {});
  assert.deepEqual(withIdentities({ auth: { default: "member", identities: { member: "x" } } }, []), { auth: { default: "member" } });
  assert.deepEqual(withIdentities(null, []), {});
  assert.deepEqual(withIdentities(undefined, [{ name: "member", kind: "path", ref: "s.json", value: null }]),
    { auth: { identities: { member: "s.json" } } });
});

test("identities: a row a story could not use is refused before the round trip", () => {
  const ok = [{ name: "member", kind: "session" as const, ref: "sso/member", value: null }];
  assert.equal(identityProblem([]), null);
  assert.equal(identityProblem(ok), null);
  // Unnamed: `auth:` selects BY NAME, so an unnamed row is unusable.
  assert.match(String(identityProblem([{ name: "  ", kind: "secret", ref: "s", value: null }])), /Name every identity/);
  // Two of a name: the refusal says which name is ambiguous.
  assert.match(
    String(identityProblem([...ok, { name: "member", kind: "secret", ref: "s", value: null }])),
    /Two identities are both called “member”/,
  );
  // Named, but pointing at nothing — and the message names the row and the
  // three things that would fix it.
  const empty = String(identityProblem([{ name: "admin", kind: "session", ref: "  ", value: null }]));
  assert.match(empty, /“admin” has nothing to sign in with/);
  assert.match(empty, /provider identity, a secret, or a stored state file/);
  // A custom row has no `ref` by construction, so the rule does not apply to it.
  assert.equal(identityProblem([{ name: "weird", kind: "custom", ref: "", value: { cookies: [] } }]), null);
});

test("identities: the session picker offers only references this environment may actually use", () => {
  const providers = [
    { name: "sso", ring_id: null, enabled: true, identities: { member: {}, admin: {} } },
    { name: "staging-only", ring_id: "r1", enabled: true, identities: { member: {} } },
    { name: "prod-only", ring_id: "r2", enabled: true, identities: { member: {} } },
    { name: "retired", ring_id: null, enabled: false, identities: { member: {} } },
    { name: "no-identities", ring_id: null, enabled: true },
  ];
  // A bound provider is reachable only from its own environment, so offering
  // another one's would be offering a refusal.
  assert.deepEqual(sessionRefOptions(providers, "r1"), ["sso/admin", "sso/member", "staging-only/member"]);
  assert.deepEqual(sessionRefOptions(providers, "r2"), ["prod-only/member", "sso/admin", "sso/member"]);
  // An environment that does not exist yet sees the project-wide ones.
  assert.deepEqual(sessionRefOptions(providers, null), ["sso/admin", "sso/member"]);
  // Sorted, because the picker is read alphabetically, and never a disabled one.
  assert.ok(!sessionRefOptions(providers, "r1").some((r) => r.startsWith("retired/")));
  assert.deepEqual(sessionRefOptions([], "r1"), []);
});

test("launch: an environment option names the host it resolves to", () => {
  assert.equal(hostOf("https://staging.acme.test/path"), "staging.acme.test");
  assert.equal(hostOf("http://127.0.0.1:4173"), "127.0.0.1:4173", "the port carries the meaning between two local services");
  assert.equal(hostOf(null), "");
  assert.equal(
    ringOptionLabel({ key: "staging", base_url: "https://staging.acme.test" }),
    "staging · staging.acme.test",
  );
  assert.equal(ringOptionLabel({ key: "prod", base_url: "https://acme.test" }), "prod · acme.test");
  // A mobile environment has no URL to name, so it says who supplies the build.
  assert.equal(ringOptionLabel({ key: "local" }, "mobile"), "local · build from the runner");
});

test("launch: the picker never opens on production unless production is all there is", () => {
  const local = { id: "r1", key: "local", base_url: "http://127.0.0.1:4173" };
  const staging = { id: "r2", key: "staging", base_url: "https://staging.test" };
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
  }), "r1", "the first that isn't named like production comes next");
  assert.equal(defaultRingId([local, prod], { suiteId: "s1" }), "r1");
  // Production alone is still offered — refusing to choose would be worse.
  assert.equal(defaultRingId([prod], { suiteId: "s1" }), "r3");
  assert.equal(defaultRingId([], { suiteId: "s1" }), "");
});

test("launch: the target line is the environment's URL, or who supplies the build", () => {
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

  // An environment with no URL is a warning, not a lie.
  assert.equal(launchTargetWords({ ring: { key: "local" }, application: { key: "a" } }).where, "no URL on this environment");
  assert.equal(launchTargetWords(null).where, "no URL on this environment");
});

test("new suite: the dialog commits the transport only — never a target", () => {
  // A suite runs against its application's environment, and hosted execution
  // applies that environment's URL after the authored merge, so a URL written
  // here would be the value that loses.
  assert.equal(initialDefaultsYaml({ driver: "web" }), "");
  assert.equal(initialDefaultsYaml({ driver: "mobile" }), "app:\n  driver: mobile\n");
  assert.equal(initialDefaultsYaml({ driver: "api" }), "app:\n  driver: api\n");
});
