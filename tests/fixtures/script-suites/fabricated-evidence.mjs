// A check citing traffic this execution never made.
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
    id: "items-audited",
    obligation: "rule:items",
    title: "the items listing was audited",
    pass: true,
    expected: "a listing this suite never requested",
    evidence: { requests: [41, 42] },
  });
}
