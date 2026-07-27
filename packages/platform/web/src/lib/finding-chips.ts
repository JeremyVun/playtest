// The story-row / suite-row findings chips, as data (docs/contracts/hosted.md,
// "Findings"). Kept DOM-free so the hermetic gate can assert the honest-pill
// rules without a browser (sibling of finding-buckets.ts):
//
//   * "open" counts ONLY confirmed work — `reopened` and `accepted`. A `new`
//     finding is machine output no person has vetted; it rides as a separate
//     quiet "to review" count, never inside a red pill.
//   * "look fixed" decorates the open count when the story's latest finished
//     verdict is a pass newer than the finding's last evidence — the same
//     derivation as the findings page's story health. It rides INSIDE the open
//     pill ("1 open · looks fixed"): the look-fixed findings ARE open findings,
//     and two pills would count the same work twice.
//   * "auto-resolved" appears only once the open and review counts are clear:
//     the receipt that the system closed the loop, not another alarm.
//
// Each chip also carries `ids` — the findings it counts — so a count of one
// can link straight to the finding instead of the filtered list.

/** Fold one story's findings + its latest run into the chip counts. */
export function storyFindingSummary(findings: WebDynamic = [], lastRun: WebDynamic = null) {
  const open = findings.filter((f: WebDynamic) => f.state === "reopened" || f.state === "accepted");
  const review = findings.filter((f: WebDynamic) => f.state === "new");
  const autoResolved = findings.filter((f: WebDynamic) => f.state === "resolved" && f.auto_resolved_at);
  const passAt = lastRun?.status === "pass" ? Date.parse(lastRun.started_at || "") : NaN;
  const lookFixed = Number.isFinite(passAt)
    ? open.filter((f: WebDynamic) => !f.last_seen || passAt >= Date.parse(f.last_seen)).length
    : 0;
  return {
    open: open.length,
    majors: open.filter((f: WebDynamic) => f.severity === "major").length,
    review: review.length,
    lookFixed,
    autoResolved: autoResolved.length,
    ids: {
      open: open.map((f: WebDynamic) => f.id),
      review: review.map((f: WebDynamic) => f.id),
      autoResolved: autoResolved.map((f: WebDynamic) => f.id),
    },
  };
}

/**
 * The chips those counts justify, in display order. Each descriptor is
 * `{kind, label, tone, ids}`; tones map onto the chip classes (`sev-major`,
 * `sev-minor`, `calm`, `muted`).
 */
export function findingChipDescriptors({ open = 0, majors = 0, review = 0, lookFixed = 0, autoResolved = 0, ids = {} }: WebDynamic = {}) {
  const chips: WebDynamic = [];
  if (open) {
    // The look-fixed count repeats the count only when it covers a strict
    // subset: "1 open · looks fixed", but "3 open · 1 looks fixed".
    const fixed = lookFixed
      ? ` · ${lookFixed === open ? "" : `${lookFixed} `}look${lookFixed === 1 ? "s" : ""} fixed`
      : "";
    chips.push({
      kind: "open",
      label: `${open} open${majors ? ` · ${majors} major` : ""}${fixed}`,
      tone: majors ? "sev-major" : "sev-minor",
      ids: ids.open || [],
    });
  }
  if (review) {
    chips.push({ kind: "review", label: `${review} to review`, tone: "muted", ids: ids.review || [] });
  }
  // The receipt only once the work is gone — beside an open count it would
  // read as noise, and beside a review count as a claim nobody has judged.
  if (!open && !review && autoResolved) {
    chips.push({
      kind: "auto-resolved",
      label: `${autoResolved} auto-resolved`,
      tone: "calm",
      ids: ids.autoResolved || [],
    });
  }
  return chips;
}
