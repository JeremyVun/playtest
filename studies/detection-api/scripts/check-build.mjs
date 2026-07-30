#!/usr/bin/env node
// Run the web-study catalog's manifestation checks against a RUNNING build.
//
//   node check-build.mjs --base http://127.0.0.1:4640 [--only f-a,f-b]
//
// Prints one line per check (pass/fail + detail) and a JSON summary. Exit 0
// only when every check passes — callers assert the expected red/green split
// themselves from the JSON.

import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECKS_DIR = resolve(HERE, "..", "..", "detection-web", "catalog", "manifestation");

const { values: args } = parseArgs({
  options: {
    base: { type: "string" },
    only: { type: "string", default: "" },
  },
});
if (!args.base) {
  console.error("need --base <url>");
  process.exit(2);
}
const only = args.only.split(",").map((s) => s.trim()).filter(Boolean);

const BORROWER = {
  name: "Ivy Cole",
  email: "ivy.cole@fairmont.edu",
  department: "Design",
  purpose: "Degree show promotional films.",
};

class CheckFailure extends Error {}

function clientFor(base) {
  const client = {
    base,
    assert(condition, message) {
      if (!condition) throw new CheckFailure(message);
    },
    async api(method, path, body) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async asset(path) {
      const response = await fetch(`${base}${path}`);
      if (!response.ok) throw new Error(`GET ${path} returned ${response.status}`);
      return response.text();
    },
    async reset() {
      const response = await fetch(`${base}/__reset`, { method: "POST" });
      if (!response.ok) throw new Error(`reset returned ${response.status}`);
    },
    async draft(borrower = BORROWER) {
      const created = await client.api("POST", "/api/loan-drafts", borrower);
      if (created.status !== 201) throw new Error(`creating a draft returned ${created.status}`);
      return created.body.draft.id;
    },
  };
  return client;
}

const files = (await readdir(CHECKS_DIR)).filter((n) => n.endsWith(".test.mjs")).sort();
const results = {};
for (const file of files) {
  const module = await import(pathToFileURL(join(CHECKS_DIR, file)).href);
  if (only.length && !only.includes(module.id)) continue;
  try {
    await module.check(clientFor(args.base));
    results[module.id] = { passed: true };
  } catch (error) {
    results[module.id] = { passed: false, detail: String(error.message).slice(0, 200) };
  }
  console.error(`${results[module.id].passed ? "PASS" : "FAIL"} ${module.id}${results[module.id].detail ? " — " + results[module.id].detail : ""}`);
}
console.log(JSON.stringify(results, null, 2));
process.exit(Object.values(results).every((r) => r.passed) ? 0 : 1);
