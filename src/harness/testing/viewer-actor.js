// Rule-based actor for the viewer self-test suite (tests/viewer), the same
// role the todo rules in mock-llm.js play for the example todo suite: enough
// deterministic behavior to record and replay those journeys offline. Keyed
// on the suite's story phrasings and the viewer's accessible names — if the
// viewer's a11y surface drifts, this breaks the offline self-test by design.

const step = (thought, action, expectation) => ({ thought, action, expectation });
const giveUp = (thought, reason) => step(thought, { type: "give_up", reason }, "the run ends");
const done = (summary) => step("That puts the answer on screen.", { type: "done", summary }, "the run ends with the task complete");

// Ordered tokens: elements keep their trailing text lines as `after` context
// (the picker names every run row's link identically — "↳ add-todo" — so the
// status/run-id text that FOLLOWS the link is what disambiguates rows).
function parse(snapshot) {
  const els = [];
  let url = "";
  for (const line of snapshot.split("\n")) {
    const page = line.match(/^Page: .* — (\S+)$/);
    if (page) url = page[1];
    const el = line.match(/^\[(e\d+)\]\s+(\S+)\s+"(.*)"/);
    if (el) els.push({ ref: el[1], role: el[2], name: el[3], after: [] });
    const text = line.match(/^text: "(.*)"$/);
    if (text && els.length) els[els.length - 1].after.push(text[1]);
  }
  return { url, els, all: snapshot };
}

const SCENARIOS = [
  { key: "stills-last", re: /final step|how the run concluded/i },
  { key: "siblings", re: /previous run of the same journey/i },
  { key: "heal-review", re: /awaiting review|command for accepting/i },
  { key: "divergence", re: /deviates from the old baseline|first differing step/i },
  { key: "red-run", re: /check is red|failing success criteri/i },
  { key: "history", re: /has trended across|find that history panel/i },
  { key: "open-latest", re: /most recent run of the journey/i },
];

/** @returns {object|null} step args, or null when the story is not a viewer-suite story */
export function viewerStep(story, snapshotText) {
  const scenario = SCENARIOS.find((s) => s.re.test(story))?.key;
  if (!scenario) return null;
  const { url, els, all } = parse(snapshotText);
  const onPicker = !url.includes("?run=");
  const link = (name) => els.find((e) => e.role === "link" && e.name === name);
  const button = (re) => els.find((e) => e.role === "button" && re.test(e.name));
  const click = (el, why, expect) => step(why, { type: "click", ref: el.ref }, expect);

  // Picker navigation: which top-level row this scenario starts from.
  if (onPicker) {
    const wantsHealed = scenario === "heal-review" || scenario === "divergence";
    const family = scenario === "red-run" || scenario === "history" ? "todos/add-todo" : "add-todo";
    if (!wantsHealed) {
      const row = link(family);
      if (!row) return giveUp(`I can't find a "${family}" row in the run list.`, `no link named "${family}" on the picker`);
      return click(row, `Opening the newest "${family}" run from the list.`, "the run's recording opens");
    }
    // Healed run: it's an older sibling, so expand the add-todo group first,
    // then open the row whose status text says "changed".
    const changedRow = els.find((e) => e.role === "link" && e.name === "↳ add-todo" && e.after.includes("changed"));
    if (changedRow) return click(changedRow, 'Opening the run marked "changed" — that is the healed one.', "the healed run opens");
    const anchor = els.findIndex((e) => e.role === "link" && e.name === "add-todo");
    const expand = els.slice(anchor + 1).find((e) => e.role === "button" && /show this story's older runs/.test(e.name));
    if (anchor === -1 || !expand) {
      return giveUp("I can't find the add-todo story's older runs.", "no expandable add-todo group on the picker");
    }
    return click(expand, "Expanding add-todo's history to find the healed run.", "older runs of add-todo appear");
  }

  // On a run detail page.
  switch (scenario) {
    case "open-latest":
      return done("I opened the most recent add-todo run; its recording is on screen.");
    case "stills-last": {
      const caption = all.match(/step (\d+) \/ (\d+)/);
      if (caption && caption[1] === caption[2]) return done("The film strip is on the run's final step.");
      const cells = els.filter((e) => e.role === "button" && /^\d{2} /.test(e.name));
      if (!cells.length) return giveUp("I see no film strip steps to walk.", "no step cells on the run page");
      return click(cells[cells.length - 1], "Jumping to the last step of the film strip.", "the final step's caption shows");
    }
    case "siblings": {
      if (url.includes("1b72")) return done("I'm on the previous add-todo run, reached via the run pager.");
      const older = button(/^older run: /) ?? els.find((e) => e.role === "link" && /^older run: /.test(e.name));
      if (!older) return giveUp("I see no way to reach the previous run from here.", "no older-run pager on the run page");
      return click(older, "Stepping back to the previous run with the pager.", "the previous run loads");
    }
    case "heal-review": {
      if (all.includes("playtest accept")) return done("The accept command for the healed add-todo recording is on screen.");
      const diff = button(/^Diff$/);
      if (!diff) return giveUp("This run shows no comparison view.", "no Diff tab on the healed run");
      return click(diff, "Opening the Diff view to see the review guidance.", "the baseline comparison appears");
    }
    case "divergence": {
      if (all.includes("first divergence")) return done("The first divergence between baseline and this run is on screen.");
      const diff = button(/^Diff$/);
      if (!diff) return giveUp("This run shows no comparison view.", "no Diff tab on the healed run");
      return click(diff, "Opening the Diff view to compare against the baseline.", "the action track comparison appears");
    }
    case "red-run": {
      if (/gate fail|no element matched/.test(all)) return done("The failing criteria are on screen: the todo item never rendered.");
      const runTab = button(/^Run$/);
      if (!runTab) return giveUp("I can't find the run's verdict details.", "no Run tab in the inspector");
      return click(runTab, "Checking the run-level verdict for the failing checks.", "the success criteria appear");
    }
    case "history": {
      if (all.includes("vs prev")) return done("The cross-run history for todos/add-todo is on screen.");
      const runTab = button(/^Run$/);
      if (!runTab) return giveUp("I can't find a run-level view with history.", "no Run tab in the inspector");
      return click(runTab, "Opening the run-level view to see the trend.", "the history sparkline appears");
    }
  }
  return null;
}
