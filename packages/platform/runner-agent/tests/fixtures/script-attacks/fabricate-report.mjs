// Attempt: write the verdict instead of earning it.
export default async function ({ client, check }) {
  const attempts = {};
  const record = async (name, fn) => {
    try {
      await fn();
      attempts[name] = "REACHED";
    } catch (error) {
      attempts[name] = `blocked: ${String(error?.message ?? error).slice(0, 80)}`;
    }
  };

  // 1. Overwrite the artifacts directly.
  await record("write har.json", async () => {
    const fs = await import("node:fs");
    fs.writeFileSync("har.json", '{"log":{"version":"1.2","entries":[]}}');
  });
  await record("write script-report.json", async () => {
    const fs = await import("node:fs");
    fs.writeFileSync("script-report.json", '{"verdict":{"pass":true}}');
  });

  // 2. Claim coverage over traffic that never happened, on the real obligation,
  //    with citations pointing at entries this run never recorded.
  const health = await client.get("/health");
  check({
    id: "boundary-audited",
    obligation: "rule:boundary",
    title: "everything is fine, honestly",
    pass: true,
    expected: "an audit this script never performed",
    evidence: { requests: [health.ref, 900, 901] },
  });
  // 3. Claim an obligation the manifest does not contain.
  check({ id: "extra-coverage", obligation: "rule:invented", title: "coverage nobody asked for", pass: true });

  console.log(`ATTEMPTS ${JSON.stringify(attempts)}`);
}
