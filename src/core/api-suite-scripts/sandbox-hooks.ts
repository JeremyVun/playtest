import type { DynamicValue } from "./types.ts";

// Module-resolution hooks for the script process
// (docs/contracts/scripts.md#the-script-process).
//
// Registered by ./child.js through `module.register` BEFORE the script is
// imported, so they cover every static and dynamic import the script performs.
// Two rules:
//
//   1. a bare specifier resolves only if it is on the built-in allowlist —
//      scripts are zero-dependency, and the modules that would give a script a
//      socket (`node:net`, `node:http`, `node:dns`), a subprocess
//      (`node:child_process`), a filesystem (`node:fs`), an unhooked loader
//      (`node:module`, `node:vm`) or an unhooked thread (`node:worker_threads`)
//      are refused;
//   2. a relative or absolute specifier resolves only inside the script root,
//      so a script cannot import — and therefore cannot read — a file outside
//      its own directory.
//
// This is defence in depth against ACCIDENT and casual misuse, and it is the
// in-process half of the hosted boundary. The half that carries the security
// claim is the proxy: the script process holds no credential, so an escape from
// these hooks still yields nothing to steal (docs/contracts/scripts.md#trust-model).

/** Built-ins a script may import: computation, no I/O and no loader. */
export const ALLOWED_BUILTINS: DynamicValue = Object.freeze([
  "node:assert",
  "node:assert/strict",
  "node:buffer",
  "node:crypto",
  "node:events",
  "node:path",
  "node:path/posix",
  "node:punycode",
  "node:querystring",
  "node:string_decoder",
  "node:timers/promises",
  "node:url",
  "node:util",
  "node:zlib",
]);

const allowed: DynamicValue = new Set(ALLOWED_BUILTINS);
let root: DynamicValue = null;

export async function initialize(data: DynamicValue) {
  root = typeof data?.root === "string" ? data.root : null;
}

export async function resolve(specifier: DynamicValue, context: DynamicValue, next: DynamicValue) {
  const spec = String(specifier);
  const relative = spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("file:");
  if (!relative) {
    const normalized = spec.startsWith("node:") ? spec : `node:${spec}`;
    if (!allowed.has(normalized)) {
      throw new Error(
        `script sandbox: import of "${spec}" is not permitted — scripts are zero-dependency and reach the network` +
          ` only through the injected client (permitted built-ins: ${ALLOWED_BUILTINS.join(", ")})`,
      );
    }
    return next(normalized, context);
  }
  const resolved = await next(spec, context);
  if (root && typeof resolved?.url === "string" && resolved.url.startsWith("file:") && !resolved.url.startsWith(root)) {
    throw new Error(`script sandbox: import of "${spec}" resolves outside the script root, which is not permitted`);
  }
  return resolved;
}
