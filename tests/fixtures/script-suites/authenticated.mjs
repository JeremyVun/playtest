// Secret injection: the script causes an authenticated request and reports what
// it could see of the credential (which must be nothing).
export default async function ({ client, check }) {
  const anonymous = await client.get("/whoami");
  check({
    id: "whoami-requires-a-token",
    obligation: "rule:auth",
    title: "GET /whoami refuses an unauthenticated caller",
    pass: anonymous.status === 401,
    observed: `status ${anonymous.status}`,
    evidence: { requests: [anonymous.ref] },
  });
  const authenticated = await client.get("/whoami", { headers: { authorization: client.secret("API_TOKEN") } });
  check({
    id: "injected-credential-authenticates",
    obligation: "rule:health",
    title: "an injected secret reference authenticates the request",
    pass: authenticated.status === 200 && authenticated.json?.ok === true,
    observed: `status ${authenticated.status} body ${authenticated.text}`,
    evidence: { requests: [authenticated.ref] },
  });
  // Everything the script can see about the credential, printed to its log and
  // into the report: the test greps all of it.
  const visible = JSON.stringify({
    echo: authenticated.json?.seen ?? null,
    names: client.secretNames,
    ref: client.secret("API_TOKEN"),
  });
  console.log(`script-visible: ${visible}`);
  check.advisory({ title: "script-visible credential surface", detail: visible });
}
