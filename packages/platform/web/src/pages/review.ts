// Changed stories (UX "Review queue"): the reviewer's whole world — evidence and
// two buttons. Rows expand to the inline diff (the compact diff_ops projection
// of the same diffTracks pair the viewer's diff tab renders), accept confirms
// before promoting, and a concurrent resolution renders as a quiet supersede
// note, never an error page. Keyboard: j/k navigate, Enter expands, a/r act.
import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { link, onPageLeave } from "../lib/router.js";
import { renderFrame, page, refreshReviewBadge } from "../lib/shell.js";
import { state, hasRole } from "../lib/state.js";
import { statusChip, toast, toastError, emptyState, errorState, confirmModal } from "../lib/ui.js";
import { ago, clamp } from "../lib/labels.js";
import { subscribeFeed } from "../lib/feed.js";

let live: WebDynamic = null;
function stopLive() {
  if (!live) return;
  live.sub?.stop();
  clearTimeout(live.refetchTimer);
  if (live.keyHandler) document.removeEventListener("keydown", live.keyHandler);
  live = null;
}

export async function reviewPage(projectKey: WebDynamic) {
  stopLive();
  const main = renderFrame({ projectKey, nav: "review" });
  const project = state.projectByKey.get(projectKey);
  if (!project) return mount(main, page({ title: "Changed stories", body: emptyState("Not found", "No such project.") }));
  mount(main, page({ title: "Changed stories", body: h("div.dim", {}, "Loading…") }));

  const ctl: WebDynamic = {
    items: [],
    sel: -1,           // keyboard cursor over actionable (pending) rows
    // Expanded rows live in ?open= so a viewer round-trip (back button, or the
    // pending-review banner's link) restores the reviewer's place.
    open: new Set((new URLSearchParams(location.search).get("open") || "").split(",").filter(Boolean)),
    detail: new Map(), // candidate id → GET /candidates/:c result
    conflict: new Map(), // candidate id → 409 details (supersede notes)
  };

  // Identity token: async callbacks from a superseded page instance do nothing
  // (the router's onPageLeave stops the live pieces on navigation).
  const token: WebDynamic = {};
  const current = () => live?.token === token;

  async function load() {
    try {
      // One unfiltered read: pending rows arrive with their diff summary, and
      // recently resolved rows render dimmed below (server orders newest-first).
      const { items } = await api.get(`/projects/${projectKey}/candidates?limit=50`);
      if (!current()) return;
      ctl.items = items;
      if (ctl.sel >= pendings().length) ctl.sel = pendings().length - 1;
      paint();
    } catch (err: WebDynamic) {
      if (current()) mount(main, page({ title: "Changed stories", body: errorState(err, load) }));
    }
  }

  live = {
    token,
    refetchTimer: null,
    sub: subscribeFeed(projectKey, {
      types: ["candidate.created", "candidate.accepted", "candidate.rejected", "candidate.superseded"],
      onEvent: () => {
        if (!current()) return;
        clearTimeout(live.refetchTimer);
        live.refetchTimer = setTimeout(load, 300);
      },
    }),
  };

  live.keyHandler = (e: WebDynamic) => {
    if (!current()) return;
    if (e.target.matches("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
    const rows = pendings();
    if (!rows.length) return;
    if (e.key === "j") { ctl.sel = Math.min(ctl.sel + 1, rows.length - 1); paint(); }
    else if (e.key === "k") { ctl.sel = Math.max(ctl.sel - 1, 0); paint(); }
    else if (ctl.sel >= 0 && ctl.sel < rows.length) {
      const c = rows[ctl.sel];
      if (e.key === "Enter") toggleExpand(c);
      else if (e.key === "a") resolve(c, "accept");
      else if (e.key === "r") resolve(c, "reject");
    }
  };
  document.addEventListener("keydown", live.keyHandler);
  onPageLeave(stopLive);

  await load();

  function pendings() {
    return ctl.items.filter((c: WebDynamic) => c.status === "pending");
  }

  function paint() {
    if (!current()) return;
    const pending = pendings();
    const rows = pending;
    // Resolved-recently tail always shows dimmed below pending — reviewers need
    // to see what their team just decided. There is no historical "All" tab:
    // resolved history lives on story history and in Audit.
    const tail = ctl.items.filter((c: WebDynamic) => c.status !== "pending").slice(0, 8);

    const body = rows.length + tail.length
      ? h("div.stack", {},
          h("div.card", {}, h("div.review-list", {}, ...rows.map(row), ...tail.map(row))),
          pending.length ? h("div.faint", { style: "font-size:12px" }, "j/k to move · Enter to expand · a accept · r reject") : null,
        )
      : emptyState("Nothing to review",
          "When a story's saved path stops reproducing, the actor finds its own way to the goal — the run passes, but the path changed. " +
          "Those stories land here for a person to accept the new path, or reject it.");

    // The list repaints on feed events — put the caret back if the reviewer
    // was mid-note (inputs carry stable ids and values survive in `notes`).
    const focused = document.activeElement?.id;
    mount(main, page({
      crumbs: [link(`/p/${projectKey}/runs`, "Runs"), " / ", "Changed stories"],
      title: "Changed stories",
      sub: pending.length
        ? `${pending.length} ${pending.length === 1 ? "story" : "stories"} took a different path and ${pending.length === 1 ? "is" : "are"} waiting for a decision`
        : "stories whose saved path changed",
      body,
    }));
    if (focused) {
      const el = document.getElementById(focused);
      if (el) { el.focus(); el.setSelectionRange?.(el.value.length, el.value.length); }
    }
  }

  function row(c: WebDynamic) {
    const isPending = c.status === "pending";
    const selected = isPending && pendings()[ctl.sel]?.id === c.id;
    const expanded = ctl.open.has(c.id);
    const conflict = ctl.conflict.get(c.id);

    const head = h("div.review-head", {
      role: "button", tabindex: "0",
      onclick: () => isPending && toggleExpand(c),
      onkeydown: (e: WebDynamic) => { if (e.key === "Enter" && isPending) toggleExpand(c); },
    },
      isPending ? statusChip("changed", "changed") : resolvedChip(c),
      h("span.id", {}, `${c.suite_slug}/${c.case_id}`),
      h("span.dim", {}, ago(c.created_at)),
      c.diff_summary
        ? h("span.diffsum", {},
            `${c.diff_summary.same} same · `,
            h("span.del", {}, `${c.diff_summary.del} removed`), " · ",
            h("span.add", {}, `${c.diff_summary.add} added`))
        : isPending ? h("span.faint", {}, "diff unavailable — bundle missing or pruned") : null,
      c.score != null ? h("span.dim", { style: "margin-left:auto", title: "Grader score — a trend, not a verdict" }, `score ${c.score}`) : h("span", { style: "margin-left:auto" }),
    );

    const parts: WebDynamic = [head];
    if (conflict) {
      parts.push(h("div.dim.review-conflict", {},
        `already ${conflict.status || "resolved"}${conflict.resolved_at ? ` · ${ago(conflict.resolved_at)}` : ""} — the queue has moved on`));
    }
    if (isPending && expanded) parts.push(expandPanel(c));
    if (!isPending) {
      parts.push(h("div.faint.review-resolved-line", {},
        `${c.status}${c.resolved_by_name ? ` by ${c.resolved_by_name}` : ""}${c.resolved_at ? ` · ${ago(c.resolved_at)}` : ""}`));
    }
    return h(`div.review-row${selected ? ".selected" : ""}${isPending ? "" : ".resolved"}`, { "data-cid": c.id }, ...parts);
  }

  function resolvedChip(c: WebDynamic) {
    if (c.status === "accepted") return statusChip("pass", "accepted");
    if (c.status === "rejected") return statusChip("fail", "rejected");
    return statusChip("neutral", c.status); // superseded
  }

  function expandPanel(c: WebDynamic) {
    const detail = ctl.detail.get(c.id);
    const body = h("div.review-expand", {},
      c.story ? h("div.dim.review-story", {}, clamp(c.story)) : null,
      detail ? diffTable(detail) : h("div.dim", {}, "Loading diff…"),
      h("div.review-actions", {},
        noteInput(c),
        h("button.btn", { onclick: () => resolve(c, "reject") }, "Reject"),
        h("button.btn.primary", { onclick: () => resolve(c, "accept") }, "Accept ✓"),
      ),
    );
    if (!detail) fetchDetail(c);
    return body;
  }

  function noteInput(c: WebDynamic) {
    const input = h("input", {
      type: "text", placeholder: "optional note…", id: `note-${c.id}`,
      value: notes.get(c.id) || "",
      oninput: (e: WebDynamic) => notes.set(c.id, e.target.value),
    });
    return h("span.review-note", {}, h("label", { for: `note-${c.id}`, class: "visually-hidden" }, "Review note"), input);
  }

  function diffTable(detail: WebDynamic) {
    if (!detail.diff_ops) {
      return h("div.dim", {}, "The diff can't be shown — this run's bundle is missing or pruned. The journey can still be accepted on its recorded evidence.");
    }
    // Land on the Diff tab, not step-1 stills — reviewers clicking "full diff"
    // want the divergence, and the round trip must not cost them their place.
    const viewerLink = detail.run_group_id
      ? h("div.review-viewer-link", {}, link(`/p/${projectKey}/runs/${detail.run_group_id}/${detail.run_id}?view=diff`, "open full diff in viewer →"))
      : null;
    return h("div", {},
      healPanel(detail.heal),
      h("div.label", { style: "margin:2px 0 6px" }, "What changed"),
      h("div.diff-ops", {}, ...detail.diff_ops.map((o: WebDynamic) => h("div.diff-op", {},
        h(`div.side.a${o.op === "del" ? ".del" : ""}`, {}, o.a ? opLine(o.a) : h("span.faint", {}, "—")),
        h("div.arrow.faint", {}, "→"),
        h(`div.side.b${o.op === "add" ? ".add" : ""}`, {}, o.b ? opLine(o.b) : h("span.faint", {}, "—")),
      ))),
      viewerLink,
    );
  }

  // The reviewer's actual question — "why is this change safe?" — answered
  // from the run's own evidence: what broke, and the agent's stated reasoning
  // for the new path. Orient + review personas both had to reconstruct this.
  function healPanel(heal: WebDynamic) {
    if (!heal) return null;
    // the error usually just restates the locator the line already shows —
    // only surface it when it adds information
    const extraErr = heal.error && !(heal.old?.locator && heal.error.includes(heal.old.locator));
    return h("div.review-heal", {},
      h("div.label", { style: "margin:2px 0 6px" }, "Why it healed"),
      h("div.heal-line", {},
        h("span.del", {}, heal.old ? opLine(heal.old) : `step ${heal.failed_step ?? "?"}`),
        h("span.faint", {}, " no longer matched",
          extraErr ? ` — ${clamp(heal.error, 120)}` : ""),
      ),
      heal.thought ? h("blockquote.heal-thought", {}, "“", clamp(heal.thought, 300), "”") : null,
      heal.new ? h("div.heal-line", {}, h("span.faint", {}, "the agent continued with "), h("span.add", {}, opLine(heal.new))) : null,
    );
  }

  function opLine(s: WebDynamic) {
    const what: WebDynamic = [s.type, s.text ? `"${clamp(s.text, 40)}"` : null, s.locator || s.url].filter(Boolean).join(" ");
    return h("span", {}, s.step != null ? h("span.faint.mono", {}, `${s.step}  `) : null, what || "—");
  }

  async function fetchDetail(c: WebDynamic) {
    try {
      const detail = await api.get(`/candidates/${c.id}`);
      ctl.detail.set(c.id, detail);
    } catch (err: WebDynamic) {
      ctl.detail.set(c.id, { diff_ops: null, error: err });
    }
    if (current() && ctl.open.has(c.id)) paint();
  }

  function toggleExpand(c: WebDynamic) {
    if (ctl.open.has(c.id)) ctl.open.delete(c.id);
    else ctl.open.add(c.id);
    const params = new URLSearchParams(location.search);
    ctl.open.size ? params.set("open", [...ctl.open].join(",")) : params.delete("open");
    const qs = params.toString();
    history.replaceState({}, "", qs ? `?${qs}` : location.pathname);
    paint();
  }

  async function resolve(c: WebDynamic, action: WebDynamic) {
    if (!hasRole(project.id, "reviewer")) {
      return toast("Reviewer role required", "accepting or rejecting a changed story needs the reviewer role", "err");
    }
    if (action === "accept") {
      const ok = await confirmModal({
        title: "Accept this story's new path?",
        body: `The path this run took becomes the saved path for "${c.case_id}" — future runs check against it instead.`,
        confirmLabel: "Accept",
      });
      if (!ok) return;
    }
    try {
      await api.post(`/candidates/${c.id}/${action}`, { note: notes.get(c.id) || undefined });
      toast(action === "accept" ? "New path accepted" : "New path rejected", c.case_id, "ok");
      notes.delete(c.id);
      ctl.open.delete(c.id);
      refreshReviewBadge();
      await load();
    } catch (err: WebDynamic) {
      if (err.status === 409) {
        // A concurrent reviewer resolved it first — a supersede note, not an
        // error toast (UX review-queue rule).
        ctl.conflict.set(c.id, err.details || {});
        await load();
      } else toastError(err);
    }
  }
}

// Notes survive repaints (the whole list re-renders on feed events).
const notes: WebDynamic = new Map();
