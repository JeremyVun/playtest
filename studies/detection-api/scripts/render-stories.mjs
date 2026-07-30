// Render the frozen suite's story/persona text into the single markdown
// document given to arm C. Both arms receive identical story and persona
// text; gates, report questions, and case metadata are instrument-specific
// and are not part of the shared text.
//
// Usage: node render-stories.mjs --suite <dir> --out <file>

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../packages/core/package.json", import.meta.url));
const YAML = require("yaml");

const { values: args } = parseArgs({
  options: { suite: { type: "string" }, out: { type: "string" } },
});
if (!args.suite || !args.out) {
  console.error("usage: render-stories.mjs --suite <dir> --out <file>");
  process.exit(2);
}

const caseFiles = (dir) =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".yaml") && e.name !== "playtest.yaml")
    .map((e) => path.join(dir, e.name))
    .sort();

const journeyFiles = caseFiles(path.join(args.suite, "stories"));
const rootFiles = caseFiles(args.suite);

const personaText = fs
  .readFileSync(
    new URL("../../../packages/cli/skills/playtest-bughunt/persona-adversarial.md", import.meta.url),
    "utf8",
  )
  .trim();

const lines = ["## User stories", ""];
let n = 0;
for (const f of journeyFiles) {
  const c = YAML.parse(fs.readFileSync(f, "utf8"));
  n++;
  lines.push(`### Story ${n}`, "", c.story.trim(), "");
}
lines.push(
  "## Risk missions",
  "",
  "Work the following missions in the persona described here:",
  "",
  personaText,
  "",
);
for (const f of rootFiles) {
  const c = YAML.parse(fs.readFileSync(f, "utf8"));
  n++;
  lines.push(`### Story ${n}`, "", c.story.trim(), "");
}

fs.mkdirSync(path.dirname(args.out), { recursive: true });
fs.writeFileSync(args.out, lines.join("\n"));
console.log(JSON.stringify({ stories: n, out: args.out }));
