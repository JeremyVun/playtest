// Versions (suite snapshot history, reached from the suite's ⋯ menu). Every commit is one
// immutable snapshot; this is the audit-friendly timeline (seq, note, who, when)
// with per-version export so any past state round-trips to the CLI.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link } from "../lib/router.js";
import { renderFrame, page } from "../lib/shell.js";
import { state, hasRole } from "../lib/state.js";
import { toast, toastError, emptyState, errorState, confirmModal } from "../lib/ui.js";
import { getSuiteBySlug } from "./suite.js";

export async function historyPage(projectKey: WebDynamic, slug: WebDynamic) {
  const main = renderFrame({ projectKey, nav: "suites" });
  const project = state.projectByKey.get(projectKey);
  mount(main, page({ title: "Versions", body: h("div.dim", {}, "Loading…") }));

  let suite, snaps;
  try {
    suite = await getSuiteBySlug(projectKey, slug);
    if (!suite) return mount(main, page({ title: slug, body: h("div.dim", {}, "No such suite.") }));
    ({ items: snaps } = await api.get(`/suites/${suite.id}/snapshots?limit=100`));
  } catch (err: WebDynamic) {
    return mount(main, page({ title: "History", body: errorState(err, () => historyPage(projectKey, slug)) }));
  }

  // Import promises "you can restore this from Versions", and until now the
  // only action here was Export — the promise was false. Restore round-trips a
  // version through the same export/import pair the CLI uses, which makes the
  // restore itself one more immutable version rather than a rewrite of history.
  const latest = snaps[0]?.id;
  const canEdit = hasRole(project.id, "editor");
  const body = snaps.length
    ? h("div.card", {}, h("table.rows", {},
        h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "What changed"), h("th", {}, "By"), h("th", {}, "When"), h("th", {}))),
        h("tbody", {}, ...snaps.map((s: WebDynamic) => h("tr", {},
          h("td.mono", {}, `#${s.seq}`),
          h("td", {}, s.note || h("span.faint", {}, "—")),
          h("td.dim", {}, s.created_by_email || "—"),
          h("td.dim", {}, new Date(s.created_at).toLocaleString()),
          h("td", { style: "text-align:right;white-space:nowrap" },
            canEdit && s.id !== latest
              ? h("button.btn.btn-sm", {
                  style: "margin-right:6px",
                  "aria-label": `Restore version ${s.seq}`,
                  onclick: (e: WebDynamic) => restoreSnap(projectKey, slug, suite, s, e.currentTarget),
                }, "Restore")
              : null,
            h("button.btn.btn-sm", { "aria-label": `Export version ${s.seq}`, onclick: () => exportSnap(suite, s) }, "Export")),
        ))),
      ))
    : emptyState("No versions yet", "Every save to this suite's files will appear here as an immutable version.");

  mount(main, page({
    crumbs: [link(`/p/${projectKey}`, "Suites"), " / ", link(`/p/${projectKey}/suites/${slug}`, suite.name || slug), " / ", "Versions"],
    title: "Versions",
    sub: `every save is an immutable version of this suite's files · ${snaps.length} ${snaps.length === 1 ? "version" : "versions"}`,
    body,
  }));
}

/** Put an earlier version back, as a new version on top. Nothing is erased. */
async function restoreSnap(projectKey: WebDynamic, slug: WebDynamic, suite: WebDynamic, snap: WebDynamic, btn: WebDynamic) {
  const ok = await confirmModal({
    title: `Restore version #${snap.seq}?`,
    body: `This suite's files go back to how they were at #${snap.seq}${snap.note ? ` ("${snap.note}")` : ""}. Nothing is lost — the current files stay as their own version, so you can come back.`,
    confirmLabel: "Restore",
  });
  if (!ok) return;
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Restoring…"; }
  try {
    const blob = await api.blob(`/suites/${suite.id}/export?snapshot=${snap.id}`);
    await api.postRaw(`/suites/${suite.id}/import`, await blob.arrayBuffer(), "application/x-tar");
    toast("Restored", `this suite is back to version #${snap.seq}`, "ok");
    historyPage(projectKey, slug);
  } catch (err: WebDynamic) {
    toastError(err);
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

async function exportSnap(suite: WebDynamic, snap: WebDynamic) {
  try {
    const blob = await api.blob(`/suites/${suite.id}/export?snapshot=${snap.id}`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${suite.slug}-v${snap.seq}.tar`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (err: WebDynamic) { toastError(err); }
}
