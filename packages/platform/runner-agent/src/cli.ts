#!/usr/bin/env node
// `runner-agent` — the self-hosted runner, and the only entry point this
// package has. There is one placement model (docs/contracts/hosted.md, "Runner
// pool"), so there is one arrival: the long-lived pool loop, which polls the
// claim board, claims what it can execute, exchanges for a scoped bearer, and
// runs the group or mint executor. Nothing spawns this per job; the control
// plane never starts it and never connects to it.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { runPool, parsePoolArgs, POOL_USAGE } from "./pool.ts";

if (invokedDirectly()) {
  main().catch((e) => {
    console.error(firstLine(e));
    process.exit(2);
  });
}

/**
 * Was this module started as a program, rather than imported? `argv[1]` is
 * whatever the shell typed, which for the installed executable is npm's
 * `node_modules/.bin/runner-agent` SYMLINK while `import.meta.url` is its
 * target — comparing them raw makes a real launch look like an import and the
 * process exits silently having done nothing.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  if (entry === self) return true;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(self);
  } catch {
    return false;
  }
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<RunnerDynamic> {
  // `pool` is accepted as a leading word so the start command the console hands
  // over reads as a verb, but it is the only mode there is.
  const args = argv[0] === "pool" ? argv.slice(1) : argv;
  if (args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(POOL_USAGE);
    return { exitCode: 0 };
  }
  return await runPool(parsePoolArgs(args, env));
}

function firstLine(e: RunnerDynamic): string {
  return String(e?.message || e).split("\n")[0];
}
