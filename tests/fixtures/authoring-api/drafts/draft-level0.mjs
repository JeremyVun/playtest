// The suite an author writes when the owner approved NO rule cards at all.
//
// There is no `rule:` obligation to cover, so every check traces to an
// `operation:` obligation and the four Level 0 policies do the semantic work
// they can do from the document alone. This is the floor of DESIGN N6: a user
// who answers nothing still gets a real suite that exercises every operation
// and is judged by the shipped Tier-1/2 policies over its own traffic.
//
// It is also the floor's honest limit. The fixture's seeded republish fault is
// live while this suite runs, and nothing here catches it: a second publish
// answering 200 is a documented status carrying a schema-valid body. Only an
// approved rule about the lifecycle makes that visible — which is the whole
// argument for Level 1.
export default async function ({ client, check }) {
  await client.post("/admin/reset");
  check.advisory({ title: "reset", detail: "the fixture was returned to its seeded state" });

  const health = await client.get("/health");
  check({
    id: "health-answers-ok",
    obligation: "operation:GET /health",
    title: "GET /health answers { ok: true }",
    pass: health.status === 200 && health.json?.ok === true,
    expected: "200 { ok: true }",
    observed: `${health.status} ${JSON.stringify(health.json)}`,
    evidence: { requests: [health.ref] },
  });

  const listing = await client.get("/widgets");
  check({
    id: "listing-is-a-widget-array",
    obligation: "operation:GET /widgets",
    title: "GET /widgets answers a list of widgets",
    pass: listing.status === 200 && Array.isArray(listing.json?.widgets),
    expected: "200 with a widgets array",
    observed: `${listing.status} with ${JSON.stringify(Object.keys(listing.json ?? {}))}`,
    evidence: { requests: [listing.ref] },
  });

  const created = await client.post("/widgets", { body: { name: "level zero widget" } });
  check({
    id: "creation-answers-201-with-an-id",
    obligation: "operation:POST /widgets",
    title: "POST /widgets answers 201 with an id",
    pass: created.status === 201 && typeof created.json?.id === "string",
    expected: "201 with an id",
    observed: `${created.status} ${JSON.stringify(created.json?.id ?? null)}`,
    evidence: { requests: [created.ref] },
  });

  const id = created.json?.id;
  const read = await client.get(`/widgets/${id}`);
  check({
    id: "a-created-widget-reads-back",
    obligation: "operation:GET /widgets/{id}",
    title: "a created widget reads back by id",
    pass: read.status === 200 && read.json?.id === id,
    expected: `200 with id ${id}`,
    observed: `${read.status} ${JSON.stringify(read.json?.id ?? null)}`,
    evidence: { requests: [created.ref, read.ref] },
  });

  const published = await client.post(`/widgets/${id}/publish`);
  check({
    id: "publish-answers-a-documented-status",
    obligation: "operation:POST /widgets/{id}/publish",
    title: "publishing a draft answers 200",
    pass: published.status === 200,
    expected: "200",
    observed: `${published.status}`,
    evidence: { requests: [published.ref] },
  });

  const deleted = await client.delete(`/widgets/${id}`);
  check({
    id: "delete-answers-204",
    obligation: "operation:DELETE /widgets/{id}",
    title: "deleting a widget answers 204",
    pass: deleted.status === 204,
    expected: "204",
    observed: `${deleted.status}`,
    evidence: { requests: [deleted.ref] },
  });

  const reset = await client.post("/admin/reset");
  check({
    id: "reset-answers-ok",
    obligation: "operation:POST /admin/reset",
    title: "POST /admin/reset restores the seeded state",
    pass: reset.status === 204,
    expected: "204",
    observed: `${reset.status}`,
    evidence: { requests: [reset.ref] },
  });
}
