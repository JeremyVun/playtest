// Turn 3: the same suite with one revision — the guessed 400 corrected to the
// 404 the document declares for GET /widgets/{id}, now citing its evidence. The
// genuine finding (`republish-is-refused`) is untouched and still failing on a
// faulted build, which is what N5 requires: the loop terminates SOUND with the
// violation intact, not with it explained away.
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

  // ---- lifecycle ------------------------------------------------------------
  const created = await client.post("/widgets", { body: { name: "lifecycle widget" } });
  check({
    id: "new-widget-is-draft",
    obligation: "rule:lifecycle",
    title: 'a new widget is created in status "draft"',
    pass: created.status === 201 && created.json?.status === "draft",
    expected: '201 with status "draft"',
    observed: `${created.status} with status ${JSON.stringify(created.json?.status)}`,
    evidence: { requests: [created.ref] },
  });

  const id = created.json?.id;
  const published = await client.post(`/widgets/${id}/publish`);
  check({
    id: "publish-moves-to-published",
    obligation: "rule:lifecycle",
    title: 'publishing a draft moves it to "published"',
    pass: published.status === 200 && published.json?.status === "published",
    expected: '200 with status "published"',
    observed: `${published.status} with status ${JSON.stringify(published.json?.status)}`,
    evidence: { requests: [created.ref, published.ref] },
  });

  const again = await client.post(`/widgets/${id}/publish`);
  const readBack = await client.get(`/widgets/${id}`);
  check({
    id: "republish-is-refused",
    obligation: "rule:lifecycle",
    title: "publishing an already-published widget is refused with 409",
    pass: again.status === 409,
    expected: "409 already_published",
    observed: `${again.status} ${JSON.stringify(again.json)} (the widget then reads back as ${JSON.stringify(readBack.json?.status)})`,
    evidence: { requests: [published.ref, again.ref, readBack.ref] },
  });

  const missingPublish = await client.post("/widgets/no_such_widget/publish");
  check({
    id: "publish-unknown-is-404",
    obligation: "operation:POST /widgets/{id}/publish",
    title: "publishing a widget that does not exist is 404",
    pass: missingPublish.status === 404 && missingPublish.json?.error?.code === "not_found",
    expected: "404 not_found",
    observed: `${missingPublish.status} ${JSON.stringify(missingPublish.json?.error?.code)}`,
    evidence: { requests: [missingPublish.ref] },
  });

  // ---- reads ----------------------------------------------------------------
  const unknown = await client.get("/widgets/no_such_widget");
  check({
    id: "unknown-widget-read-is-404",
    obligation: "operation:GET /widgets/{id}",
    title: "reading a widget that does not exist is 404 with an error envelope",
    pass: unknown.status === 404 && unknown.json?.error?.code === "not_found",
    expected: "404 not_found",
    observed: `${unknown.status} ${JSON.stringify(unknown.json?.error?.code)}`,
    evidence: { requests: [unknown.ref] },
  });

  const invalid = await client.post("/widgets", { body: { name: "" } });
  check({
    id: "nameless-widget-is-422",
    obligation: "operation:POST /widgets",
    title: "creating a widget with no name is refused with 422",
    pass: invalid.status === 422 && invalid.json?.error?.code === "invalid_name",
    expected: "422 invalid_name",
    observed: `${invalid.status} ${JSON.stringify(invalid.json?.error?.code)}`,
    evidence: { requests: [invalid.ref] },
  });

  const drafts = await client.get("/widgets?status=draft");
  check({
    id: "status-filter-returns-only-drafts",
    obligation: "operation:GET /widgets",
    title: "?status=draft returns only draft widgets, and returns some",
    pass:
      drafts.status === 200 &&
      Array.isArray(drafts.json?.widgets) &&
      drafts.json.widgets.length > 0 &&
      drafts.json.widgets.every((widget) => widget.status === "draft"),
    expected: "200 with a non-empty list of draft widgets",
    observed: `${drafts.status} with ${drafts.json?.widgets?.length ?? 0} widget(s): ${(drafts.json?.widgets ?? []).map((widget) => widget.status).join(", ")}`,
    evidence: { requests: [drafts.ref] },
  });

  // ---- deletion -------------------------------------------------------------
  const doomed = await client.post("/widgets", { body: { name: "doomed widget" } });
  const deleted = await client.delete(`/widgets/${doomed.json?.id}`);
  const afterRead = await client.get(`/widgets/${doomed.json?.id}`);
  const afterList = await client.get("/widgets");
  check({
    id: "deleted-widget-is-gone",
    obligation: "rule:deletion",
    title: "a deleted widget answers 404 and leaves the listing",
    pass:
      deleted.status === 204 &&
      afterRead.status === 404 &&
      Array.isArray(afterList.json?.widgets) &&
      !afterList.json.widgets.some((widget) => widget.id === doomed.json?.id),
    expected: "204, then 404 on read, and absent from GET /widgets",
    observed: `delete ${deleted.status}, read ${afterRead.status}, listing ${(afterList.json?.widgets ?? []).map((widget) => widget.id).join(",")}`,
    evidence: { requests: [doomed.ref, deleted.ref, afterRead.ref, afterList.ref] },
  });

  const deleteAgain = await client.delete(`/widgets/${doomed.json?.id}`);
  check({
    id: "deleting-twice-is-404",
    obligation: "operation:DELETE /widgets/{id}",
    title: "deleting an already-deleted widget is 404",
    pass: deleteAgain.status === 404,
    expected: "404",
    observed: `${deleteAgain.status}`,
    evidence: { requests: [deleteAgain.ref] },
  });
}
