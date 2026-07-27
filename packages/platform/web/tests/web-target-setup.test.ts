// Where an app runs, as the console models it: the environment form's document
// surgery and its upload guardrails, and the "where does this app run?" card
// the New suite dialog stopped asking for. Both are DOM-free modules so the
// offline gate can hold them to the rules that actually matter — one source of
// truth on save, a cap stated before an upload rather than after, names that
// collide surfaced in the form, and every driver's own question.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readEnvApp, applyEnvApp, hasMobileConfig, fmtBytes, artifactSummary,
  appArtifactProblem, APP_ARTIFACT_EXTENSIONS,
} from "../src/lib/env-config.js";
import {
  BINARY_SOURCES, targetQuestion, ringNameProblem, ringPlan, existingRingPlan,
  appSourceWords, appTargetProblem,
} from "../src/lib/suite-target.js";
import { initialDefaultsYaml } from "../src/lib/defaults-form.js";

test("environment: named fields and the raw document are one document, not two", () => {
  const stored = {
    app: { base_url: "https://staging.example.com", platform: "ios", app: "/Users/ada/app.ipa" },
    secret_env: { TOKEN: { $secret: "staging" } },
    // A key no field knows about. The whole point of the rule is that this
    // survives every edit the form makes.
    settle_ms: 400,
  };
  const fields = readEnvApp(stored);
  assert.equal(fields.base_url, "https://staging.example.com");
  assert.equal(fields.platform, "ios");
  assert.equal(fields.app, "/Users/ada/app.ipa");
  assert.equal(fields.appium_url, "", "an unset key reads as an empty field, never undefined");

  const next: WebDynamic = applyEnvApp(stored, { appium_url: "http://127.0.0.1:4723", platform: "android" });
  assert.equal(next.app.appium_url, "http://127.0.0.1:4723");
  assert.equal(next.app.platform, "android");
  assert.deepEqual(next.secret_env, stored.secret_env, "auth config is untouched by a device edit");
  assert.equal(next.settle_ms, 400, "a key with no field survives verbatim");
  assert.equal(stored.app.platform, "ios", "the stored document is not mutated in place");

  // A cleared field DELETES its key: "" is not a platform, and leaving an empty
  // string behind is how a ring ends up claiming a device it does not have.
  const cleared: WebDynamic = applyEnvApp(stored, { platform: "", app: "  " });
  assert.equal("platform" in cleared.app, false);
  assert.equal("app" in cleared.app, false);
  assert.equal(cleared.app.base_url, "https://staging.example.com");
  // Emptying the last app key removes the map rather than leaving `app: {}`.
  const bare: WebDynamic = applyEnvApp({ app: { platform: "ios" } }, { platform: "" });
  assert.equal("app" in bare, false);
});

test("environment: a ring is offered the device fields when it already has one", () => {
  assert.equal(hasMobileConfig({ app: { platform: "ios" } }), true);
  assert.equal(hasMobileConfig({ app: { app: "/builds/app.apk" } }), true);
  assert.equal(hasMobileConfig({ app: { appium_url: "http://127.0.0.1:4723" } }), true);
  assert.equal(hasMobileConfig({ app: { base_url: "https://x.test" } }), false, "a web ring keeps the device fields folded away");
  assert.equal(hasMobileConfig(null), false);
});

test("environment: the app-artifact cap is stated up front, in the server's words", () => {
  const cap = 512 * 1024 * 1024;
  assert.equal(appArtifactProblem({ name: "app-release.apk", size: 40 * 1024 * 1024 }, cap), null);
  for (const ext of APP_ARTIFACT_EXTENSIONS) {
    assert.equal(appArtifactProblem({ name: `build${ext}`, size: 10 }, cap), null, ext);
  }
  // An iOS .app is a directory. Saying only "wrong file type" would leave a
  // person with no way forward, so the sentence carries the way forward.
  const wrong = appArtifactProblem({ name: "MyApp.app", size: 10 }, cap);
  assert.match(String(wrong), /zip it first/);
  assert.match(String(wrong), /\.apk, \.aab, \.ipa, \.zip/);
  // Over the cap is caught HERE — after a four-minute upload is the one place
  // this must never be discovered.
  const big = appArtifactProblem({ name: "huge.apk", size: cap + 1 }, cap);
  assert.match(String(big), /512 MB cap/);
  assert.match(String(big), /PLAYTEST_APP_ARTIFACT_MAX_MB/);
  assert.match(String(big), /runner's own disk/, "the alternative that always works is named");
  // The cap is the DEPLOYMENT's, never a number this module invents.
  assert.match(String(appArtifactProblem({ name: "big.apk", size: 200 * 1024 * 1024 }, 128 * 1024 * 1024)), /128 MB cap/);
  assert.match(String(appArtifactProblem({ name: "empty.apk", size: 0 }, cap)), /empty/);
  assert.match(String(appArtifactProblem(null, cap)), /Choose the app binary/);
});

test("environment: an uploaded build reads as what it is, how big, and how old", () => {
  assert.equal(fmtBytes(42 * 1024 * 1024), "42 MB");
  assert.equal(fmtBytes(1.5 * 1024 * 1024), "1.5 MB");
  assert.equal(fmtBytes(2048), "2 kB");
  assert.equal(
    artifactSummary({ sha256: "abc", size: 42 * 1024 * 1024, filename: "app-release.apk", uploaded_at: "x" }, () => "2 h ago"),
    "app-release.apk · 42 MB · uploaded 2 h ago");
  assert.equal(artifactSummary(null, () => "—"), null);
});

test("new suite: the dialog commits identity only — no target, and no empty file", () => {
  // A web suite with nothing configured yet gets NO defaults file, because that
  // is exactly what "not set up yet" means to core — better than an empty one.
  assert.equal(initialDefaultsYaml({ driver: "web" }), "");
  // A non-default transport IS identity, and is worth committing on creation.
  assert.equal(initialDefaultsYaml({ driver: "mobile" }), "app:\n  driver: mobile\n");
  assert.equal(initialDefaultsYaml({ driver: "api" }), "app:\n  driver: api\n");
});

test("target card: the question is the driver's own", () => {
  assert.equal(targetQuestion("mobile").kind, "binary");
  assert.match(targetQuestion("mobile").sub, /build/);
  assert.equal(targetQuestion("web").kind, "url");
  assert.equal(targetQuestion("api").kind, "url");
  assert.match(targetQuestion("api").sub, /call/, "an API is called, not opened");
  // Three sources, each with the sentence that decides whether it is the one.
  assert.deepEqual(BINARY_SOURCES.map((s: WebDynamic) => s.id), ["runner-path", "artifact", "suite-file"]);
  for (const s of BINARY_SOURCES) assert.ok(s.when.length > 30, s.id);
});

test("target card: a name that collides says which one is in the way", () => {
  const envs = [
    { name: "staging", suite_id: null },
    { name: "checkout-local", suite_id: "s2", suite: { name: "Checkout" } },
  ];
  assert.equal(ringNameProblem("preview", envs), null);
  // Names are unique per project across BOTH scopes, because the name is the
  // `--env` argument, so the form has to explain a collision it did not cause.
  assert.match(String(ringNameProblem("staging", envs)), /already a shared environment/);
  assert.match(String(ringNameProblem("checkout-local", envs)), /Checkout/);
  assert.match(String(ringNameProblem("STAGING", envs)), /already a shared environment/, "case is not a difference here");
  assert.match(String(ringNameProblem("my ring", envs)), /letters, digits, dots and dashes/);
  assert.match(String(ringNameProblem("", envs)), /Give this environment a name/);
});

test("target card: each answer writes to whichever owner it belongs to", () => {
  // A web ring made inline is suite-owned by default, and the URL is the
  // SUITE's inside it — never the ring's, which every other suite would inherit.
  const web: WebDynamic = ringPlan({ driver: "web", name: "preview", scope: "suite", url: "https://preview.test " }, { suiteId: "s1" });
  assert.deepEqual(web.environment, { name: "preview", suite_id: "s1", runner_labels: [], config: {} });
  assert.deepEqual(web.write, { kind: "suite-env-url", env: "preview", value: "https://preview.test" });
  assert.equal(web.upload, false);
  // Promoting it drops the suite ownership and nothing else.
  assert.equal(ringPlan({ driver: "web", name: "preview", scope: "project", url: "https://x.test" }, { suiteId: "s1" }).environment?.suite_id, undefined);

  // Mobile, source 1: the build is on the runner's disk, so the PATH and the
  // labels that reach that machine are the ring's business.
  const local: WebDynamic = ringPlan({
    driver: "mobile", name: "adas-mac", scope: "suite", labels: ["macos", "ios-sim"],
    source: "runner-path", path: "/Users/ada/build/app.ipa", platform: "ios", appiumUrl: "http://127.0.0.1:4723",
  }, { suiteId: "s1" });
  assert.deepEqual(local.environment?.runner_labels, ["macos", "ios-sim"]);
  assert.deepEqual(local.environment?.config, {
    app: { platform: "ios", appium_url: "http://127.0.0.1:4723", app: "/Users/ada/build/app.ipa" },
  });
  assert.deepEqual(local.write, { kind: "none" }, "nothing about a runner's disk belongs in the suite's files");
  assert.equal(local.upload, false);

  // Source 2: uploaded. The ring still carries the device, and the card owes an
  // upload once the ring exists to hang it on.
  const uploaded: WebDynamic = ringPlan({ driver: "mobile", name: "cloud", scope: "suite", source: "artifact", platform: "android" }, { suiteId: "s1" });
  assert.equal(uploaded.upload, true);
  assert.deepEqual(uploaded.environment?.config, { app: { platform: "android" } });
  assert.deepEqual(uploaded.write, { kind: "none" });

  // Source 3: a small fixture app committed with the stories — the SUITE's file,
  // resolved by core against playtest.yaml.
  const fixture: WebDynamic = ringPlan({ driver: "mobile", name: "sim", scope: "suite", source: "suite-file", path: "builds/fixture.apk", platform: "ios" }, { suiteId: "s1" });
  assert.deepEqual(fixture.write, { kind: "suite-app", value: "builds/fixture.apk" });
  assert.equal(fixture.upload, false);
  assert.equal(fixture.environment?.config?.app?.app, undefined, "a suite file is not a path on the runner");
});

test("target card: pointing at a ring that exists writes only the suite's own URL", () => {
  // The project's `default` ring carries no URL of its own, so the suite's URL
  // for it IS the suite's top-level base_url — the same rule Suite settings uses.
  assert.deepEqual(existingRingPlan("default", "https://app.test"), { kind: "suite-default-url", value: "https://app.test" });
  assert.deepEqual(existingRingPlan("staging", "https://staging.test"), { kind: "suite-env-url", env: "staging", value: "https://staging.test" });
  // Leaving it blank accepts whatever the ring already resolves to — a real
  // answer, and the card must not write an empty override for it.
  assert.deepEqual(existingRingPlan("staging", "  "), { kind: "none" });
});

test("launch: the binary's source is said out loud, and a launch with none is stopped", () => {
  assert.equal(appSourceWords("environment-artifact"), "uploaded to this environment");
  assert.equal(appSourceWords("environment"), "a path on the runner's own disk");
  assert.equal(appSourceWords("suite"), "committed in this suite");
  assert.equal(appSourceWords(null), "unresolved");

  // A web or API launch has no binary to resolve, and must not be nagged about one.
  assert.equal(appTargetProblem(null, "web"), null);
  assert.equal(appTargetProblem({ resolved: null, source: null }, "web"), null);

  // Nothing resolved: the runner would have no file to install, so this is
  // fatal and names all three places a binary can come from.
  const none = appTargetProblem({ resolved: null, source: null }, "mobile");
  assert.equal(none?.severity, "blocking");
  assert.match(String(none?.message), /three places/);

  // An absolute path or an upload is fine — the control plane has no business
  // asserting what exists on a disk it will never see.
  assert.equal(appTargetProblem({ resolved: "/Users/ada/app.ipa", source: "environment" }, "mobile"), null);
  assert.equal(appTargetProblem({ resolved: "app-release.apk", source: "environment-artifact" }, "mobile"), null);

  // A suite-relative path only works when the file is committed, which the
  // browser cannot know — so it warns with the remedy rather than refusing.
  const relative = appTargetProblem({ resolved: "builds/app.apk", source: "suite" }, "mobile");
  assert.equal(relative?.severity, "warning");
  assert.match(String(relative?.message), /committed in the suite/);
  assert.match(String(relative?.message), /three places/);
});
