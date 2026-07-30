// Itemize a Schemathesis JUnit report into the generic judge-prep arm-F
// shape: one item per <failure> block (an operation may carry several).
//
//   node parse-arm-f.mjs --junit <junit.xml> --out <report.json>

import fs from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: { junit: { type: "string" }, out: { type: "string" } },
});
if (!args.junit || !args.out) {
  console.error("need --junit and --out");
  process.exit(2);
}

const xml = fs.readFileSync(args.junit, "utf8");
const unescape = (s) =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#10;", "\n")
    .replaceAll("&#x27;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

const items = [];
for (const tc of xml.matchAll(/<testcase\b[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/testcase>/g)) {
  const op = unescape(tc[1]);
  for (const f of tc[2].matchAll(/<failure\b[^>]*(?:message="([^"]*)")?[^>]*>([\s\S]*?)<\/failure>/g)) {
    const body = unescape(f[2] ?? "").trim();
    // Checks fired in this block, e.g. "- Server error".
    const checks = [...body.matchAll(/^- (.+)$/gm)].map((m) => m[1].trim());
    items.push({
      ref: op,
      title: `${op}: ${checks.join("; ") || unescape(f[1] ?? "failure")}`,
      body,
    });
  }
}

fs.writeFileSync(args.out, JSON.stringify({ arm: "F", tool: "schemathesis", items }, null, 2));
console.log(JSON.stringify({ items: items.length, out: args.out }));
