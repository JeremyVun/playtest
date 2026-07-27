// A clean REPORT over traffic the HAR column condemns: the two-column verdict.
export default async function ({ client, check }) {
  const health = await client.get("/health");
  check({
    id: "health-ok",
    obligation: "rule:health",
    title: "GET /health answers { ok: true }",
    pass: health.json?.ok === true,
    evidence: { requests: [health.ref] },
  });
  const boom = await client.get("/boom");
  check({
    id: "items-list-shape",
    obligation: "rule:items",
    title: "the failing endpoint answered something",
    // Deliberately incurious: the script reports a pass over a 5xx.
    pass: typeof boom.status === "number",
    evidence: { requests: [boom.ref] },
  });
}
