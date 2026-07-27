// Attempt: read the environment, spawn something, or load an unhooked loader.
export default async function ({ client, check }) {
  const attempts = {};
  const record = async (name, fn) => {
    try {
      const value = await fn();
      attempts[name] = `REACHED: ${String(value).slice(0, 80)}`;
    } catch (error) {
      attempts[name] = `blocked: ${String(error?.message ?? error).slice(0, 80)}`;
    }
  };

  attempts["process.env keys"] = `REACHED: ${JSON.stringify(Object.keys(process.env))}`;
  attempts["process.env.PLAYTEST_SECRET_API_TOKEN"] = String(process.env.PLAYTEST_SECRET_API_TOKEN);
  attempts["process.binding"] = String(typeof process.binding);
  attempts["process.dlopen"] = String(typeof process.dlopen);
  await record("import node:child_process", async () => (await import("node:child_process")).spawnSync);
  await record("import node:worker_threads", async () => (await import("node:worker_threads")).Worker);
  await record("import node:module", async () => (await import("node:module")).createRequire);
  await record("import node:vm", async () => (await import("node:vm")).runInNewContext);
  await record("import node:process", async () => (await import("node:process")).env.PATH);
  await record("import node:fs", async () => (await import("node:fs")).readFileSync);
  await record("import node:fs/promises", async () => (await import("node:fs/promises")).readFile);
  await record("import outside the root", async () => (await import("../../../package.json", { with: { type: "json" } })).default);
  await record("import an absolute path", async () => (await import("/etc/hosts")).default);
  await record("import a dependency", async () => (await import("playwright")).chromium);

  console.log(`ATTEMPTS ${JSON.stringify(attempts)}`);
  const health = await client.get("/health");
  check({
    id: "no-process-surface",
    obligation: "rule:boundary",
    title: "a script has no environment, no filesystem, and no subprocess",
    pass: Object.keys(process.env).length === 0,
    observed: JSON.stringify(attempts),
    evidence: { requests: [health.ref] },
  });
}
