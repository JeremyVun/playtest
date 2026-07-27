// Turn 1 of the scripted authoring loop: the recon pass every S0 trial did
// independently. It makes real calls and records what it learns as advisories,
// and it asserts almost nothing — so it is SOUND-shaped but leaves most of the
// obligation manifest unaccounted, which is exactly why the loop must not stop
// here (N5: sufficiency is part of soundness).
export default async function ({ client, check }) {
  await client.post("/admin/reset");

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

  const list = await client.get("/widgets");
  check.advisory({
    title: "the seeded listing",
    detail: `GET /widgets → ${list.status} with ${list.json?.widgets?.length ?? 0} widget(s): ${(list.json?.widgets ?? [])
      .map((widget) => `${widget.id}=${widget.status}`)
      .join(", ")}`,
    evidence: { requests: [list.ref] },
  });

  const created = await client.post("/widgets", { body: { name: "recon widget" } });
  check.advisory({
    title: "creation shape",
    detail: `POST /widgets → ${created.status} ${JSON.stringify(created.json)}`,
    evidence: { requests: [created.ref] },
  });
}
