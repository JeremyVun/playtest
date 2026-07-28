// Regressions for the correctness/security fixes from the Phase 1 review: the
// validate/lint code-execution gate, snapshot-tree correctness under concurrent
// commits, open-redirect hardening, user-enumeration restriction, and the API 404.
import { test } from "node:test";
import assert from "node:assert/strict";
import { withApp, createTarget } from "./helpers.ts";
import { contentTree } from "../../src/suites/snapshots.ts";

const RCE = 'import("node:fs").then(f=>f.writeFileSync("/tmp/pt-should-not-exist","x"));\nexport default { keys() { return []; }, gather() { return {}; }, verdict() { return { pass: true }; } };\n';

test("validate/lint: uncommitted assertion code needs developer (no viewer/editor RCE)", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "p", name: "P" })).body;
    await createTarget(api, project);
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    // A committed suite with a case (so discovery would import assertions).
    await api.post(`/suites/${suite.id}/commit`, {
      changes: [
        { path: "playtest.yaml", content: "app:\n  base_url: http://x\n" },
        { path: "stories/a.yaml", content: "story: a\nsuccess:\n  - assert: ok\n" },
      ],
      note: "seed",
    });
    const editor = (await api.post("/projects/p/tokens", { role: "editor", name: "e" })).body.token;
    const asEditor = api.withToken(editor);

    const change = { changes: [{ path: "assertions/evil/assertion.js", content: RCE }] };
    assert.equal((await asEditor.post(`/suites/${suite.id}/validate`, change)).status, 403);
    assert.equal((await asEditor.post(`/suites/${suite.id}/lint`, change)).status, 403);
    // A developer may edit code (it's theirs to run) — proven with a benign assertion
    // so the gate is role-based, not a blanket block, without executing the payload.
    const benign = { changes: [{ path: "assertions/ok/assertion.js", content: 'export default { keys() { return []; }, gather() { return {}; }, verdict() { return { pass: true }; } };\n' }] };
    assert.equal((await api.post(`/suites/${suite.id}/validate`, benign)).status, 200);
  });
});

test("concurrent commits to different paths keep the latest snapshot tree == suite_files", async () => {
  await withApp(async ({ api, app }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "p", name: "P" })).body;
    await createTarget(api, project);
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    await api.post(`/suites/${suite.id}/commit`, {
      changes: [
        { path: "playtest.yaml", content: "app:\n  base_url: http://x\n" },
        { path: "stories/a.yaml", content: "story: a1\nsuccess:\n  - assert: ok\n" },
        { path: "stories/b.yaml", content: "story: b1\nsuccess:\n  - assert: ok\n" },
      ],
      note: "seed",
    });
    // Two commits to DIFFERENT files, fired together.
    await Promise.all([
      api.put(`/suites/${suite.id}/files/stories/a.yaml`, { content: "story: a2\nsuccess:\n  - assert: ok\n" }),
      api.put(`/suites/${suite.id}/files/stories/b.yaml`, { content: "story: b2\nsuccess:\n  - assert: ok\n" }),
    ]);
    // The newest snapshot's tree must equal the actual working set — the invariant the
    // out-of-lock read used to break.
    const files = (await app.db.query(`SELECT path, content FROM suite_files WHERE suite_id = $1`, [suite.id])).rows;
    const working = Object.fromEntries(files.map((r: HostedDynamic) => [r.path, r.content]));
    const latest = (await app.db.query(`SELECT tree FROM suite_snapshots WHERE suite_id = $1 ORDER BY seq DESC LIMIT 1`, [suite.id])).rows[0].tree;
    assert.deepEqual(latest, contentTree(working));
    // Both edits landed.
    assert.match(working["stories/a.yaml"], /a2/);
    assert.match(working["stories/b.yaml"], /b2/);
  });
});

test("duplicate-create races: never a raw 500, always a friendly conflict", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    // --- sequential: the pre-check path ---
    const project = (await api.post("/projects", { key: "p", name: "P" })).body;
    const { application } = await createTarget(api, project);
    const dup = await api.post("/projects", { key: "p", name: "P again" });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, "conflict");

    // --- concurrent: the pre-check races past, so the INSERT's own unique-violation
    // catch is what must answer 409 — one creator wins 201, the other gets 409, and
    // neither ever sees a raw pg 23505 as a 500. Same shape for suites (project_id,
    // slug), applications (project_id, key) and rings (application_id, key).
    const projectRace: HostedDynamic = await Promise.allSettled([
      api.post("/projects", { key: "race", name: "R1" }),
      api.post("/projects", { key: "race", name: "R2" }),
    ]);
    assert.deepEqual(projectRace.map((r: HostedDynamic) => r.value.status).sort(), [201, 409]);

    const suiteRace: HostedDynamic = await Promise.allSettled([
      api.post("/projects/p/suites", { slug: "race", name: "S1" }),
      api.post("/projects/p/suites", { slug: "race", name: "S2" }),
    ]);
    assert.deepEqual(suiteRace.map((r: HostedDynamic) => r.value.status).sort(), [201, 409]);

    const applicationRace: HostedDynamic = await Promise.allSettled([
      api.post("/projects/p/applications", { key: "race", name: "A1", driver: "web" }),
      api.post("/projects/p/applications", { key: "race", name: "A2", driver: "web" }),
    ]);
    assert.deepEqual(applicationRace.map((r: HostedDynamic) => r.value.status).sort(), [201, 409]);

    const ringRace: HostedDynamic = await Promise.allSettled([
      api.post(`/applications/${application.id}/rings`, { key: "race", base_url: "http://127.0.0.1:9" }),
      api.post(`/applications/${application.id}/rings`, { key: "race", base_url: "http://127.0.0.1:9" }),
    ]);
    assert.deepEqual(ringRace.map((r: HostedDynamic) => r.value.status).sort(), [201, 409]);
  });
});

test("open redirect: a backslash/protocol-relative returnTo is neutralized to /", async () => {
  await withApp(async ({ base }: HostedDynamic) => {
    const evil = [
      "/%5Cevil.com", // /\evil.com
      "//evil.com",
      "https://evil.com",
      // control/whitespace bypasses: a tab/newline/space as the 2nd byte is stripped
      // by the browser before parsing, so `/\t/evil.com` resolves to //evil.com.
      "/%09/evil.com",
      "/%0A/evil.com",
      "/%0D/evil.com",
      "/%20/evil.com",
      "%09//evil.com", // leading control byte
    ];
    for (const returnTo of evil) {
      const res = await fetch(`${base}/auth/login?returnTo=${returnTo}`, { redirect: "manual" });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get("location"), "/", `returnTo=${returnTo} must sanitize to /`);
    }
    // a legitimate same-origin path is preserved
    const ok = await fetch(`${base}/auth/login?returnTo=/projects/todos/suites`, { redirect: "manual" });
    assert.equal(ok.headers.get("location"), "/projects/todos/suites");
  });
});

test("user lookup: restricted to project admins", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    // dev admin can look up
    assert.equal((await api.get("/users?email=dev@localhost")).status, 200);
    // an editor token cannot enumerate
    const editor = (await api.post("/projects/p/tokens", { role: "editor", name: "e" })).body.token;
    assert.equal((await api.withToken(editor).get("/users?email=dev@localhost")).status, 403);
  });
});

test("session cookie: HttpOnly + SameSite always, Secure only when publicUrl is https", async () => {
  await withApp(async ({ base }: HostedDynamic) => {
    const res = await fetch(`${base}/auth/login?returnTo=/`, { redirect: "manual" });
    assert.equal(res.status, 302);
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("pt_session="));
    assert.ok(session, "login must set the pt_session cookie");
    assert.match(session, /(^|;\s*)HttpOnly(;|$)/i);
    assert.match(session, /(^|;\s*)SameSite=Lax(;|$)/i);
    // The harness listens on plain http, so with the default (http) publicUrl the
    // cookie must NOT claim Secure — a false Secure would make the browser drop it.
    assert.doesNotMatch(session, /(^|;\s*)Secure(;|$)/i);
  });
  await withApp(async ({ base }: HostedDynamic) => {
    const res = await fetch(`${base}/auth/login?returnTo=/`, { redirect: "manual" });
    const session: HostedDynamic = res.headers.getSetCookie().find((c) => c.startsWith("pt_session="));
    assert.match(session, /(^|;\s*)Secure(;|$)/i);
  }, { PUBLIC_URL: "https://example.test" });
});

test("validate: a malformed JSON body surfaces a friendly 400, not a swallowed empty body", async () => {
  await withApp(async ({ api, base }: HostedDynamic) => {
    const project = (await api.post("/projects", { key: "p", name: "P" })).body;
    await createTarget(api, project);
    const suite = (await api.post("/projects/p/suites", { slug: "s", name: "S" })).body;
    const res = await fetch(`${base}/api/v1/suites/${suite.id}/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, "bad_request");
    assert.match(body.error.message, /invalid JSON/);
  });
});

test("audit: an unparseable since= is a friendly 400, not a raw pg error", async () => {
  await withApp(async ({ api }: HostedDynamic) => {
    await api.post("/projects", { key: "p", name: "P" });
    const res = await api.get("/projects/p/audit?since=garbage");
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "bad_request");
    assert.match(res.body.error.message, /since/);
    // a real timestamp still works
    assert.equal((await api.get("/projects/p/audit?since=2024-01-01T00:00:00Z")).status, 200);
  });
});

test("api: an unknown /api path returns a JSON 404 envelope, not SPA html", async () => {
  await withApp(async ({ base }: HostedDynamic) => {
    const res = await fetch(`${base}/api/v1/does-not-exist`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") || "", /application\/json/);
    assert.equal((await res.json()).error.code, "not_found");
  });
});
