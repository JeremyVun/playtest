import type { DynamicValue } from "./types.ts";

// The script process bootstrap (docs/contracts/scripts.md#the-script-process).
//
// Spawned by ./runner.ts as `node child.ts`, with its configuration on stdin —
// never on argv, so nothing about a run is visible in a process listing. It
// hardens the process, imports the script, calls its default export with
// `{ client, check, params }`, and reports back over the control channel.
//
// Order matters and is the whole design: the native `fetch` and the harness's
// own modules are captured FIRST, the sandbox is installed SECOND, and only
// then is the script imported. After hardening, the process holds no
// credential, no environment, no ambient network, and no loader that could
// fetch one.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

import { createScriptClient } from "./client.ts";
import { createCheckChannel } from "./check.ts";

/** Child exit codes. The parent's authoritative signal is the reported result. */
export const CHILD_EXIT: DynamicValue = Object.freeze({ ok: 0, scriptError: 3, harnessError: 4 });

const nativeFetch = globalThis.fetch.bind(globalThis);

async function readStdin() {
  const chunks: DynamicValue = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Remove everything that could give the script a credential or a socket. */
function harden({ scriptRoot }: DynamicValue) {
  register("./sandbox-hooks.ts", import.meta.url, { data: { root: scriptRoot } });
  // Ambient network. The client's own transport closed over nativeFetch before
  // this ran, so removing the globals costs the script nothing it should have.
  for (const name of ["fetch", "WebSocket", "EventSource", "XMLHttpRequest", "Request", "Response", "Headers", "FormData", "navigator"]) {
    try {
      delete globalThis[name as keyof typeof globalThis]; // SAFETY: sandbox hardening intentionally deletes a dynamic denylist of globals
    } catch {}
  }
  // Loader escapes that bypass module hooks.
  try {
    process.getBuiltinModule = () => {
      throw new Error("script sandbox: process.getBuiltinModule is not available to scripts");
    };
  } catch {}
  for (const name of ["binding", "dlopen", "_linkedBinding"]) {
    try {
      delete process[name as keyof typeof process]; // SAFETY: sandbox hardening intentionally deletes a dynamic denylist of process escape hatches
    } catch {}
  }
  // The environment. The parent already spawns the child with a minimal
  // environment carrying no PLAYTEST_SECRET_*; this makes it empty and immutable
  // so a script cannot even observe what the parent chose to pass.
  try {
    process.env = Object.freeze(Object.create(null));
  } catch {
    for (const key of Object.keys(process.env)) {
      try {
        delete process.env[key];
      } catch {}
    }
  }
}

// Set once the control channel is known, so the crash handlers can still report.
let reportCrash: DynamicValue = null;

async function main() {
  const config = JSON.parse(await readStdin());
  const post = (route: DynamicValue, body: DynamicValue) =>
    nativeFetch(`${config.endpoint}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-playtest-script-token": config.token },
      body: JSON.stringify(body),
    }).catch(() => null);

  const channel = createCheckChannel();
  reportCrash = async (kind: DynamicValue, error: DynamicValue) => {
    await post("/report", { records: channel.all(), outcome: { kind, message: describe(error) } });
  };
  const client = createScriptClient({
    endpoint: config.endpoint,
    token: config.token,
    fetchImpl: nativeFetch,
    baseUrl: config.baseUrl,
    mode: config.mode,
    budget: config.budget,
    secretNames: config.secretNames ?? [],
    namespace: config.namespace ?? "",
    drainChecks: () => channel.drain(),
  });

  const finish = async (outcome: DynamicValue) => {
    await post("/report", { records: channel.all(), outcome });
    return outcome.kind === "completed" ? CHILD_EXIT.ok : CHILD_EXIT.scriptError;
  };

  harden({ scriptRoot: config.scriptRoot });

  let module;
  try {
    module = await import(pathToFileURL(config.scriptPath).href);
  } catch (error: DynamicValue) {
    return finish({ kind: "load_failed", message: describe(error) });
  }
  const entry = module?.default;
  if (typeof entry !== "function") {
    return finish({
      kind: "contract_violation",
      message:
        "the script has no default-exported function — a Playtest script is" +
        " `export default async function ({ client, check, params }) { … }`",
    });
  }
  try {
    await entry({ client, check: channel.check, params: config.params ?? {} });
  } catch (error: DynamicValue) {
    return finish({ kind: "threw", message: describe(error), code: error?.code ?? null });
  }
  return finish({ kind: "completed" });
}

function describe(error: DynamicValue) {
  const message = String(error?.message ?? error).split("\n")[0];
  const frame = String(error?.stack ?? "")
    .split("\n")
    .slice(1)
    .find((line) => line.includes("at "));
  return frame ? `${message} (${frame.trim()})` : message;
}

for (const signal of ["unhandledRejection", "uncaughtException"]) {
  process.on(signal, async (error) => {
    process.stderr.write(`script defect: ${signal}: ${describe(error)}\n`);
    await reportCrash?.(signal === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception", error);
    process.exit(CHILD_EXIT.scriptError);
  });
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`script harness error: ${describe(error)}\n`);
    process.exit(CHILD_EXIT.harnessError);
  });
