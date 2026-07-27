// The script's own defect channel: it could not build the state a check needed.
export default async function ({ client, check }) {
  const health = await client.get("/health");
  check({
    id: "health-ok",
    obligation: "rule:health",
    title: "GET /health answers { ok: true }",
    pass: health.json?.ok === true,
    evidence: { requests: [health.ref] },
  });
  const missing = await client.get("/items/does-not-exist");
  check.defect({
    message: "could not read back an item, so the items rule was never reachable",
    detail: `GET /items/does-not-exist answered ${missing.status}`,
    evidence: { requests: [missing.ref] },
  });
}
