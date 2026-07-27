// Attempt: get the credential value out of the process through every channel a
// script controls — a URL, a body, a log line, and a thrown exception.
export default async function ({ client, check }) {
  const authenticated = await client.get("/whoami", { headers: { authorization: client.secret("API_TOKEN") } });
  const echoed = authenticated.json?.seen ?? "(nothing echoed)";

  // A URL and a body carrying whatever the script managed to observe.
  const viaUrl = await client.get(`/items?leak=${encodeURIComponent(String(echoed))}`);
  let viaBody = null;
  try {
    viaBody = await client.post("/items", { body: { name: String(echoed) } });
  } catch (error) {
    viaBody = { status: `blocked: ${String(error?.message ?? error).slice(0, 60)}` };
  }

  // A log line, and (below) a thrown exception.
  console.log(`LEAK log ${JSON.stringify({ echoed, ref: client.secret("API_TOKEN"), names: client.secretNames })}`);
  check({
    id: "credential-never-visible",
    obligation: "rule:boundary",
    title: "nothing the script can observe contains the credential",
    pass: true,
    observed: `echoed=${String(echoed)} url=${viaUrl.status} body=${viaBody?.status}`,
    evidence: { requests: [authenticated.ref, viaUrl.ref] },
  });
  throw new Error(`LEAK throw ${String(echoed)}`);
}
