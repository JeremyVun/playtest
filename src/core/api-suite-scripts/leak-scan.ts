import type { DynamicValue } from "./types.ts";

// The leak scan that runs on script SAVE (docs/contracts/scripts.md#leak-scan).
//
// A script is source code with the same problem a committed baseline has: it
// lives forever, everyone with the project can read it, and the easiest way to
// make an authenticated request is to paste the token. So the P2 machinery that
// guards baseline acceptance (../baseline-scan.ts) guards script text too, with
// the same four rules and the same consequence: findings BLOCK — the script does
// not reach review until they are gone.
//
// Nothing here is advisory hygiene. A credential in script text defeats the
// entire secret-injection design: the proxy can only keep a value out of the
// child if the value was never written into the child's program.
import { EMAIL_RE, TOKEN_RE, fingerprint, looksLikeCredential } from "../baseline-scan.ts";
import { knownSecretValues, registerSecretsFromEnv } from "../secrets.ts";

/** Scan rules, in reporting order. */
export const LEAK_RULES: DynamicValue = Object.freeze(["secret", "redaction", "entropy", "data"]);

// String and template literals: where a pasted credential actually lands. Code
// identifiers and comments are not scanned for entropy, because a base64 blob in
// a comment is a different (and much noisier) problem.
const LITERAL_RE = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

const truncate = (value: DynamicValue, max = 40) => (value.length > max ? `${value.slice(0, max)}…` : value);

function positionOf(text: DynamicValue, index: DynamicValue) {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const column = index - (before.lastIndexOf("\n") + 1) + 1;
  return { line, column };
}

/**
 * @param {string} source the script text as it would be saved
 * @param {{ redact?: object|null, secretNames?: string[]|null }} [options]
 *   `secretNames` lets a process that did not run the script rebuild the
 *   known-secret registry from its own environment (the P2 pattern), so a save
 *   in a fresh shell still catches a pasted value.
 * @returns {{ findings: {rule: string, line: number, column: number, detail: string}[], fingerprint: string }}
 */
export function scanScriptText(source: DynamicValue, { redact = null, secretNames = null }: DynamicValue = {}) {
  const text = String(source ?? "");
  const names: DynamicValue = new Set(secretNames ?? []);
  for (const entry of redact?.request ?? []) if (entry?.secret) names.add(entry.secret);
  if (names.size) registerSecretsFromEnv([...names]);

  const findings: DynamicValue = [];
  const add = (rule: DynamicValue, index: DynamicValue, detail: DynamicValue) => findings.push({ rule, ...positionOf(text, index), detail });
  const declaredRedaction: DynamicValue = new Set((redact?.request ?? []).map((entry: DynamicValue) => entry?.secret).filter(Boolean));

  // 1 + 2. Known secret values, anywhere in the text. A value whose name is on
  // the case's redaction list is reported under `redaction` so the message can
  // name the declaration the script contradicts.
  for (const [value, name] of knownSecretValues()) {
    for (const needle of new Set([value, JSON.stringify(value).slice(1, -1)])) {
      let at = text.indexOf(needle);
      while (at !== -1) {
        const rule = declaredRedaction.has(name) ? "redaction" : "secret";
        add(
          rule,
          at,
          `the value of secret "${name}" appears literally — pass client.secret("${name}") instead, so the credential` +
            ` never enters the script process`,
        );
        at = text.indexOf(needle, at + needle.length);
      }
    }
  }

  // 3 + 4. Credential-shaped tokens and application data in string literals.
  for (const match of text.matchAll(LITERAL_RE)) {
    const literal = match[2];
    if (!literal) continue;
    const at = match.index + 1;
    for (const token of literal.match(TOKEN_RE) ?? []) {
      if (looksLikeCredential(token)) {
        add("entropy", at, `credential-shaped token ${JSON.stringify(truncate(token, 12))} — inject it as a secret reference instead`);
        break;
      }
    }
    for (const email of literal.match(EMAIL_RE) ?? []) {
      add("data", at, `email address ${JSON.stringify(email)} — real application data does not belong in script text`);
      break;
    }
  }

  findings.sort((a: DynamicValue, b: DynamicValue) => LEAK_RULES.indexOf(a.rule) - LEAK_RULES.indexOf(b.rule) || a.line - b.line || a.column - b.column);
  return { findings, fingerprint: fingerprint(text) };
}

/** One human-readable line per finding, for the CLI and the script page. */
export function describeLeakFindings(findings: DynamicValue) {
  return (findings ?? []).map((finding: DynamicValue) => `  ${finding.rule}: line ${finding.line}:${finding.column} — ${finding.detail}`);
}
