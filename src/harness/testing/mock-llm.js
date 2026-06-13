#!/usr/bin/env node
// OpenAI-compatible rule-based mock LLM server (CONTRACTS.md §14).
// This file is also the contract test: it parses exactly the message layouts
// actor.js and grader.js produce — if those drift, the offline e2e breaks.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { viewerStep } from "./viewer-actor.js";

// ---------- parsing what the harness sends ----------

// Message content may be a plain string or an OpenAI content-part array
// (vision runs add image_url parts). Every reader here greps text, so
// flatten: join the text parts, ignore images.
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n");
}

// Snapshot lines per the a11y-text-v1 format (CONTRACTS.md §4):
//   [e4] checkbox "buy milk" (unchecked)
//   text: "1 item left"
function parseSnapshot(text) {
  const els = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\[(e\d+)\]\s+(\S+)\s+"(.*?)"(.*)$/);
    if (!m) continue;
    const rest = m[4];
    els.push({
      ref: m[1],
      role: m[2],
      name: m[3],
      value: rest.match(/value="(.*)"/)?.[1] ?? null,
      checked: rest.includes("(checked)"),
    });
  }
  return els;
}

// Prior-step log lines per actor.js: `step 1: type "buy milk" into e2 -> ok`
// plus a `  thought: ...` line on every agent step (the log is unfolded).
function parseHistory(logText) {
  const typed = new Set();
  const thoughts = [];
  for (const line of logText.split("\n")) {
    const m = line.match(/\btype ("(?:[^"\\]|\\.)*") into e\d+/);
    if (m && line.includes("-> ok")) typed.add(JSON.parse(m[1]));
    const t = line.match(/^\s+thought: (.*)$/);
    if (t) thoughts.push(t[1]);
  }
  return { typed, thoughts };
}

// Story directives, in story order. Titles arrive in double quotes.
function parseDirectives(story) {
  const found = [];
  const scan = (re, op) => {
    for (let m; (m = re.exec(story)); ) found.push({ op, title: m[1] ?? null, at: m.index });
  };
  scan(/\badd\b[^"]*?"([^"]+)"/gi, "add");
  scan(/\b(?:mark|complete|check off|tick)\b[^"]*?"([^"]+)"/gi, "complete");
  scan(/\b(?:delete|remove)\b[^"]*?"([^"]+)"/gi, "delete");
  scan(/\bclear\b[^"]*?\bcompleted\b/gi, "clear");
  scan(/\bfilter\b[^"]*?"(All|Active|Completed)"/gi, "filter");
  return found.sort((a, b) => a.at - b.at);
}

// ---------- the rule-based actor ----------

const step = (thought, action, expectation) => ({ thought, action, expectation });
const giveUp = (thought, reason) => step(thought, { type: "give_up", reason }, "the run ends");

function decide(dirs, els, hist) {
  if (!dirs.length) {
    return giveUp("The story gives me nothing concrete to do.",
      "no recognizable directive (add/complete/delete/clear/filter) in the story");
  }
  const textbox = els.find((e) => e.role === "textbox");
  const itemFor = (t) => els.find((e) => e.role === "checkbox" && e.name === t);
  // Added earlier and since removed: it was typed (history), is no longer in the
  // list, and is not just sitting un-submitted in the textbox.
  const gone = (t) => hist.typed.has(t) && !itemFor(t) && textbox?.value !== t;
  const removalAfter = (i, t) =>
    dirs.some((d, j) => j > i && ((d.op === "delete" && d.title === t) || d.op === "clear"));

  for (let i = 0; i < dirs.length; i++) {
    const { op, title: t } = dirs[i];
    if (op === "add") {
      if (itemFor(t) || (removalAfter(i, t) && gone(t))) continue;
      if (!textbox) return giveUp(`I need to add "${t}" but I see no text input.`, "no text input to add a todo");
      if (textbox.value !== t) {
        return step(`I'll add "${t}" — typing it into the input.`,
          { type: "type", ref: textbox.ref, text: t, submit: false },
          `the input shows "${t}"`);
      }
      const add =
        els.find((e) => e.role === "button" && /\b(add|save|create|submit)\b/i.test(e.name)) ??
        els.find((e) => e.role === "button" && !/\b(delete|remove|clear)\b/i.test(e.name));
      if (!add) return giveUp(`I typed "${t}" but I can't find a button to submit it.`, "no submit button on the page");
      return step(`The input holds "${t}" — clicking "${add.name}".`,
        { type: "click", ref: add.ref },
        `a todo called "${t}" appears in the list`);
    }
    if (op === "complete") {
      const item = itemFor(t);
      if (item?.checked || (!item && removalAfter(i, t) && gone(t))) continue;
      if (!item) return giveUp(`I can't find "${t}" to mark as done.`, `no todo called "${t}" in the list`);
      return step(`Marking "${t}" as done.`, { type: "click", ref: item.ref },
        `the checkbox "${t}" shows as checked`);
    }
    if (op === "delete") {
      if (!itemFor(t)) continue;
      const btn = els.find((e) => e.role === "button" && e.name.toLowerCase() === `delete ${t}`.toLowerCase());
      if (!btn) return giveUp(`I see no way to delete "${t}".`, `no delete button for "${t}"`);
      return step(`Deleting "${t}".`, { type: "click", ref: btn.ref }, `"${t}" disappears from the list`);
    }
    if (op === "clear") {
      const completed = dirs.filter((d) => d.op === "complete").map((d) => d.title);
      if (!els.some((e) => e.role === "checkbox" && e.checked) && completed.every((c) => !itemFor(c))) continue;
      const btn = els.find((e) => e.role === "button" && /clear/i.test(e.name));
      if (!btn) return giveUp("I can't find a way to clear completed todos.", "no Clear completed button");
      return step(`Clearing the completed todos with "${btn.name}".`, { type: "click", ref: btn.ref },
        "the completed todos disappear from the list");
    }
    if (op === "filter") {
      const crumb = `Filtering the list: clicking "${t}"`;
      if (hist.thoughts.some((th) => th.includes(crumb))) continue;
      const el = els.find((e) => (e.role === "link" || e.role === "button") && e.name === t);
      if (!el) return giveUp(`I can't find a "${t}" filter.`, `no filter named "${t}"`);
      return step(`${crumb}.`, { type: "click", ref: el.ref }, `the list shows only ${t.toLowerCase()} todos`);
    }
  }
  const bits = dirs.map((d) =>
    d.op === "add" ? `added "${d.title}"`
    : d.op === "complete" ? `marked "${d.title}" as done`
    : d.op === "delete" ? `deleted "${d.title}"`
    : d.op === "clear" ? "cleared the completed todos"
    : `filtered to ${d.title}`);
  return step("Everything the task asked for is now visible on the page.",
    { type: "done", summary: `I ${bits.join(", ")}. The page shows the result.` },
    "the run ends with the task complete");
}

function actorStep(messages) {
  const system = contentText(messages.find((m) => m.role === "system")?.content);
  const story = system.includes("## Your task") ? system.split("## Your task").pop() : system;
  const users = messages.filter((m) => m.role === "user").map((m) => contentText(m.content));
  const snapMsg = users.find((c) => /^Current page snapshot \(step \d+\):/.test(c));
  if (!snapMsg) throw new Error('no user message starting with "Current page snapshot (step N):" — actor message layout drifted');
  const stepNum = Number(snapMsg.match(/\(step (\d+)\)/)[1]);
  const snapshot = snapMsg.slice(snapMsg.indexOf("\n") + 1);
  const args = stepNum > 20
    ? giveUp("This is taking far too many steps.", "exceeded 20 steps without finishing the task")
    : viewerStep(story, snapshot) ?? // viewer self-test stories (tests/viewer), else the todo rules
      decide(
        parseDirectives(story),
        parseSnapshot(snapshot),
        parseHistory(users.find((c) => c.startsWith("Steps so far:")) ?? ""),
      );
  // A vision-on turn carries an image part; emit a visual observation so
  // offline envelopes exercise the field end to end.
  if (messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p?.type === "image_url"))) {
    args.visual = "Mock visual observation: the page heading dominates; the primary action sits directly below the input.";
  }
  return args;
}

// ---------- the rule-based grader & assertion checker ----------

const FIXED_GRADE = {
  score: 90,
  completion: "full",
  efficiency: { assessment: "Direct path with no wasted steps.", wasted_steps: 0 },
  findings: [{ severity: "info", note: "Deterministic grade from the mock LLM fixture." }],
  summary: "The task completed smoothly. This is a deterministic mock grade used for self-testing the harness.",
};

// Discovery report questions arrive as a numbered list under a
// "## Report questions" heading in the USER message (grader.js gradeRun — the
// system rubric also quotes the heading, so only user content is parsed);
// answer each so an e2e discovery run lands report entries in grade.json.
// Without the section the journey grade shape is unchanged.
function gradeArgs(messages) {
  const content = messages
    .filter((m) => m.role === "user")
    .map((m) => contentText(m.content))
    .join("\n");
  const section = content.split("## Report questions")[1];
  if (!section) return FIXED_GRADE;
  const body = section.split(/\n##\s/)[0];
  const questions = [...body.matchAll(/^\s*\d+[.)]\s+(.+)$/gm)].map((m) => m[1].trim());
  return {
    ...FIXED_GRADE,
    report: questions.map((q) => ({
      question: q,
      answer: `Deterministic mock answer: ${q}`,
      evidence_steps: [1],
    })),
  };
}

const STOPWORDS = new Set(
  "the a an and or is are was were been it its this that of in on to with shows show showing list page counter todo todos item items called".split(" "),
);

// Naive containment: quoted words from the claim (else significant words)
// checked against the snapshot text in the prompt (grader.js checkAssertion layout).
function verdict(messages) {
  const content = messages.filter((m) => m.role === "user").map((m) => contentText(m.content)).join("\n");
  const claim = (content.match(/Claim:\s*([\s\S]*?)\n\s*\nFinal URL:/) ?? [, ""])[1].trim();
  const snapshot = content.split(/Final page snapshot:\s*\n/)[1] ?? "";
  const quoted = [...claim.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const needles = quoted.length
    ? quoted
    : claim.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  if (!needles.length) return { pass: false, detail: "no checkable terms in the claim" };
  const hay = snapshot.toLowerCase();
  const missing = needles.filter((n) => !hay.includes(n.toLowerCase()));
  return missing.length
    ? { pass: false, detail: `not found on the final page: ${missing.map((n) => `"${n}"`).join(", ")}` }
    : { pass: true, detail: `found on the final page: ${needles.map((n) => `"${n}"`).join(", ")}` };
}

// ---------- the server ----------

function usageFor(messages, argsJson) {
  const promptChars = messages.reduce((n, m) => n + contentText(m.content).length, 0);
  const promptTokens = Math.max(1, Math.round(promptChars / 4));
  // Pretend the stable prefix is cached once a prior step exists in the log.
  const log = messages.map((m) => (m.role === "user" ? contentText(m.content) : "")).find((c) => c.startsWith("Steps so far:")) ?? "";
  const sysChars = contentText(messages.find((m) => m.role === "system")?.content).length;
  const cached = /\bstep \d+:/.test(log) ? Math.min(Math.round(sysChars / 4), promptTokens) : 0;
  const completionTokens = Math.max(1, Math.round(argsJson.length / 4));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cached },
  };
}

let counter = 0;

function completion(body) {
  const messages = body.messages ?? [];
  const forced = body.tool_choice?.function?.name ?? null;
  let args = null;
  if (forced === "step") args = actorStep(messages);
  else if (forced === "grade") args = gradeArgs(messages);
  else if (forced === "verdict") args = verdict(messages);

  const message = args
    ? {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call_${++counter}`,
          type: "function",
          function: { name: forced, arguments: JSON.stringify(args) },
        }],
      }
    : { role: "assistant", content: "mock-llm: no forced tool; nothing to do." };

  return {
    id: `mock-${++counter}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? "mock",
    choices: [{ index: 0, message, finish_reason: args ? "tool_calls" : "stop" }],
    usage: usageFor(messages, args ? JSON.stringify(args) : ""),
  };
}

/**
 * Boot one mock-LLM instance. `requestCount()` reports how many POST
 * chat/completions requests THIS instance has served; `requestCount(tool)`
 * narrows to one forced tool ("step" / "grade" / "verdict") — the self-test
 * uses it to prove act-mode runs make zero actor and zero grader calls.
 * `requests()` returns the parsed request bodies in arrival order as
 * { tool, body } — the self-test inspects them to prove vision runs send
 * exactly one image per actor step (and that nothing else ever does).
 * @param {{ port?: number }} [opts] port 0 = ephemeral
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void>,
 *                     requestCount: (tool?: string) => number,
 *                     requests: () => { tool: string, body: object }[] }>}
 */
export async function start({ port = 0 } = {}) {
  let served = 0;
  const servedByTool = {};
  const captured = [];
  const server = http.createServer((req, res) => {
    const send = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== "POST" || !/^\/(?:v1\/)?chat\/completions$/.test(req.url)) {
      return send(404, { error: { message: `mock-llm: no route ${req.method} ${req.url}` } });
    }
    served++;
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(raw);
        const tool = body.tool_choice?.function?.name ?? "(none)";
        servedByTool[tool] = (servedByTool[tool] ?? 0) + 1;
        captured.push({ tool, body });
        send(200, completion(body));
      } catch (err) {
        send(400, { error: { message: `mock-llm: ${err.message}` } });
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, resolve);
  });
  const boundPort = server.address().port;
  return {
    url: `http://localhost:${boundPort}`,
    port: boundPort,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        server.closeAllConnections();
      }),
    requestCount: (tool) => (tool == null ? served : (servedByTool[tool] ?? 0)),
    requests: () => [...captured],
  };
}

// CLI: `npm run mock-llm` / `node src/harness/testing/mock-llm.js [--port n]`.
// Importing this module never binds a port.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const portFlag = process.argv.indexOf("--port");
  const { port } = await start({ port: portFlag !== -1 ? Number(process.argv[portFlag + 1]) : 4175 });
  console.log(`mock-llm listening on http://localhost:${port}`);
}
