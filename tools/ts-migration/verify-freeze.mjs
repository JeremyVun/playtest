#!/usr/bin/env node
// Behavior-freeze checker for the TypeScript migration
// (docs/backlog/ts_migration/BUILD_PLAN.md, strategy rule 7).
//
// For every .js -> .ts rename between a base ref and the working tree (or a
// head ref), strips the types from the new file with the same engine Node
// uses at runtime, tokenizes both versions, and compares. The only permitted
// differences are types, comments, whitespace, and literal file-reference
// extension rewrites (.js -> .ts, .mjs -> .ts/.mts). Anything else is a runtime
// change smuggled into a migration commit.
//
// Usage:
//   node tools/ts-migration/verify-freeze.mjs [--base <ref>] [--head <ref>]
//
// Default base is HEAD, default head is the working tree. Renames must be
// staged (git mv, or git add -A) to be visible against the working tree.
// Exit code 1 on any violation.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import process from "node:process";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const ROOT = git("rev-parse", "--show-toplevel").trim();

function parseArgs(argv) {
  const options = { base: "HEAD", head: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--base") options.base = argv[++i];
    else if (argv[i] === "--head") options.head = argv[++i];
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return options;
}

// --- tokenizer -------------------------------------------------------------
// Produces comparable token streams: comments and whitespace dropped, string
// and template literals kept verbatim (their text is runtime behavior),
// template expression interiors whitespace-collapsed (type stripping blanks
// annotations inside them).

const REGEX_ALLOWED_BEFORE = new Set([
  "(", "[", "{", "}", ",", ";", ":", "=", "!", "&", "|", "?", "+", "-", "*", "%", "^", "~", "<", ">",
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else",
  "yield", "await", "throw",
]);

function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  if (source.startsWith("#!")) {
    const end = source.indexOf("\n");
    i = end === -1 ? source.length : end;
  }

  const push = (text) => tokens.push({ text, line });
  const lastMeaningful = () => (tokens.length ? tokens[tokens.length - 1].text : null);

  const scanString = (quote) => {
    const start = i;
    i += 1;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") { i += 2; continue; }
      if (ch === "\n") line += 1;
      i += 1;
      if (ch === quote) break;
    }
    push(source.slice(start, i));
  };

  const scanTemplate = () => {
    let text = "`";
    i += 1;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") { text += source.slice(i, i + 2); i += 2; continue; }
      if (ch === "`") { text += "`"; i += 1; break; }
      if (ch === "$" && source[i + 1] === "{") {
        // Collapse whitespace inside the expression; stripping type
        // annotations leaves blank runs there that are not behavior.
        text += "${";
        i += 2;
        let depth = 1;
        let expr = "";
        while (i < source.length && depth > 0) {
          const ec = source[i];
          if (ec === "{") depth += 1;
          else if (ec === "}") { depth -= 1; if (depth === 0) { i += 1; break; } }
          if (ec === "\n") line += 1;
          expr += ec;
          i += 1;
        }
        text += expr.replace(/\s+/g, " ").trim() + "}";
        continue;
      }
      if (ch === "\n") line += 1;
      text += ch;
      i += 1;
    }
    push(text);
  };

  const scanRegex = () => {
    const start = i;
    i += 1;
    let inClass = false;
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") { i += 2; continue; }
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) { i += 1; break; }
      else if (ch === "\n") break; // malformed; bail
      i += 1;
    }
    while (i < source.length && /[a-z]/i.test(source[i])) i += 1; // flags
    push(source.slice(start, i));
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === "\n") { line += 1; i += 1; continue; }
    if (ch === " " || ch === "\t" || ch === "\r") { i += 1; continue; }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const block = source.slice(i, end === -1 ? source.length : end + 2);
      line += block.split("\n").length - 1;
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") { scanString(ch); continue; }
    if (ch === "`") { scanTemplate(); continue; }
    if (ch === "/") {
      const before = lastMeaningful();
      if (before === null || REGEX_ALLOWED_BEFORE.has(before)) { scanRegex(); continue; }
      push("/");
      i += 1;
      continue;
    }
    const word = /^[\w$]+/.exec(source.slice(i));
    if (word) { push(word[0]); i += word[0].length; continue; }
    push(ch);
    i += 1;
  }
  return tokens;
}

// --- comparison ------------------------------------------------------------

function isAllowedSpecifierRewrite(oldText, newText) {
  const quoted = /^["'`]/.test(oldText) && oldText[0] === newText[0];
  if (!quoted) return false;
  const oldBody = oldText.slice(1, -1);
  const newBody = newText.slice(1, -1);
  return (
    (oldBody.endsWith(".js") && newBody === oldBody.slice(0, -3) + ".ts") ||
    (oldBody.endsWith(".mjs")
      && (newBody === oldBody.slice(0, -4) + ".ts" || newBody === oldBody.slice(0, -4) + ".mts"))
  );
}

function compareTokens(oldTokens, newTokens) {
  const max = Math.max(oldTokens.length, newTokens.length);
  for (let i = 0; i < max; i += 1) {
    const oldToken = oldTokens[i];
    const newToken = newTokens[i];
    if (!oldToken || !newToken) {
      return { index: i, oldToken, newToken };
    }
    if (oldToken.text === newToken.text) continue;
    if (isAllowedSpecifierRewrite(oldToken.text, newToken.text)) continue;
    return { index: i, oldToken, newToken };
  }
  return null;
}

function context(tokens, index) {
  return tokens
    .slice(Math.max(0, index - 4), index + 5)
    .map((token, offset) => (Math.max(0, index - 4) + offset === index ? `>>${token.text}<<` : token.text))
    .join(" ");
}

// --- pair discovery --------------------------------------------------------

function diffPairs(base, head) {
  const args = ["diff", "--name-status", "-M50%", base];
  if (head) args.push(head);
  const renames = [];
  const added = [];
  const deleted = [];
  const modifiedTs = [];
  for (const row of git(...args).trimEnd().split("\n")) {
    if (!row) continue;
    const [status, ...paths] = row.split("\t");
    if (
      status.startsWith("R")
      && /\.(?:m?js)$/.test(paths[0])
      && /\.(?:m?ts)$/.test(paths[1])
    ) {
      renames.push({ from: paths[0], to: paths[1] });
    } else if (status === "A" && /\.(ts|mts)$/.test(paths[0])) {
      added.push(paths[0]);
    } else if (status === "D" && /\.(js|mjs)$/.test(paths[0])) {
      deleted.push(paths[0]);
    } else if (status === "M" && /\.(ts|mts)$/.test(paths[0])) {
      modifiedTs.push(paths[0]);
    }
  }
  // Pair a deleted .js with an added .ts of the same stem: a rewrite too
  // heavy for git's rename detection is exactly what needs scrutiny.
  const remainingAdded = new Set(added);
  for (const gone of [...deleted]) {
    const stem = gone.replace(/\.(js|mjs)$/, "");
    const match = [...remainingAdded].find((file) => file.replace(/\.(ts|mts)$/, "") === stem);
    if (match) {
      renames.push({ from: gone, to: match, lowSimilarity: true });
      remainingAdded.delete(match);
      deleted.splice(deleted.indexOf(gone), 1);
    }
  }
  return { renames, added: [...remainingAdded], deleted, modifiedTs };
}

function readAt(ref, file) {
  if (ref === null) return fs.readFileSync(path.join(ROOT, file), "utf8");
  return git("show", `${ref}:${file}`);
}

// --- main ------------------------------------------------------------------

const options = parseArgs(process.argv.slice(2));
const { renames, added, deleted, modifiedTs } = diffPairs(options.base, options.head);
let failures = 0;

for (const pair of renames) {
  const oldSource = readAt(options.base, pair.from);
  const newSource = readAt(options.head, pair.to);
  let stripped;
  try {
    stripped = stripTypeScriptTypes(newSource, { mode: "strip" });
  } catch (error) {
    console.log(`FAIL ${pair.to}: not erasable-syntax-only — ${error.message}`);
    failures += 1;
    continue;
  }
  const mismatch = compareTokens(tokenize(oldSource), tokenize(stripped));
  if (mismatch === null) {
    const note = pair.lowSimilarity ? " (git saw no rename; token streams match anyway)" : "";
    console.log(`OK   ${pair.from} -> ${pair.to}${note}`);
  } else {
    failures += 1;
    const { oldToken, newToken, index } = mismatch;
    console.log(`FAIL ${pair.from} -> ${pair.to}: runtime code changed`);
    console.log(`     old ${oldToken ? `line ${oldToken.line}` : "(end of file)"}: ${oldToken ? context(tokenize(oldSource), index) : "(nothing)"}`);
    console.log(`     new ${newToken ? `line ${newToken.line}` : "(end of file)"}: ${newToken ? context(tokenize(stripped), index) : "(nothing)"}`);
  }
}

for (const file of added) {
  console.log(`NEW  ${file}: no .js ancestor — review as new code, not a conversion`);
}
for (const file of deleted) {
  failures += 1;
  console.log(`FAIL ${file}: deleted with no .ts replacement — migration commits must not remove code`);
}
for (const file of modifiedTs) {
  console.log(`INFO ${file}: modified in place (not a conversion; ordinary review applies)`);
}

if (renames.length === 0 && added.length === 0 && deleted.length === 0) {
  console.log("no .js -> .ts conversions found in range (are your renames staged?)");
}
console.log(failures === 0 ? "freeze check passed" : `freeze check FAILED: ${failures} violation(s)`);
process.exit(failures === 0 ? 0 : 1);
