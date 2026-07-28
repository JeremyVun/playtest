// Applications and rings: the model that replaced environments
// (docs/contracts/hosted.md, "Applications and rings").
//
// Covered here, by acceptance gate:
//   1  independent surfaces per project, keys immutable and unique in scope
//   2  a suite launches only against its own application's rings, and a ring's
//      session references cannot borrow another ring's provider
//   3  a web ring is "a base URL plus logical policy" and needs no runner setup
//   8  (platform side) the group spec carries the ring target, and authored
//      physical fields are inert under hosted execution
//   12 a pre-refactor data root fails boot with an actionable message
//   13 deletion is refused while referenced, naming the referrers; nothing cascades
// plus the mobile launch, which posts to the board like any other and carries a
// target block with no URL and no build (the claiming runner supplies it).
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withApp, createTarget, loadSuiteDir, REPO_ROOT } from "./helpers.ts";
import { writeTar } from "../../src/suites/tar.ts";
import { loadConfig, ServerConfigError } from "../../src/config.ts";
import { createApp } from "../../src/app.ts";


async function project(api: HostedDynamic, key: HostedDynamic) {
  const res = await api.post("/projects", { key, name: key });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

/** The todos suite, committed, bound to the project's single application. */
async function suiteWithStories(api: HostedDynamic, p: HostedDynamic, slug = "todos") {
  const suite = (await api.post(`/projects/${p.key}/suites`, { slug, name: slug })).body;
  const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
  assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);
  return suite;
}

// ------------------------------------------------------------------- gate 1

test("applications: a project owns independent surfaces; keys, drivers and platforms are immutable", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const p = await project(api, "gate1");

    const web = (await api.post(`/projects/${p.key}/applications`, { key: "todo-web", name: "Todo Web", driver: "web" })).body;
    const ios = (await api.post(`/projects/${p.key}/applications`, { key: "todo-ios", name: "Todo iOS", driver: "mobile", platform: "ios" })).body;
    assert.equal(web.platform, null, "only a mobile application names a platform");
    assert.equal(ios.platform, "ios");

    // A mobile application without a platform is refused: core has to pick
    // XCUITest or UiAutomator2 from it.
    const noPlatform = await api.post(`/projects/${p.key}/applications`, { key: "todo-droid", name: "Droid", driver: "mobile" });
    assert.equal(noPlatform.status, 400);
    assert.match(noPlatform.body.error.message, /"platform" is required for a mobile application/);
    const webPlatform = await api.post(`/projects/${p.key}/applications`, { key: "nope", name: "Nope", driver: "web", platform: "ios" });
    assert.equal(webPlatform.status, 400);
    assert.match(webPlatform.body.error.message, /applies to mobile applications only/);

    // Keys are unique per project…
    const dup = await api.post(`/projects/${p.key}/applications`, { key: "todo-web", name: "Again", driver: "api" });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error.message, /already exists/);
    // …and unique only per project: another project may reuse the key.
    const other = await project(api, "gate1other");
    assert.equal((await api.post(`/projects/${other.key}/applications`, { key: "todo-web", name: "Theirs", driver: "web" })).status, 201);

    // Name is editable; identity is not.
    assert.equal((await api.put(`/applications/${web.id}`, { name: "Todo (web)" })).body.name, "Todo (web)");
    for (const [field, value, pattern] of [
      ["key", "renamed", /key is part of its identity/],
      ["driver", "api", /driver can't change/],
      ["platform", "android", /platform can't change/],
    ] as HostedDynamic[]) {
      const res = await api.put(`/applications/${web.id}`, { name: "x", [field]: value });
      assert.equal(res.status, 400, `${field}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error.message, pattern);
    }

    // Every application may have its own `local`: ring keys scope to the app.
    assert.equal((await api.post(`/applications/${web.id}/rings`, { key: "local", base_url: "http://127.0.0.1:4173" })).status, 201);
    assert.equal((await api.post(`/applications/${ios.id}/rings`, { key: "local" })).status, 201);
    const dupRing = await api.post(`/applications/${web.id}/rings`, { key: "local", base_url: "http://127.0.0.1:4173" });
    assert.equal(dupRing.status, 409);
    assert.match(dupRing.body.error.message, /already has a ring named "local"/);

    const listed = await api.get(`/projects/${p.key}/applications?include=rings`);
    assert.deepEqual(listed.body.items.map((a: HostedDynamic) => a.key), ["todo-ios", "todo-web"]);
    assert.deepEqual(listed.body.items.map((a: HostedDynamic) => a.rings.length), [1, 1]);
  });
});

// ------------------------------------------------------------------- gate 3

test("rings: a web ring is a base URL plus logical policy — the five physical keys are refused where they would take effect", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const p = await project(api, "gate3");
    const web = (await api.post(`/projects/${p.key}/applications`, { key: "todo-web", name: "Todo Web", driver: "web" })).body;
    const ios = (await api.post(`/projects/${p.key}/applications`, { key: "todo-ios", name: "Todo iOS", driver: "mobile", platform: "ios" })).body;

    // A web ring must have a URL; a mobile ring must not.
    const noUrl = await api.post(`/applications/${web.id}/rings`, { key: "staging" });
    assert.equal(noUrl.status, 400);
    assert.match(noUrl.body.error.message, /"base_url" is required for a web ring/);
    assert.match(noUrl.body.error.message, /claiming runner's network position/);
    const badUrl = await api.post(`/applications/${web.id}/rings`, { key: "staging", base_url: "staging.acme.test" });
    assert.equal(badUrl.status, 400);
    assert.match(badUrl.body.error.message, /absolute http\(s\) URL/);
    const mobileUrl = await api.post(`/applications/${ios.id}/rings`, { key: "local", base_url: "http://127.0.0.1:4723" });
    assert.equal(mobileUrl.status, 400);
    assert.match(mobileUrl.body.error.message, /claiming runner\s+supplies the build/);
    const mobileRing = await api.post(`/applications/${ios.id}/rings`, { key: "local" });
    assert.equal(mobileRing.status, 201);
    assert.equal(mobileRing.body.base_url, null);

    // The five physical keys are refused at the ONE position where core would
    // read them, each with its own reason.
    for (const [key, value, pattern] of [
      ["base_url", "https://staging.acme.test", /a ring's URL is its own "base_url" field/],
      ["app", "/Users/me/build/Todo.app", /physical target the claiming runner resolves/],
      ["platform", "ios", /physical target the claiming runner resolves/],
      ["device", "iPhone 16", /physical target the claiming runner resolves/],
      ["appium_url", "http://127.0.0.1:4723", /physical target the claiming runner resolves/],
      ["compose", "docker-compose.yml", /boot a different application under this ring's name/],
    ] as HostedDynamic[]) {
      const res = await api.post(`/applications/${web.id}/rings`, {
        key: `probe-${key.replace(/_/g, "-")}`,
        base_url: "https://staging.acme.test",
        config: { app: { [key]: value } },
      });
      assert.equal(res.status, 400, `config.app.${key}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error.message, pattern);
    }

    // The allowlist is positional, not a property-name blacklist at every depth:
    // the logical `app` container itself is fine, and data that merely happens
    // to be named `app` or `device` deeper down is untouched.
    const ok = await api.post(`/applications/${web.id}/rings`, {
      key: "staging",
      name: "Staging",
      base_url: "https://staging.acme.test",
      runner_labels: ["linux"],
      discovery_allowed: true,
      config: {
        app: { viewport: { width: 1280, height: 720 }, settle: 250 },
        auth: { default: "member", identities: { app: { $session: "sso/app" }, device: { $session: "sso/device" } } },
        secret_env: { APP: "APP_TOKEN", DEVICE: { $secret_file: "DEVICE_KEY" } },
      },
    });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual(Object.keys(ok.body.config.auth.identities).sort(), ["app", "device"]);
    assert.equal(ok.body.config.secret_env.APP, "APP_TOKEN");

    // An unknown top-level config key is named, not silently kept.
    const stray = await api.post(`/applications/${web.id}/rings`, {
      key: "stray",
      base_url: "https://staging.acme.test",
      config: { runner: {} },
    });
    assert.equal(stray.status, 400);
    assert.match(stray.body.error.message, /not part of a ring's configuration/);

    // A ring key is identity too, and a ring never moves between applications.
    const rename = await api.put(`/rings/${ok.body.id}`, { key: "prod" });
    assert.equal(rename.status, 400);
    assert.match(rename.body.error.message, /key is part of its identity/);
    const rebind = await api.put(`/rings/${ok.body.id}`, { application_id: ios.id });
    assert.equal(rebind.status, 400);
    assert.match(rebind.body.error.message, /belongs to one application for its whole life/);

    // Merge-on-update: a partial PUT never wipes the overlay it did not mention.
    const flipped = await api.put(`/rings/${ok.body.id}`, { discovery_allowed: false });
    assert.equal(flipped.status, 200);
    assert.equal(flipped.body.discovery_allowed, false);
    assert.equal(flipped.body.base_url, "https://staging.acme.test");
    assert.deepEqual(flipped.body.runner_labels, ["linux"]);
    assert.equal(flipped.body.config.secret_env.APP, "APP_TOKEN");
  });
});

// ------------------------------------------------------------------- gate 2

test("launch: a suite may only launch against its own application's rings", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const p = await project(api, "gate2");
    const { ring: own } = await createTarget(api, p, { key: "todo-web", ringKey: "local", baseUrl: "http://127.0.0.1:9" });
    const { ring: foreign } = await createTarget(api, p, { key: "other-web", ringKey: "local", baseUrl: "http://127.0.0.1:9" });
    // Two applications now, so the binding has to be explicit.
    const ambiguous = await api.post(`/projects/${p.key}/suites`, { slug: "todos", name: "Todos" });
    assert.equal(ambiguous.status, 400);
    assert.match(ambiguous.body.error.message, /"application_id" is required/);

    const suite = (await api.post(`/projects/${p.key}/suites`, { slug: "todos", name: "Todos", application_id: "todo-web" })).body;
    assert.equal(suite.application.key, "todo-web", "the binding reads back with the suite");
    const tar = writeTar(loadSuiteDir(`${REPO_ROOT}/tests/fixtures/todos`));
    assert.equal((await api.postTar(`/suites/${suite.id}/import`, tar)).status, 200);

    const crossed = await api.post(`/projects/${p.key}/run-groups`, {
      suite_id: suite.id,
      ring_id: foreign.id,
      selection: { ids: ["add-todo"] },
    });
    assert.equal(crossed.status, 400, JSON.stringify(crossed.body));
    assert.match(crossed.body.error.message, /belongs to another application/);
    assert.match(crossed.body.error.message, /suite "todos" runs against "todo-web"/);

    const ownRing = await api.post(`/projects/${p.key}/run-groups`, {
      suite_id: suite.id,
      ring_id: own.id,
      selection: { ids: ["add-todo"] },
    });
    assert.equal(ownRing.status, 200, JSON.stringify(ownRing.body));
  });
});

test("sessions: a ring cannot borrow an auth provider bound to another ring", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const p = await project(api, "gate2b");
    const { application, ring: borrower } = await createTarget(api, p, {
      key: "todo-web",
      ringKey: "local",
      baseUrl: "http://127.0.0.1:9",
      runnerLabels: ["macos"],
      // The borrower names a provider it does not own. Nothing at authoring time
      // stops it — the refusal has to happen where the reference is resolved.
      config: { auth: { identities: { member: { $session: "sso/member" } } } },
    });
    const lender = (
      await api.post(`/applications/${application.id}/rings`, { key: "prod", base_url: "https://prod.invalid" })
    ).body;
    const provider = await api.post(`/projects/${p.key}/auth-providers`, {
      name: "sso",
      kind: "storage_state_secret",
      identities: { member: { secret: "SSO_STATE" } },
      ring_id: lender.id,
    });
    assert.equal(provider.status, 201, JSON.stringify(provider.body));
    assert.equal(provider.body.ring_id, lender.id);

    // A provider may bind only a ring of its OWN project.
    const otherProject = await project(api, "gate2c");
    const { ring: outsider } = await createTarget(api, otherProject, { key: "theirs", baseUrl: "http://127.0.0.1:9" });
    const stolen = await api.post(`/projects/${p.key}/auth-providers`, {
      name: "stolen",
      kind: "storage_state_secret",
      identities: {},
      ring_id: outsider.id,
    });
    assert.equal(stolen.status, 404, JSON.stringify(stolen.body));
    assert.match(stolen.body.error.message, /no ring .* in this project/);

    const suite = await suiteWithStories(api, p);
    const groupId = (
      await api.post(`/projects/${p.key}/run-groups`, {
        suite_id: suite.id,
        ring_id: borrower.id,
        selection: { ids: ["add-todo"] },
      })
    ).body.run_group.id;
    const token = await claimAndExchange(api, base, p, groupId);

    // The runner asks for the ring's declared reference, and the resolution
    // refuses it: the provider belongs to another ring.
    const claimed = await fetch(`${base}/api/v1/runner/sessions/claim`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ sessions: ["sso/member"] }),
    }).then((r) => r.json());
    assert.match(
      claimed.sessions["sso/member"].error,
      /bound to another ring/,
      `expected a ring-scope refusal, got ${JSON.stringify(claimed)}`,
    );
  });
});

// ------------------------------------------------------------------- gate 8

test("group spec: the ring target rides the dispatch snapshot, and authored physical fields are inert", async () => {
  await withApp(async ({ api, base, app }: HostedDynamic) => {
    const p = await project(api, "gate8");
    const { ring } = await createTarget(api, p, {
      key: "todo-web",
      ringKey: "local",
      baseUrl: "http://ring.invalid:4173",
      runnerLabels: ["macos"],
      config: { app: { settle: 250 } },
    });
    const suite = (await api.post(`/projects/${p.key}/suites`, { slug: "todos", name: "Todos" })).body;
    // The suite authors a target of its own, at every level a suite can. All of
    // it stays valid for direct CLI use and none of it may redirect this run.
    assert.equal(
      (
        await api.postTar(
          `/suites/${suite.id}/import`,
          writeTar({
            "playtest.yaml": [
              "app:",
              "  base_url: http://suite-authored.invalid",
              "  envs:",
              "    local:",
              "      base_url: http://suite-local.invalid",
              "",
            ].join("\n"),
            "stories/add-todo.yaml": "story: add a todo\nsuccess:\n  - url_matches: /\n",
          }),
        )
      ).status,
      200,
    );

    const groupId = (
      await api.post(`/projects/${p.key}/run-groups`, {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: { ids: ["add-todo"] },
      })
    ).body.run_group.id;

    // The attempt recorded a non-secret target snapshot at launch.
    const dispatch = (await app.db.query(`SELECT target FROM dispatches WHERE ref_id = $1`, [groupId])).rows[0];
    assert.equal(dispatch.target.application_key, "todo-web");
    assert.equal(dispatch.target.ring_key, "local");
    assert.equal(dispatch.target.driver, "web");
    assert.equal(dispatch.target.platform, null);
    assert.equal(dispatch.target.base_url, "http://ring.invalid:4173");
    assert.deepEqual(dispatch.target.labels, ["macos"]);
    assert.deepEqual(dispatch.target.config, { app: { settle: 250 } });

    const token = await claimAndExchange(api, base, p, groupId);
    const spec = await fetch(`${base}/api/v1/runner/groups/${groupId}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    assert.equal(spec.ring.key, "local");
    assert.equal(spec.ring.base_url, "http://ring.invalid:4173");
    assert.deepEqual(spec.ring.config, { app: { settle: 250 } });
    assert.deepEqual(spec.ring.resolved_secrets, {}, "secrets resolve at serve time, never in the snapshot");
    assert.equal(spec.application.key, "todo-web");
    assert.equal(spec.application.driver, "web");
    assert.equal(spec.application.platform, null);
    assert.equal("environment" in spec, false, "the environment block is gone from the protocol");

    // A ring edit after the launch does not reach an attempt already offered:
    // the snapshot is what the group spec serves.
    assert.equal((await api.put(`/rings/${ring.id}`, { base_url: "http://moved.invalid" })).status, 200);
    const again = await fetch(`${base}/api/v1/runner/groups/${groupId}`, {
      headers: { authorization: `Bearer ${token}` },
    }).then((r) => r.json());
    assert.equal(again.ring.base_url, "http://ring.invalid:4173", "the attempt keeps the target it advertised");
  });
});

// ------------------------------------------------------------- mobile launch

test("launch: a mobile application posts to the board like any other — no URL, no build, the runner supplies it", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const p = await project(api, "mobilelaunch");
    const { application, ring } = await createTarget(api, p, {
      key: "todo-ios",
      name: "Todo iOS",
      driver: "mobile",
      platform: "ios",
      runnerLabels: ["macbook"],
    });
    const suite = (await api.post(`/projects/${p.key}/suites`, { slug: "ios", name: "iOS" })).body;
    assert.equal(
      (
        await api.postTar(
          `/suites/${suite.id}/import`,
          // No `app:` anywhere: a hosted mobile suite authors no build path,
          // and structural resolution is what lets it commit at all (gate 14).
          writeTar({
            "playtest.yaml": "app:\n  driver: mobile\n  platform: ios\n",
            "stories/tap.yaml": "story: tap something\nsuccess:\n  - screen_shows: the todo list\n",
          }),
        )
      ).status,
      200,
    );

    // The preview says what a mobile launch can honestly say: the pair, no URL,
    // and that the claiming runner supplies the build. It never claims the
    // platform inspected a binary or a device.
    const preview = await api.post(`/projects/${p.key}/run-groups/preview`, { suite_id: suite.id, ring_id: ring.id });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.target.application.key, "todo-ios");
    assert.equal(preview.body.target.application.driver, "mobile");
    assert.equal(preview.body.target.application.platform, "ios");
    assert.equal(preview.body.target.ring.key, "local");
    assert.equal(preview.body.target.resolved_base_url, null);
    assert.equal(preview.body.target.build_supplied_by_runner, true);
    assert.deepEqual(preview.body.placement.runner_labels, ["macbook"]);
    assert.equal(preview.body.placement.runner_online, false, "nothing advertising these labels has checked in");

    const launched = await api.post(`/projects/${p.key}/run-groups`, { suite_id: suite.id, ring_id: ring.id });
    assert.equal(launched.status, 200, JSON.stringify(launched.body));
    const groupId = launched.body.run_group.id;
    assert.equal(launched.body.run_group.application.driver, "mobile");
    assert.equal(launched.body.run_group.ring.base_url, null);

    // The board entry: a mobile offer carries the SAME target block every offer
    // does, with `base_url` null and `platform` set — the two fields a runner
    // decides compatibility from. Nothing else about the device travels.
    const dispatch = (await app.db.query(`SELECT * FROM dispatches WHERE ref_id = $1`, [groupId])).rows[0];
    assert.equal(dispatch.status, "requested", "nothing is started: the ledger row IS the claim-board entry");
    assert.equal(dispatch.target.application_key, "todo-ios");
    assert.equal(dispatch.target.application_id, application.id);
    assert.equal(dispatch.target.ring_key, "local");
    assert.equal(dispatch.target.driver, "mobile");
    assert.equal(dispatch.target.platform, "ios");
    assert.equal(dispatch.target.base_url, null);
    assert.deepEqual(dispatch.target.labels, ["macbook"]);
    assert.deepEqual(
      Object.keys(dispatch.target).sort(),
      ["application_id", "application_key", "base_url", "config", "driver", "labels", "platform", "ring_id", "ring_key"],
      "the target snapshot has no room for a build path, a device or an Appium endpoint",
    );
  });
});

// ------------------------------------------------------------------ gate 13

test("deletion: refused while referenced, naming the referrers; unreferenced deletes cleanly; nothing cascades", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const p = await project(api, "gate13");
    const { application, ring } = await createTarget(api, p, { key: "todo-web", ringKey: "local", baseUrl: "http://127.0.0.1:9" });

    // A ring blocks its application.
    let res = await api.del(`/applications/${application.id}`);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.error.message, /still has 1 ring \("local"\)/);

    const suite = await suiteWithStories(api, p);
    res = await api.del(`/applications/${application.id}`);
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /1 ring \("local"\) and 1 suite \("todos"\)/);

    // A ring-bound auth provider blocks its ring, and is never promoted to
    // project-wide behind anyone's back.
    const provider = (
      await api.post(`/projects/${p.key}/auth-providers`, {
        name: "sso",
        kind: "storage_state_secret",
        identities: {},
        ring_id: ring.id,
      })
    ).body;
    res = await api.del(`/rings/${ring.id}`);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.match(res.body.error.message, /1 auth provider \("sso"\)/);
    assert.equal((await api.get(`/projects/${p.key}/auth-providers`)).body.items[0].ring_id, ring.id);
    assert.equal((await api.del(`/auth-providers/${provider.id}`)).status, 204);

    // A run group blocks its ring and its application, and says how many runs.
    const groupId = (
      await api.post(`/projects/${p.key}/run-groups`, {
        suite_id: suite.id,
        ring_id: ring.id,
        selection: { ids: ["add-todo"] },
      })
    ).body.run_group.id;
    res = await api.del(`/rings/${ring.id}`);
    assert.equal(res.status, 409);
    assert.match(res.body.error.message, /1 run against it/);
    assert.match(res.body.error.message, /records where it pointed/);

    // Clear the referrers in order; each delete only becomes legal once nothing
    // points at the thing being deleted.
    await app.db.query(`DELETE FROM run_groups WHERE id = $1`, [groupId]);
    assert.equal((await api.del(`/suites/${suite.id}`)).status, 200);
    res = await api.del(`/applications/${application.id}`);
    assert.equal(res.status, 409, "the ring still blocks it");
    assert.equal((await api.del(`/rings/${ring.id}`)).status, 204);
    assert.equal((await api.del(`/applications/${application.id}`)).status, 204);
    assert.deepEqual((await api.get(`/projects/${p.key}/applications`)).body.items, []);
  });
});

// ------------------------------------------------------------------ gate 12

test("boot: a data root built by the retired schema fails with an actionable reset message", async () => {
  const dataRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "ptdata-legacy-"));
  const env = {
    PLAYTEST_DATA_DIR: dataRoot,
    PLAYTEST_AUTH: "dev",
    OBJECT_STORE_URL: path.join(dataRoot, "objects"),
    PLAYTEST_KMS_KEY: Buffer.alloc(32, 3).toString("base64"),
    LOG_LEVEL: "error",
    PLAYTEST_RATE_LIMIT_WRITES_PER_MIN: "0",
    PLAYTEST_RECONCILE_INTERVAL_S: "0",
  };
  try {
    // A normally-created root boots fine…
    const first = await createApp(loadConfig(env));
    await first.db.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, ["0017_app_artifacts.sql"]);
    await first.close();

    // …and the same root, once its ledger names a migration this build retired,
    // refuses rather than letting the forward-only migrator convert it.
    await assert.rejects(
      () => createApp(loadConfig(env)),
      (e: HostedDynamic) =>
        e instanceof ServerConfigError &&
        /0017_app_artifacts\.sql/.test(e.message) &&
        /PLAYTEST_DATA_DIR/.test(e.message) &&
        /Applications and rings replaced environments/.test(e.message) &&
        !/at Object/.test(e.message),
    );
  } finally {
    await fsp.rm(dataRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- preview

test("preview: the launch dialog is told the ring, the URL, the labels, and whether a runner is online", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const p = await project(api, "preview");
    const { ring } = await createTarget(api, p, {
      key: "todo-web",
      ringKey: "staging",
      baseUrl: "https://staging.invalid",
      runnerLabels: ["macos"],
    });
    const suite = await suiteWithStories(api, p);
    const body = { suite_id: suite.id, ring_id: ring.id, selection: { ids: ["add-todo"] } };

    let preview = (await api.post(`/projects/${p.key}/run-groups/preview`, body)).body;
    assert.equal(preview.target.application.key, "todo-web");
    assert.equal(preview.target.ring.key, "staging");
    assert.equal(preview.target.resolved_base_url, "https://staging.invalid");
    assert.equal(preview.target.build_supplied_by_runner, false);
    assert.deepEqual(preview.placement.runner_labels, ["macos"]);
    assert.equal(preview.placement.labels_source, "ring");
    assert.equal(preview.placement.runner_online, false, "nothing has checked in yet");
    assert.equal(preview.cases.length, 1);

    // A launch-time label pin overrides the ring's for this group alone.
    preview = (await api.post(`/projects/${p.key}/run-groups/preview`, { ...body, runner_labels: ["ci-42"] })).body;
    assert.deepEqual(preview.placement.runner_labels, ["ci-42"]);
    assert.equal(preview.placement.labels_source, "launch");
  });
});

/** Register a runner, claim the group's dispatch, exchange, return the bearer. */
async function claimAndExchange(api: HostedDynamic, base: HostedDynamic, p: HostedDynamic, groupId: HostedDynamic) {
  const runner = (await api.post(`/projects/${p.key}/runners`, { name: `r-${groupId.slice(-6)}`, labels: ["macos"] })).body;
  const call = (method: HostedDynamic, url: HostedDynamic, body?: HostedDynamic) =>
    fetch(`${base}/api/v1${url}`, {
      method,
      headers: { authorization: `Bearer ${runner.credential}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const offered = await call("GET", "/runner/pool/claims");
  const offer = (offered.body.offers || []).find((o: HostedDynamic) => o.run_group_id === groupId);
  assert.ok(offer, JSON.stringify(offered.body));
  const dispatchId = offer.dispatch_id;
  assert.equal((await call("POST", `/runner/pool/claims/${dispatchId}`, {})).status, 200);
  const exchanged = await call("POST", "/runner/exchange", { dispatch_id: dispatchId, isolation: "process" });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  return exchanged.body.token;
}
