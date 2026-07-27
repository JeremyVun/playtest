// params.reason decides whether the skip cites an APPROVED reason.
export default async function ({ client, check, params }) {
  const health = await client.get("/health");
  check({
    id: "health-ok",
    obligation: "rule:health",
    title: "GET /health answers { ok: true }",
    pass: health.json?.ok === true,
    evidence: { requests: [health.ref] },
  });
  check.skip({ obligation: "rule:items", reason: params.reason });
}
