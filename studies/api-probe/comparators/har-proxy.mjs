#!/usr/bin/env node
// A recording forward proxy for the comparator arms (PREREGISTRATION.md
// "Arms"). Schemathesis writes its own HAR; an agent-authored test suite does
// not, and asking the authoring agent to use a supplied HTTP client would leak
// instrument shape into an arm that is supposed to be free to test however it
// likes. So the suite points at this proxy instead, writes ordinary HTTP, and
// its traffic reaches the bench as a HAR 1.2 document scored by exactly the
// same oracles as every other arm.
//
//   node studies/api-probe/comparators/har-proxy.mjs \
//     --target http://127.0.0.1:4180 --port 4191 --out comparator/agent.har
//
// The HAR is flushed on every exchange and on shutdown, so a killed suite still
// leaves a scorable trace. Bodies are captured verbatim: this proxies a
// disposable local fixture whose credentials are published throwaway values.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const arg = (name, dflt = null) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : dflt;
};

const target = arg("target", process.env.PROXY_TARGET ?? "http://127.0.0.1:4180").replace(/\/+$/, "");
const port = Number(arg("port", process.env.PROXY_PORT ?? "4191"));
const outFile = arg("out", process.env.HAR_OUT ?? "comparator.har");
const label = arg("label", process.env.HAR_LABEL ?? null);
// The frozen per-build budget, enforced here rather than trusted to the arm.
// Schemathesis has no request cap and is not reproducible run to run even under
// a fixed seed, so "tune --max-examples to land under 360" cannot hold a budget;
// counting at the wire can. Past the cap the proxy stops forwarding and answers
// 503 without recording an entry, so the scored trace is exactly the budget and
// carries no synthetic refusals.
const maxRequests = Number(arg("max-requests", process.env.HAR_MAX_REQUESTS ?? "0")) || Infinity;

fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });

const entries = [];
const headerPairs = (headers) =>
  Object.entries(headers).flatMap(([name, value]) =>
    (Array.isArray(value) ? value : [value]).map((one) => ({ name, value: String(one ?? "") })),
  );

let writeQueued = false;
const flush = () => {
  writeQueued = false;
  const document = {
    log: {
      version: "1.2",
      creator: { name: "playtest-api-probe-har-proxy", version: "1", comment: `target=${target}` },
      entries,
    },
  };
  fs.writeFileSync(outFile, JSON.stringify(document, null, 1));
};
const queueFlush = () => {
  if (writeQueued) return;
  writeQueued = true;
  setTimeout(flush, 50).unref?.();
};

let budgetExhaustedAt = null;
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", async () => {
    // Out-of-band readiness, answered by the proxy itself: a readiness probe
    // forwarded upstream would be recorded and would spend one of the arm's
    // budgeted requests on the harness's own plumbing.
    if (request.url === "/__proxy_health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, recorded: entries.length, budget: maxRequests === Infinity ? null : maxRequests }));
      return;
    }
    if (entries.length >= maxRequests) {
      if (budgetExhaustedAt === null) {
        budgetExhaustedAt = new Date().toISOString();
        process.stderr.write(`har-proxy: budget of ${maxRequests} requests exhausted at ${budgetExhaustedAt}\n`);
      }
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "budget_exhausted", message: `measurement budget of ${maxRequests} requests is spent` } }));
      return;
    }
    const requestBody = Buffer.concat(chunks);
    const url = `${target}${request.url}`;
    const startedAt = new Date();
    const startedMs = Date.now();

    // Hop-by-hop headers a forwarding proxy must not replay.
    const forwardHeaders = { ...request.headers };
    delete forwardHeaders.host;
    delete forwardHeaders.connection;
    delete forwardHeaders["content-length"];
    delete forwardHeaders["accept-encoding"];

    let upstream;
    let responseBody = "";
    let failed = false;
    try {
      upstream = await fetch(url, {
        method: request.method,
        headers: forwardHeaders,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : requestBody,
        redirect: "manual",
      });
      responseBody = await upstream.text();
    } catch (error) {
      failed = true;
      responseBody = JSON.stringify({ error: { code: "proxy_error", message: String(error?.message ?? error) } });
    }

    const timeMs = Date.now() - startedMs;
    const responseHeaders = failed ? {} : Object.fromEntries(upstream.headers.entries());
    entries.push({
      startedDateTime: startedAt.toISOString(),
      time: timeMs,
      request: {
        method: request.method,
        url,
        httpVersion: "HTTP/1.1",
        headers: headerPairs(request.headers),
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: requestBody.length,
        ...(requestBody.length
          ? { postData: { mimeType: request.headers["content-type"] ?? "application/json", text: requestBody.toString("utf8") } }
          : {}),
      },
      response: {
        status: failed ? 0 : upstream.status,
        statusText: failed ? "proxy error" : upstream.statusText,
        httpVersion: "HTTP/1.1",
        headers: headerPairs(responseHeaders),
        cookies: [],
        content: {
          size: Buffer.byteLength(responseBody),
          mimeType: responseHeaders["content-type"] ?? "application/json",
          text: responseBody,
        },
        redirectURL: "",
        headersSize: -1,
        bodySize: Buffer.byteLength(responseBody),
      },
      cache: {},
      timings: { send: 0, wait: timeMs, receive: 0 },
      ...(failed ? { _failed: true } : {}),
    });
    queueFlush();

    if (failed) {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(responseBody);
      return;
    }
    const passthrough = { ...responseHeaders };
    delete passthrough["content-encoding"];
    delete passthrough["content-length"];
    delete passthrough["transfer-encoding"];
    response.writeHead(upstream.status, passthrough);
    response.end(responseBody);
  });
});

const shutdown = () => {
  flush();
  process.stderr.write(`har-proxy: ${entries.length} exchanges -> ${outFile}\n`);
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(port, "127.0.0.1", () => {
  flush();
  process.stderr.write(`har-proxy: 127.0.0.1:${port} -> ${target}${label ? ` (label ${label})` : ""}\n`);
});
