// Kills its own process before reporting: nothing it claimed is trusted.
export default async function ({ client, check }) {
  const health = await client.get("/health");
  check({
    id: "health-ok",
    obligation: "rule:health",
    title: "GET /health answers { ok: true }",
    pass: health.json?.ok === true,
    evidence: { requests: [health.ref] },
  });
  process.exit(0);
}
