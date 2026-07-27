// A scripted OpenAI-compatible gateway for offline record runs.
//
// The engine only reaches a model through POST /v1/chat/completions, so a
// loopback server that replays a fixed list of `step` tool calls turns a record
// run into a deterministic, hermetic test: real runner, real driver, real
// artifacts — no network, no credentials, no model nondeterminism. Steps are
// served in order; the list is exhausted with a `give_up` so a mis-scripted test
// ends instead of hanging.
import http from "node:http";

interface AuthoringTurn {
  script: string;
  notes?: string;
  revisions?: object[];
}

interface ModelMessage {
  content: unknown;
}

interface ModelCall {
  messages?: ModelMessage[];
}

interface AgentStep {
  thought: string;
  action: Record<string, unknown>;
  expectation: string;
}

/**
 * A scripted gateway for the authoring loop (docs/contracts/scripts.md).
 *
 * The loop reaches a model exactly once per turn, through the same
 * `POST /v1/chat/completions`, and expects prose with two fenced blocks rather
 * than a tool call — so a turn list of `{ script, notes, revisions }` makes the
 * whole loop hermetic: real handout, real runner, real fixture, real report,
 * with the only nondeterministic participant replaced by a list.
 *
 */
export async function startScriptedAuthoringModel(turns: Array<AuthoringTurn | string>) {
  const calls: Array<ModelCall | { unparseable: string }> = [];
  const prompts: string[] = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let parsed = null as unknown as ModelCall; // TODO(ts): preserve the legacy null initializer while JSON.parse supplies the call shape
      try {
        parsed = JSON.parse(raw);
        calls.push(parsed);
        prompts.push((parsed.messages ?? []).map((message: ModelMessage) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content))).join("\n\n"));
      } catch {
        calls.push({ unparseable: raw });
      }
      const turn = turns[i++];
      const content =
        turn === undefined
          ? "The turn list is exhausted; this reply deliberately contains no suite."
          : typeof turn === "string"
            ? turn
            : [
                "```json",
                JSON.stringify({ notes: turn.notes ?? "", revisions: turn.revisions ?? [] }, null, 2),
                "```",
                "",
                "```js",
                turn.script.trimEnd(),
                "```",
              ].join("\n");
      const body = JSON.stringify({
        choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve as () => void)); // TODO(ts): Node's listen callback omits the Promise resolver argument
  const { port } = server.address() as import("node:net").AddressInfo; // TODO(ts): a listening TCP server has an AddressInfo here
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    prompts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/**
 * Agent steps carry `{ thought, action, expectation }`.
 */
export async function startScriptedModel(steps: AgentStep[]) {
  const calls: unknown[] = [];
  let i = 0;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        calls.push(JSON.parse(raw));
      } catch {
        calls.push({ unparseable: raw });
      }
      const step = steps[i++] ?? { thought: "out of script", action: { type: "give_up", reason: "script exhausted" }, expectation: "the run ends" };
      const body = JSON.stringify({
        choices: [
          {
            finish_reason: "tool_calls",
            message: { role: "assistant", content: "", tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "step", arguments: JSON.stringify(step) } }] },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve as () => void)); // TODO(ts): Node's listen callback omits the Promise resolver argument
  const { port } = server.address() as import("node:net").AddressInfo; // TODO(ts): a listening TCP server has an AddressInfo here
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
