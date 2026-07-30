// Arm C (control): a frontier coding agent testing an HTTP JSON API.
// gpt-5.5 through the codex gateway; tools are a single http_request plus
// report_bug/finish. One round = one fresh context. Deliverable: structured
// bug report (JSON + markdown). Transcript: JSONL with per-call token usage.
//
// Usage:
//   node arm-c-agent-api.mjs --stories <file> --brief <file> --openapi <file> \
//     --url <base> --out <dir> --round <n> --max-messages 200 \
//     --max-requests 360 --deadline-min 45

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chat, controlModel } from "./lib/gateway.mjs";

const { values: args } = parseArgs({
  options: {
    stories: { type: "string" },
    brief: { type: "string" },
    openapi: { type: "string" },
    url: { type: "string" },
    out: { type: "string" },
    round: { type: "string", default: "1" },
    "max-messages": { type: "string", default: "200" },
    "max-requests": { type: "string", default: "360" },
    "deadline-min": { type: "string", default: "45" },
  },
});
for (const k of ["stories", "brief", "openapi", "url", "out"]) {
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
const MAX_REQUESTS = Number(args["max-requests"]);
const DEADLINE_MS = Number(args["deadline-min"]) * 60_000;
const KEEP_FULL_RESULTS = 10; // older tool results are elided to bound context
const BODY_LIMIT = 3500;

const TOOLS = [
  {
    name: "http_request",
    description:
      "Send one HTTP request to the API under test. path is relative to the base URL and may carry a query string. body is a raw request body string (JSON) sent with content-type application/json, or an empty string for no body.",
    params: {
      method: "HTTP method: GET, POST, PATCH, PUT, or DELETE",
      path: "Request path starting with /, e.g. /api/loans?status=out",
      body: "Raw JSON request body, or empty string for none",
    },
  },
  {
    name: "report_bug",
    description: "Record one bug you have verified in the running API. Report each distinct bug exactly once.",
    params: {
      title: "One-line summary of the bug",
      steps: "Numbered reproduction steps (the exact requests to send)",
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
const openapi = fs.readFileSync(args.openapi, "utf8");
const brief = fs
  .readFileSync(args.brief, "utf8")
  .replaceAll("{{STORIES}}", stories)
  .replaceAll("{{OPENAPI}}", openapi)
  .replaceAll("{{BASE_URL}}", args.url)
  .replaceAll("{{ROUND}}", args.round);

const bugs = [];
const startedAt = Date.now();
const totals = { model_messages: 0, tool_calls: 0, requests: 0, prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 };

async function runTool(name, a) {
  totals.tool_calls++;
  switch (name) {
    case "http_request": {
      if (totals.requests >= MAX_REQUESTS) {
        return `REQUEST BUDGET EXHAUSTED (${MAX_REQUESTS} requests used). Report any remaining verified bugs and call finish.`;
      }
      const method = String(a.method ?? "GET").toUpperCase();
      const p = String(a.path ?? "/");
      if (!p.startsWith("/")) return "ERROR: path must start with /";
      const body = typeof a.body === "string" && a.body.length ? a.body : undefined;
      totals.requests++;
      try {
        const res = await fetch(`${args.url}${p}`, {
          method,
          headers: body ? { "content-type": "application/json" } : undefined,
          body,
          signal: AbortSignal.timeout(15_000),
        });
        const text = await res.text();
        const clipped = text.length > BODY_LIMIT ? text.slice(0, BODY_LIMIT) + `\n…[truncated, ${text.length} bytes total]` : text;
        return `HTTP ${res.status}\ncontent-type: ${res.headers.get("content-type") ?? "(none)"}\n\n${clipped}`;
      } catch (err) {
        return `ERROR: ${String(err && err.message ? err.message : err).slice(0, 300)}`;
      }
    }
    case "report_bug": {
      bugs.push({
        n: bugs.length + 1,
        title: a.title ?? "(untitled)",
        steps: a.steps ?? "",
        expected: a.expected ?? "",
        observed: a.observed ?? "",
        severity: a.severity ?? "medium",
        reported_at: new Date().toISOString(),
      });
      return `recorded bug #${bugs.length}: ${a.title}`;
    }
    default:
      return `unknown tool ${name}`;
  }
}

const messages = [
  { role: "system", content: brief },
  { role: "user", content: `Begin. The API under test is at ${args.url}. Work the stories and report every bug you find.` },
];

/** Bound context: elide all but the newest tool results. */
function pruneHistory() {
  const toolIdxs = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  const elide = toolIdxs.slice(0, Math.max(0, toolIdxs.length - KEEP_FULL_RESULTS));
  for (const i of elide) {
    const m = messages[i];
    if (!m.__elided && typeof m.content === "string" && m.content.length > 500) {
      m.content = m.content.slice(0, 400) + "\n…[earlier response body elided]";
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
    messages.push({ role: "tool", tool_call_id: call.id, content: result });
    log({ dir: "tool", name, args: a, result_bytes: result.length, result_head: result.slice(0, 200) });
  }
  if (finished) break;
}

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
  ...bugs.map((b) => `\n## Bug ${b.n}: ${b.title}\n\n- Severity: ${b.severity}\n- Steps:\n${b.steps}\n- Expected: ${b.expected}\n- Observed: ${b.observed}`),
].join("\n");
fs.writeFileSync(path.join(outDir, "report.md"), md);
console.log(JSON.stringify({ bugs: bugs.length, ...totals, wall_ms: wallMs, end_reason: endReason }));
