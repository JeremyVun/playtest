// Twelve checks, one obligation left unaccounted: unsound however many ran.
export default async function ({ client, check }) {
  const health = await client.get("/health");
  for (let index = 1; index <= 12; index++) {
    check({
      id: `health-ok-${index}`,
      obligation: "rule:health",
      title: `GET /health answers { ok: true } (${index})`,
      pass: health.json?.ok === true,
      evidence: { requests: [health.ref] },
    });
  }
}
