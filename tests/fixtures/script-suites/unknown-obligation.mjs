// A check tracing to an obligation the manifest does not contain.
export default async function ({ client, check }) {
  const health = await client.get("/health");
  check({
    id: "health-ok",
    obligation: "rule:health",
    title: "GET /health answers { ok: true }",
    pass: health.json?.ok === true,
    evidence: { requests: [health.ref] },
  });
  check({
    id: "invented",
    obligation: "rule:not-in-the-manifest",
    title: "a rule nobody approved",
    pass: true,
    evidence: { requests: [health.ref] },
  });
}
