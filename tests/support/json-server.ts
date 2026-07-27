import http from "node:http";

interface JsonRequest {
  method?: string;
  url?: string;
  body: LegacyTestValue;
}

export async function startJsonServer(
  respond: (body: unknown, requestNumber: number) => unknown | Promise<unknown>
) {
  const requests: JsonRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push({ method: req.method, url: req.url, body });
        const payload = await respond(body, requests.length);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      } catch (error: any) { // TODO(ts): preserve legacy Error-shaped catch access without changing runtime tokens
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve as () => void); // TODO(ts): Node's listen callback omits the Promise resolver argument
  });
  const { port } = server.address() as import("node:net").AddressInfo; // TODO(ts): a listening TCP server has an AddressInfo here
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => [...requests],
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

export function textCompletion(content = "ok") {
  return {
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}

export function toolCompletion(name: string, args: unknown) {
  return {
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_test",
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: "tool_calls",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
}
