// The runner's own configuration file: what it accepts, and — the part that
// matters at 9pm when a launch will not run — what it refuses and how it says
// so. Every assertion below is about a message a person reads once and then
// knows what to type.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertConfigScope, bindingFor, configBannerLines, loadRunnerConfig } from "../../src/runner-config.ts";

/** Write a config file (and the app build it points at) into a scratch dir. */
function withConfig(body: string, { app = "Todo.app" }: { app?: string | null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-config-"));
  if (app) fs.mkdirSync(path.join(dir, app), { recursive: true });
  const file = path.join(dir, "runner.yaml");
  fs.writeFileSync(file, body);
  return { dir, file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const MANAGED = `
version: 1
labels: [macbook, ios]
targets:
  todo-ios:
    local:
      platform: ios
      app: Todo.app
      backend: local-ios
      device: iPhone 16
mobile:
  backends:
    local-ios:
      platform: ios
      appium:
        mode: managed
`;

test("runner config: a v1 file becomes labels, backends and bindings, with the app path resolved against the file", () => {
  const c = withConfig(MANAGED);
  try {
    const config = loadRunnerConfig(c.file);
    assert.deepEqual(config.labels, ["macbook", "ios"]);
    assert.equal(config.bindings.length, 1);
    const binding = config.bindings[0]!;
    assert.equal(binding.applicationKey, "todo-ios");
    assert.equal(binding.ringKey, "local");
    assert.equal(binding.platform, "ios");
    assert.equal(binding.device, "iPhone 16");
    assert.equal(binding.app, path.join(c.dir, "Todo.app"), "a relative build path is this file's own directory");
    assert.equal(binding.backend.name, "local-ios");
    assert.equal(binding.backend.mode, "managed");
    assert.equal(binding.projectKey, null, "a flat key belongs to whatever project this runner is scoped to");

    // The lookup the claim and the executor both use.
    const found = bindingFor(config, { projectKey: "acme", applicationKey: "todo-ios", ringKey: "local" });
    assert.equal(found, binding);
    assert.equal(bindingFor(config, { projectKey: "acme", applicationKey: "todo-ios", ringKey: "staging" }), null);
    assert.equal(bindingFor(null, { projectKey: "acme", applicationKey: "todo-ios", ringKey: "local" }), null);
  } finally {
    c.cleanup();
  }
});

test("runner config: an omitted device stays omitted — the runtime target must never inherit one", () => {
  const c = withConfig(MANAGED.replace("      device: iPhone 16\n", ""));
  try {
    assert.equal(loadRunnerConfig(c.file).bindings[0]!.device, null);
  } finally {
    c.cleanup();
  }
});

test("runner config: the seeded all-comments file is a valid empty configuration, and declares no labels", () => {
  const c = withConfig("# Playtest runner configuration\n# nothing uncommented yet\n", { app: null });
  try {
    const config = loadRunnerConfig(c.file);
    assert.equal(config.labels, null, "a file that says nothing about labels is not a labels source");
    assert.equal(config.bindings.length, 0);
    assert.equal(config.backends.size, 0);
    assert.match(configBannerLines(config).join("\n"), /none declared/);
  } finally {
    c.cleanup();
  }
});

test("runner config: the version is required, and a missing file names the flag", () => {
  const c = withConfig("targets: {}\n", { app: null });
  try {
    assert.throws(() => loadRunnerConfig(c.file), /must start with "version: 1"/);
    assert.throws(() => loadRunnerConfig(path.join(c.dir, "nope.yaml")), /cannot read the runner config file/);
    assert.throws(() => loadRunnerConfig(path.join(c.dir, "nope.yaml")), /--config/);
  } finally {
    c.cleanup();
  }
});

test("runner config: a duplicate target is refused by position, not silently collapsed", () => {
  const c = withConfig(`
version: 1
targets:
  todo-ios:
    local:
      platform: ios
      app: Todo.app
      backend: local-ios
    local:
      platform: ios
      app: Todo.app
      backend: local-ios
mobile:
  backends:
    local-ios: { platform: ios, appium: { mode: managed } }
`);
  try {
    assert.throws(() => loadRunnerConfig(c.file), /is not valid YAML/);
    assert.throws(() => loadRunnerConfig(c.file), /exactly once/);
  } finally {
    c.cleanup();
  }
});

test("runner config: an unknown backend, a platform mismatch and a missing build each name the remedy", () => {
  const unknown = withConfig(MANAGED.replace("backend: local-ios", "backend: grid"));
  try {
    assert.throws(() => loadRunnerConfig(unknown.file), /backend names "grid", which is not declared/);
    assert.throws(() => loadRunnerConfig(unknown.file), /use one of: local-ios/);
  } finally {
    unknown.cleanup();
  }

  const mismatch = withConfig(MANAGED.replace("    local-ios:\n      platform: ios", "    local-ios:\n      platform: android"));
  try {
    assert.throws(() => loadRunnerConfig(mismatch.file), /is a ios target but its backend "local-ios" is declared android/);
  } finally {
    mismatch.cleanup();
  }

  const missing = withConfig(MANAGED, { app: null });
  try {
    assert.throws(() => loadRunnerConfig(missing.file), /which is not on this machine/);
    assert.throws(() => loadRunnerConfig(missing.file), /the platform never stores or resolves it/);
  } finally {
    missing.cleanup();
  }
});

test("runner config: credential VALUES are refused wherever they are written", () => {
  const inline = withConfig(`
version: 1
mobile:
  backends:
    grid:
      platform: ios
      appium:
        mode: external
        url: https://grid.example.com
        password: hunter2
`, { app: null });
  try {
    assert.throws(() => loadRunnerConfig(inline.file), /looks like a credential/);
    assert.throws(() => loadRunnerConfig(inline.file), /credential_file|credential_env/);
  } finally {
    inline.cleanup();
  }

  const userinfo = withConfig(`
version: 1
mobile:
  backends:
    grid:
      platform: ios
      appium:
        mode: external
        url: https://alice:hunter2@grid.example.com
`, { app: null });
  try {
    assert.throws(() => loadRunnerConfig(userinfo.file), /carries a credential in the URL/);
  } finally {
    userinfo.cleanup();
  }
});

test("runner config: an external backend takes its credential from a file or a named environment variable", () => {
  const c = withConfig(`
version: 1
mobile:
  backends:
    grid:
      platform: ios
      appium:
        mode: external
        url: http://127.0.0.1:4723/
        credential_file: grid.credential
`, { app: null });
  try {
    assert.throws(() => loadRunnerConfig(c.file), /credential_file points at/, "a credential file that is not there is a startup error");
    fs.writeFileSync(path.join(c.dir, "grid.credential"), "alice:hunter2\n");
    const backend = loadRunnerConfig(c.file).backends.get("grid")!;
    assert.equal(backend.mode, "external");
    assert.equal(backend.url, "http://127.0.0.1:4723", "the address is normalized, and never carries a credential");
    assert.equal(backend.credentialFile, path.join(c.dir, "grid.credential"));
    assert.equal(backend.credentialEnv, null);
  } finally {
    c.cleanup();
  }

  const named = withConfig(`
version: 1
mobile:
  backends:
    grid:
      platform: ios
      appium: { mode: external, url: http://127.0.0.1:4723, credential_env: GRID_CREDENTIAL }
`, { app: null });
  try {
    assert.throws(() => loadRunnerConfig(named.file, {}), /is not set for this\s+runner/);
    const backend = loadRunnerConfig(named.file, { GRID_CREDENTIAL: "token" }).backends.get("grid")!;
    assert.equal(backend.credentialEnv, "GRID_CREDENTIAL");
  } finally {
    named.cleanup();
  }
});

test("runner config: a managed backend refuses the keys that only make sense for an external one", () => {
  const c = withConfig(`
version: 1
mobile:
  backends:
    local-ios:
      platform: ios
      appium: { mode: managed, url: http://127.0.0.1:4723 }
`, { app: null });
  try {
    assert.throws(() => loadRunnerConfig(c.file), /applies to "mode: external" only/);
  } finally {
    c.cleanup();
  }
});

test("runner config: a site-scoped runner must name the project of every target", () => {
  const flat = withConfig(MANAGED);
  try {
    const config = loadRunnerConfig(flat.file);
    // A project-scoped runner is unambiguous, so a flat key is exactly right.
    assert.doesNotThrow(() => assertConfigScope(config, { siteScoped: false }));
    assert.throws(() => assertConfigScope(config, { siteScoped: true }), /this runner is site-scoped/);
    assert.throws(() => assertConfigScope(config, { siteScoped: true }), /projects\.<project-key>\.targets\.todo-ios\.local/);
    assert.throws(() => assertConfigScope(config, { siteScoped: true }), /silently rebind/);
  } finally {
    flat.cleanup();
  }

  const qualified = withConfig(`
version: 1
projects:
  acme:
    targets:
      todo-ios:
        local: { platform: ios, app: Todo.app, backend: local-ios }
mobile:
  backends:
    local-ios: { platform: ios, appium: { mode: managed } }
`);
  try {
    const config = loadRunnerConfig(qualified.file);
    assert.doesNotThrow(() => assertConfigScope(config, { siteScoped: true }));
    assert.equal(config.bindings[0]!.projectKey, "acme");
    assert.ok(bindingFor(config, { projectKey: "acme", applicationKey: "todo-ios", ringKey: "local" }));
    assert.equal(
      bindingFor(config, { projectKey: "other", applicationKey: "todo-ios", ringKey: "local" }),
      null,
      "another project's identically-keyed application is a different application",
    );
    assert.match(configBannerLines(config).join("\n"), /acme\/todo-ios\/local — ios via backend "local-ios"/);
  } finally {
    qualified.cleanup();
  }
});

test("runner config: flat and project-qualified targets in one file is refused rather than resolved", () => {
  const c = withConfig(`
version: 1
targets:
  todo-ios:
    local: { platform: ios, app: Todo.app, backend: local-ios }
projects:
  acme:
    targets:
      todo-ios:
        local: { platform: ios, app: Todo.app, backend: local-ios }
mobile:
  backends:
    local-ios: { platform: ios, appium: { mode: managed } }
`);
  try {
    assert.throws(() => loadRunnerConfig(c.file), /not both/);
  } finally {
    c.cleanup();
  }
});

test("runner config: the banner states keys and backends, and no build path or device", () => {
  const c = withConfig(MANAGED);
  try {
    const banner = configBannerLines(loadRunnerConfig(c.file)).join("\n");
    assert.match(banner, /config\s+.*runner\.yaml/);
    assert.match(banner, /targets\s+todo-ios\/local — ios via backend "local-ios"/);
    assert.match(banner, /backends\s+local-ios — ios, managed Appium \(started here\)/);
    assert.equal(banner.includes("Todo.app"), false, "the build path is a machine-local fact, not banner furniture");
    assert.equal(banner.includes("iPhone 16"), false, "and neither is the device");
    assert.deepEqual(configBannerLines(null), [], "no config file, no lines");
  } finally {
    c.cleanup();
  }
});
