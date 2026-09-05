import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { makeClient } from "../integration/helpers.ts";

const base = process.env.PLAYTEST_TEST_COMPOSE_URL;
if (!base || new URL(base).hostname !== "127.0.0.1") throw new Error("PLAYTEST_TEST_COMPOSE_URL must name the disposable local Compose UI");
const api = makeClient(base), exec = promisify(execFile);
const docker = async (...args: string[]) => (await exec("docker", args, { timeout: 60000 })).stdout.trim();
const ready = async () => {
  try { return await docker("exec", "playtest-local-control-plane-1", "node", "-e", "fetch('http://127.0.0.1:4177/readyz').then(r=>console.log(r.status)).catch(()=>console.log(0))") === "200"; }
  catch { return false; }
};
async function waitFor(predicate: () => Promise<boolean>, label: string, timeout = 90000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await new Promise(r => setTimeout(r, 1000)); }
  assert.fail(label);
}

test("real Compose: restart preserves objects, runner identity and KMS; dependency loss removes readiness", { timeout: 300000 }, async () => {
  let project: HostedDynamic;
  try {
    project = (await api.post("/projects", { key: `recreation-${Date.now()}`, name: "Recreation verification" })).body;
    assert.equal((await api.post(`/projects/${project.key}/personas`, { name: "Persistent reader", description: "Survives container restart." })).status, 201);
    assert.equal((await api.post(`/projects/${project.key}/secrets`, { name: "test", value: "disposable recreation secret" })).status, 201);
    const identity = await docker("exec", "playtest-local-control-plane-1", "node", "--input-type=module", "-e", "import pg from 'pg';const db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();console.log(JSON.stringify((await db.query(\"SELECT id,credential_hash FROM runners WHERE name='compose'\")).rows));await db.end();");
    await docker("restart", "--time", "45", "playtest-local-runner-1", "playtest-local-control-plane-1");
    await waitFor(ready, "control plane did not regain readiness");
    assert.equal((await api.get(`/projects/${project.key}/personas`)).body.items.find((p: HostedDynamic) => p.name === "Persistent reader").description, "Survives container restart.");
    const verify = `import pg from 'pg';const {loadConfig}=await import(${JSON.stringify('file:///opt/playtest/packages/platform/control-plane/src/config.ts')});const {decryptSecret}=await import(${JSON.stringify('file:///opt/playtest/packages/platform/control-plane/src/crypto/secrets.ts')});const {makeObjectStore}=await import(${JSON.stringify('file:///opt/playtest/packages/platform/control-plane/src/store/object-store.ts')});const config=loadConfig();const db=new pg.Client({connectionString:config.databaseUrl});await db.connect();const row=(await db.query('SELECT ciphertext FROM secrets WHERE project_id=$1',[${JSON.stringify(project.id)}])).rows[0];if(decryptSecret(config.kmsKey,row.ciphertext)!=='disposable recreation secret')throw new Error('decryption failed');const store=makeObjectStore(config.objectStore);const persona=(await db.query('SELECT blob_sha256 FROM personas WHERE project_id=$1',[${JSON.stringify(project.id)}])).rows[0];await store.get('blobs/'+persona.blob_sha256);store.close();console.log(JSON.stringify((await db.query("SELECT id,credential_hash FROM runners WHERE name='compose'")).rows));await db.end();`;
    assert.equal(await docker("exec", "playtest-local-control-plane-1", "node", "--input-type=module", "-e", verify), identity);
    await docker("stop", "--time", "10", "playtest-local-objects-1");
    await waitFor(async () => !await ready(), "object outage did not remove readiness");
    await docker("start", "playtest-local-objects-1");
    await waitFor(ready, "object recovery did not restore readiness");
    const started = await docker("inspect", "playtest-local-control-plane-1", "--format", "{{.State.StartedAt}}");
    await docker("stop", "--time", "10", "playtest-local-postgres-1");
    await waitFor(async () => !await ready(), "database disconnect did not close admission");
    await docker("start", "playtest-local-postgres-1");
    await waitFor(ready, "database recovery did not restore readiness");
    assert.notEqual(await docker("inspect", "playtest-local-control-plane-1", "--format", "{{.State.StartedAt}}"), started, "lost writer connection requires a fresh process");
    assert.equal((await api.get(`/projects/${project.key}/personas`)).status, 200);
  } finally {
    await docker("start", "playtest-local-objects-1", "playtest-local-postgres-1");
    await waitFor(ready, "restore local dependencies after verification");
    if (project?.id) await api.del(`/projects/${project.key}`, {});
  }
});
