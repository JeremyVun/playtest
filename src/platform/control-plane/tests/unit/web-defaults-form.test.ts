// The Suite settings form's YAML round-trip (src/platform/web/lib/defaults-form.ts).
// Sibling of web-caseform.test.ts: the emitted browser ESM also runs under Node,
// so this offline gate covers the settings model without a
// browser. The contract is the same as the story form's — a form edit re-emits
// only the key it changed, and every other byte (comments, order, unknown keys)
// survives.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  setAppKey, setViewportDimension, setLimitKey, setParallelValue, setModelKey, setEnvBaseUrl, resolveEnvTarget, initialDefaultsYaml, baseUrlProblem,
  setEnvCookies, parseCookieList, formatCookieList, resolveEnvCookies,
  DRIVERS, driverLabel,
} from "../../../web/lib/defaults-form.js";

const COMMENTED = `# staging defaults — owned by the payments pod
app:
  base_url: https://staging.example.com  # do not point at prod
  viewport: { width: 1366, height: 768 }
  envs:
    prod:
      base_url: https://example.com
report:
  model: sonnet
`;

test("defaults-form: editing base_url leaves every other byte alone", () => {
  const out = setAppKey(COMMENTED, "base_url", "https://t2.example.com");
  assert.match(out, /base_url: https:\/\/t2\.example\.com/);
  // Comments, the nested env, the viewport flow map and unknown top-level keys stay.
  assert.match(out, /# staging defaults/);
  assert.match(out, /viewport: \{ width: 1366, height: 768 \}/);
  assert.match(out, /prod:\n\s+base_url: https:\/\/example\.com/);
  assert.match(out, /report:\n\s+model: sonnet/);
  // The per-env URL is NOT the key that was edited.
  assert.equal(out.match(/https:\/\/example\.com/g).length, 1);
});

test("defaults-form: a key can be added to and removed from an existing app map", () => {
  const withDriver = setAppKey(COMMENTED, "driver", "api");
  assert.match(withDriver, /driver: api/);
  const without = setAppKey(withDriver, "driver", null);
  assert.doesNotMatch(without, /driver:/);
  assert.match(without, /base_url: https:\/\/staging\.example\.com/);
});

test("defaults-form: an empty file grows an app map; deleting the last key drops it", () => {
  const created = setAppKey("", "base_url", "https://staging.example.com");
  assert.equal(created, "app:\n  base_url: https://staging.example.com\n");
  assert.equal(setAppKey(created, "base_url", null), "");
});

test("defaults-form: viewport dimensions edit independently and preserve source style", () => {
  const wider = setViewportDimension(COMMENTED, "width", 1440);
  assert.match(wider, /viewport: \{ width: 1440, height: 768 \}/);
  assert.match(wider, /# staging defaults/);
  assert.match(wider, /base_url: https:\/\/staging\.example\.com/);

  const withoutHeight = setViewportDimension(wider, "height", null);
  assert.match(withoutHeight, /viewport: \{ width: 1440 \}/);
  assert.doesNotMatch(withoutHeight, /height:/);

  const fullPage = setViewportDimension("app:\n  viewport: { width: 1280, height: null }\n", "width", 1920);
  assert.match(fullPage, /viewport: \{ width: 1920, height: null \}/);

  const one = setViewportDimension("", "height", 900);
  assert.equal(one, "app:\n  viewport:\n    height: 900\n");
  assert.equal(setViewportDimension(one, "height", null), "");
  assert.throws(() => setViewportDimension("", "depth", 24), /unknown viewport dimension/);
});

test("defaults-form: execution limits preserve their existing spelling and clear cleanly", () => {
  const top = setLimitKey(COMMENTED, "max_steps", 80);
  assert.match(top, /^max_steps: 80$/m);
  assert.match(top, /# staging defaults/);
  const nestedSource = "limits:\n  max_steps: 40\n  timeout: 4m\napp:\n  base_url: https://x.test\n";
  const nested = setLimitKey(nestedSource, "timeout", "6m");
  assert.match(nested, /limits:\n  max_steps: 40\n  timeout: 6m/);
  assert.doesNotMatch(nested, /^timeout:/m);
  const cleared = setLimitKey(setLimitKey(nested, "max_steps", null), "timeout", null);
  assert.equal(cleared, "app:\n  base_url: https://x.test\n");
  assert.equal(setLimitKey("", "timeout", "6m"), "timeout: 6m\n");
});

test("defaults-form: suite concurrency sets and clears without touching other defaults", () => {
  const set = setParallelValue(COMMENTED, { total: 6, record: 2 });
  assert.match(set, /parallel:\n  total: 6\n  record: 2/);
  assert.match(set, /# staging defaults/);
  assert.match(set, /viewport: \{ width: 1366, height: 768 \}/);
  assert.doesNotMatch(setParallelValue(set, null), /parallel:/);
  assert.equal(setParallelValue("", true), "parallel: true\n");
  assert.equal(setParallelValue("parallel: 4\n", null), "");
});

test("defaults-form: model choices set and clear at the top level, other bytes intact", () => {
  const withActor = setModelKey(COMMENTED, "actor_model", "opus");
  assert.match(withActor, /^actor_model: opus$/m);
  assert.match(withActor, /# staging defaults/);
  assert.match(withActor, /viewport: \{ width: 1366, height: 768 \}/);
  // Clearing really removes the key — an empty string would be a core config
  // error, and an absent key is what lets the project default take over.
  assert.doesNotMatch(setModelKey(withActor, "actor_model", null), /actor_model/);
  assert.equal(setModelKey("", "grader_model", "gpt5_5"), "grader_model: gpt5_5\n");
  assert.equal(setModelKey(setModelKey("", "grader_model", "gpt5_5"), "grader_model", null), "");
  assert.throws(() => setModelKey("", "report_model", "opus"), /unknown model key/);
});

test("defaults-form: a suite declares its own URL for one environment", () => {
  const out = setEnvBaseUrl(COMMENTED, "t2", "https://t2.example.com");
  assert.match(out, /t2:\n\s+base_url: https:\/\/t2\.example\.com/);
  // The env that was already there is untouched, and so is everything else.
  assert.match(out, /prod:\n\s+base_url: https:\/\/example\.com/);
  assert.match(out, /# staging defaults/);
  // An empty file grows the whole path.
  assert.equal(setEnvBaseUrl("", "staging", "https://s.test"),
    "app:\n  envs:\n    staging:\n      base_url: https://s.test\n");
});

test("defaults-form: clearing an override prunes the empty maps it leaves behind", () => {
  const one = setEnvBaseUrl("", "staging", "https://s.test");
  // The last override in the file takes the whole app/envs scaffold with it.
  assert.equal(setEnvBaseUrl(one, "staging", null), "");
  // With a sibling env, only that env's entry goes.
  const two = setEnvBaseUrl(one, "prod", "https://p.test");
  const back = setEnvBaseUrl(two, "prod", null);
  assert.equal(back, one);
  // With a suite default present, the app map survives the pruning.
  const withDefault = setAppKey(one, "base_url", "https://dev.test");
  const pruned = setEnvBaseUrl(withDefault, "staging", null);
  assert.equal(pruned, "app:\n  base_url: https://dev.test\n");
});

test("defaults-form: cookie text and the flat map round-trip; junk names its entry", () => {
  assert.deepEqual(parseCookieList("slot=blue; feature_x=on"), { slot: "blue", feature_x: "on" });
  // Newlines separate too, and a value may itself contain "=".
  assert.deepEqual(parseCookieList("token=a=b\nslot=blue"), { token: "a=b", slot: "blue" });
  assert.equal(parseCookieList("   "), null);
  assert.equal(formatCookieList({ slot: "blue", feature_x: "on" }), "slot=blue; feature_x=on");
  assert.equal(formatCookieList(null), "");
  assert.throws(() => parseCookieList("no equals"), /isn't a cookie/);
  assert.throws(() => parseCookieList("=orphan"), /isn't a cookie/);
});

test("defaults-form: suite-default cookies write app.cookies and clear cleanly", () => {
  const set = setAppKey(COMMENTED, "cookies", { slot: "blue" });
  assert.match(set, /cookies:\n\s+slot: blue/);
  assert.match(set, /# staging defaults/);
  // Replacing writes the new map wholesale — no merge with the old one.
  const replaced = setAppKey(set, "cookies", { bvt: "true" });
  assert.doesNotMatch(replaced, /slot:/);
  assert.match(replaced, /bvt: "true"/);
  assert.doesNotMatch(setAppKey(set, "cookies", null), /cookies:/);
});

test("defaults-form: per-environment cookies overlay one ring and prune away", () => {
  const out = setEnvCookies(COMMENTED, "prod", { slot: "green" });
  assert.match(out, /prod:\n\s+base_url: https:\/\/example\.com\n\s+cookies:\n\s+slot: green/);
  assert.match(out, /# staging defaults/);
  // An empty file grows the whole path, and clearing takes the scaffold with it.
  const one = setEnvCookies("", "staging", { slot: "blue" });
  assert.equal(one, "app:\n  envs:\n    staging:\n      cookies:\n        slot: blue\n");
  assert.equal(setEnvCookies(one, "staging", null), "");
  // Clearing cookies leaves a sibling base_url on the same env untouched.
  const both = setEnvCookies(setEnvBaseUrl("", "staging", "https://s.test"), "staging", { slot: "blue" });
  assert.equal(setEnvCookies(both, "staging", null), setEnvBaseUrl("", "staging", "https://s.test"));
});

test("defaults-form: cookies resolve with the same precedence as the URL", () => {
  const app = { cookies: { bvt: "true" }, envs: { staging: { cookies: { slot: "blue" } } } };
  // The suite's own cookies for the ring replace everything else wholesale.
  assert.deepEqual(resolveEnvCookies(app, "staging", { slot: "green" }),
    { cookies: { slot: "blue" }, source: "suite-env" });
  // No override: the ring's own cookies.
  assert.deepEqual(resolveEnvCookies(app, "prod", { slot: "green" }),
    { cookies: { slot: "green" }, source: "environment" });
  // Neither: the suite default.
  assert.deepEqual(resolveEnvCookies(app, "prod", null),
    { cookies: { bvt: "true" }, source: "suite" });
  assert.deepEqual(resolveEnvCookies({}, "prod", {}), { cookies: null, source: null });
});

test("defaults-form: a blank row resolves the way the dispatcher does", () => {
  const app = { base_url: "https://dev.test", envs: { staging: { base_url: "https://suite-staging.test" } } };
  // The suite's own URL for the ring wins over the ring's fallback.
  assert.deepEqual(resolveEnvTarget(app, "staging", "https://ring.test"),
    { url: "https://suite-staging.test", source: "suite-env" });
  // No override: the ring's fallback.
  assert.deepEqual(resolveEnvTarget(app, "prod", "https://ring.test"),
    { url: "https://ring.test", source: "environment" });
  // Neither: the suite's default — which is what a blank row with a blank ring says.
  assert.deepEqual(resolveEnvTarget(app, "prod", null),
    { url: "https://dev.test", source: "suite" });
  // Nothing anywhere is the only case a run cannot start from.
  assert.deepEqual(resolveEnvTarget({}, "prod", "   "), { url: null, source: null });
});

test("defaults-form: a new suite's playtest.yaml carries only what was chosen", () => {
  assert.equal(initialDefaultsYaml({ driver: "web", baseUrl: "https://staging.example.com" }),
    "app:\n  base_url: https://staging.example.com\n");
  // web is the default driver — it is never written out.
  assert.doesNotMatch(initialDefaultsYaml({ driver: "web", baseUrl: "https://x.test" }), /driver:/);
  assert.equal(initialDefaultsYaml({ driver: "api", baseUrl: "https://api.test" }),
    "app:\n  driver: api\n  base_url: https://api.test\n");
  // mobile reaches a device, not an origin: it carries the binary, not a URL.
  assert.equal(initialDefaultsYaml({ driver: "mobile", appBinary: "builds/app.apk", baseUrl: "https://ignored.test" }),
    "app:\n  driver: mobile\n  app: builds/app.apk\n");
  assert.equal(initialDefaultsYaml({}), "");
});

test("defaults-form: the app URL is checked before a suite is created", () => {
  assert.equal(baseUrlProblem("https://staging.example.com"), null);
  assert.equal(baseUrlProblem("http://127.0.0.1:4173"), null);
  for (const bad of ["", "   ", "staging.example.com", "ftp://example.com"]) {
    assert.ok(baseUrlProblem(bad), `"${bad}" must be rejected with a reason`);
  }
});

test("defaults-form: every driver the form offers names its transport", () => {
  assert.deepEqual(DRIVERS, ["web", "api", "mobile"]);
  for (const d of DRIVERS) assert.match(driverLabel(d), new RegExp(`^${d} — .+`));
});
