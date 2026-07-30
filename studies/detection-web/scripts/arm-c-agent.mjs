// Arm C (control): a frontier coding agent driving a real browser.
// gpt-5.5 through the codex gateway + the public-Playwright browser layer.
// One round = one fresh context. Deliverable: structured bug report (JSON +
// markdown). Transcript: JSONL with per-call token usage.
//
// Usage:
//   node arm-c-agent.mjs --stories <file> --brief <file> --url <base> \
//     --out <dir> --round <n> --max-messages 200 --deadline-min 90

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chat, controlModel } from "./lib/gateway.mjs";
import { openBrowser, snapshot, actions } from "./lib/browser.mjs";

const { values: args } = parseArgs({
  options: {
    stories: { type: "string" },
    brief: { type: "string" },
    url: { type: "string" },
    out: { type: "string" },
    round: { type: "string", default: "1" },
    "max-messages": { type: "string", default: "200" },
    "deadline-min": { type: "string", default: "120" },
  },
});
for (const k of ["stories", "brief", "url", "out"]) {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

const outDir = args.out;
fs.mkdirSync(outDir, { recursive: true });
const transcriptPath = path.join(outDir, "transcript.jsonl");
const log = (entry) => fs.appendFileSync(transcriptPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");

const MAX_MESSAGES = Number(args["max-messages"]);
const DEADLINE_MS = Number(args["deadline-min"]) * 60_000;
const KEEP_FULL_RESULTS = 6; // older tool results are elided to bound context

const TOOLS = [
  { name: "goto", description: "Navigate the browser to a URL.", params: { url: "Absolute URL to open" } },
  { name: "click", description: "Click an interactive element by its ref from the latest page snapshot.", params: { ref: "Element ref, e.g. r12" } },
  { name: "type", description: "Replace the text in an input/textarea identified by ref.", params: { ref: "Element ref", text: "Text to enter" } },
  { name: "select", description: "Choose an option in a select element by visible label.", params: { ref: "Element ref", value: "Option label" } },
  { name: "press", description: "Press a keyboard key (e.g. Enter, Escape, Tab).", params: { key: "Key name" } },
  { name: "back", description: "Go back one page in browser history.", params: {} },
  { name: "wait", description: "Wait up to 5000 ms for the page to settle.", params: { ms: "Milliseconds to wait" } },
  {
    name: "report_bug",
    description: "Record one bug you have verified in the running application. Report each distinct bug exactly once.",
    params: {
      title: "One-line summary of the bug",
      steps: "Numbered reproduction steps",
      expected: "What should happen",
      observed: "What actually happens",
      severity: "low, medium, or high",
    },
  },
  { name: "finish", description: "End the session when all stories are worked and all found bugs are reported.", params: { summary: "Short closing summary of coverage and confidence" } },
].map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(Object.entries(t.params).map(([k, d]) => [k, { type: "string", description: d }])),
      required: Object.keys(t.params),
    },
  },
}));

function parseToolArgs(raw) {
  if (raw == null) return {};
  let v = raw;
  for (let i = 0; i < 2 && typeof v === "string"; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      return {};
    }
  }
  return typeof v === "object" && v ? v : {};
}

const stories = fs.readFileSync(args.stories, "utf8");
const brief = fs
  .readFileSync(args.brief, "utf8")
  .replaceAll("{{STORIES}}", stories)
  .replaceAll("{{BASE_URL}}", args.url)
  .replaceAll("{{ROUND}}", args.round);

const bugs = [];
const startedAt = Date.now();
const totals = { model_messages: 0, tool_calls: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 };

const { browser, page, consoleLog } = await openBrowser();
let consoleIndex = 0;

async function runTool(name, a) {
  totals.tool_calls++;
  switch (name) {
    case "goto":
      return actions.goto(page, a.url);
    case "click":
      return actions.click(page, a.ref);
    case "type":
      return actions.type(page, a.ref, a.text ?? "");
    case "select":
      return actions.select(page, a.ref, a.value ?? "");
    case "press":
      return actions.press(page, a.key ?? "Enter");
    case "back":
      return actions.back(page);
    case "wait":
      return actions.wait(page, a.ms);
    case "report_bug": {
      bugs.push({
        n: bugs.length + 1,
        title: a.title ?? "(untitled)",
        steps: a.steps ?? "",
        expected: a.expected ?? "",
        observed: a.observed ?? "",
        severity: a.severity ?? "medium",
        reported_at: new Date().toISOString(),
        url_at_report: page.url(),
      });
      return `recorded bug #${bugs.length}: ${a.title}`;
    }
    default:
      return `unknown tool ${name}`;
  }
}

const messages = [{ role: "system", content: brief }, { role: "user", content: `Begin. The application is at ${args.url}. Work the stories and report every bug you find.` }];

/** Bound context: elide all but the newest tool results. */
function pruneHistory() {
  const toolIdxs = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const elide = toolIdxs.slice(0, Math.max(0, toolIdxs.length - KEEP_FULL_RESULTS));
  for (const i of elide) {
    const m = messages[i];
    if (!m.__elided && typeof m.content === "string" && m.content.length > 400) {
      m.content = m.content.slice(0, 300) + "\n…[earlier page snapshot elided]";
      m.__elided = true;
    }
  }
}

let endReason = "finished";
let finalSummary = "";

while (true) {
  if (totals.model_messages >= MAX_MESSAGES) {
    endReason = "message_cap";
    break;
  }
  if (Date.now() - startedAt > DEADLINE_MS) {
    endReason = "deadline";
    break;
  }
  pruneHistory();
  const wire = messages.map(({ __elided, ...m }) => m);
  const res = await chat(wire, { tools: TOOLS, toolChoice: "auto" });
  totals.model_messages++;
  if (res.usage) {
    totals.prompt_tokens += res.usage.prompt_tokens ?? 0;
    totals.completion_tokens += res.usage.completion_tokens ?? 0;
    totals.cached_tokens += res.usage.prompt_tokens_details?.cached_tokens ?? 0;
  }
  log({ dir: "assistant", content: res.message.content, tool_calls: res.message.tool_calls?.map((c) => ({ name: c.function?.name, args: c.function?.arguments })), usage: res.usage, finish: res.finishReason });
  messages.push({ role: "assistant", content: res.message.content ?? null, ...(res.message.tool_calls ? { tool_calls: res.message.tool_calls } : {}) });

  const calls = res.message.tool_calls ?? [];
  if (!calls.length) {
    // Plain text with no tool call: nudge once toward tools/finish.
    messages.push({ role: "user", content: "Use the provided tools to continue, report_bug for each verified bug, and finish when done." });
    continue;
  }
  let finished = false;
  for (const call of calls) {
    const name = call.function?.name;
    const a = parseToolArgs(call.function?.arguments);
    if (name === "finish") {
      finished = true;
      finalSummary = a.summary ?? "";
      messages.push({ role: "tool", tool_call_id: call.id, content: "session ended" });
      log({ dir: "tool", name, result: "session ended" });
      continue;
    }
    let result;
    try {
      result = await runTool(name, a);
    } catch (err) {
      result = `ERROR: ${String(err && err.message ? err.message : err).slice(0, 300)}`;
    }
    const snap = await snapshot(page, consoleLog, consoleIndex).catch((e) => ({ text: `(snapshot failed: ${e.message})`, consoleIndex }));
    consoleIndex = snap.consoleIndex;
    const content = `${result}\n\n${snap.text}`;
    messages.push({ role: "tool", tool_call_id: call.id, content });
    log({ dir: "tool", name, args: a, result, snapshot_bytes: snap.text.length });
  }
  if (finished) break;
}

await browser.close();

const wallMs = Date.now() - startedAt;
const report = {
  arm: "C",
  model: controlModel,
  round: Number(args.round),
  base_url: args.url,
  end_reason: endReason,
  summary: finalSummary,
  bugs,
  metrics: { ...totals, wall_ms: wallMs },
};
fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
const md = [
  `# Arm C bug report — round ${args.round}`,
  "",
  `End reason: ${endReason}. Bugs reported: ${bugs.length}.`,
  finalSummary ? `\nAgent summary: ${finalSummary}` : "",
  ...bugs.map((b) => `\n## Bug ${b.n}: ${b.title}\n\n- Severity: ${b.severity}\n- Steps:\n${b.steps}\n- Expected: ${b.expected}\n- Observed: ${b.observed}\n- URL at report: ${b.url_at_report}`),
].join("\n");
fs.writeFileSync(path.join(outDir, "report.md"), md);
console.log(JSON.stringify({ bugs: bugs.length, ...totals, wall_ms: wallMs, end_reason: endReason }));
