// Arm P setup: create the hosted project, application, environment, and suite
// for one trial, upload the frozen story suite, and commit it — exactly the
// calls a customer's automation would make. One fresh project per trial.
//
// Usage:
//   node arm-p-setup.mjs --project-key det-t1 --name "Detection trial 1" \
//     --suite-dir <frozen suite dir> --base-url http://127.0.0.1:4620 \
//     --out <setup.json>

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { api } from "./lib/api.mjs";

const { values: args } = parseArgs({
  options: {
    "project-key": { type: "string" },
    name: { type: "string" },
    "suite-dir": { type: "string" },
    "base-url": { type: "string" },
    out: { type: "string" },
  },
});
for (const k of ["project-key", "name", "suite-dir", "base-url", "out"]) {
  if (!args[k]) {
    console.error(`missing --${k}`);
    process.exit(2);
  }
}

const projectKey = args["project-key"];

const project = await api.post("/projects", { key: projectKey, name: args.name });
// Consolidation is part of the product under test: pin automatic dedupe ON so
// grouping needs no reviewer action. Other policies inherit deployment defaults.
await api.put(`/projects/${projectKey}/auto-dedupe`, { enabled: true });

const app = await api.post(`/projects/${projectKey}/applications`, {
  key: "subject",
  name: "Study subject",
  driver: "web",
});
const appId = app.application?.id ?? app.id;

const ring = await api.post(`/applications/${appId}/rings`, {
  key: "study",
  name: "Study environment",
  base_url: args["base-url"],
});
const ringId = ring.ring?.id ?? ring.id;

const suite = await api.post(`/projects/${projectKey}/suites`, {
  slug: "stories",
  name: "Frozen story suite",
});
const suiteId = suite.suite?.id ?? suite.id;

// Upload the frozen suite tree in one atomic commit.
const changes = [];
const walk = (dir, rel = "") => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "results") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r);
    else changes.push({ path: r, content: fs.readFileSync(path.join(dir, e.name), "utf8") });
  }
};
walk(args["suite-dir"]);
if (!changes.length) throw new Error(`no files under ${args["suite-dir"]}`);
await api.post(`/suites/${suiteId}/commit`, { changes, note: "frozen study suite" });

const validation = await api.post(`/suites/${suiteId}/validate`, { changes: [] });
const cases = await api.get(`/suites/${suiteId}/cases`);

const setup = {
  project_key: projectKey,
  project_id: project.project?.id ?? project.id,
  application_id: appId,
  ring_id: ringId,
  suite_id: suiteId,
  base_url: args["base-url"],
  files: changes.map((c) => c.path).sort(),
  cases: (cases.items ?? cases.cases ?? []).map((c) => ({ id: c.id, story: c.story ?? c.story_id, mode: c.mode })),
  validation_ok: !(validation.errors?.length),
  validation,
  created_at: new Date().toISOString(),
};
fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify(setup, null, 2));
console.log(JSON.stringify({ project: projectKey, suite: suiteId, ring: ringId, cases: setup.cases.length, validation_ok: setup.validation_ok }));
