// `playtest demo` — a three-act tour of record → act → heal against the
// bundled todo app (VERSION_1.md item 5; IMPROVEMENTS_FOLLOWUP.md §4).
// One command, zero keys, zero docker, zero second terminal.
//
// Everything runs on a temp copy of src/demo/ with runs under <tmp>/runs —
// the installed package directory is never written to. Each act is a real
// child run of cli.js with inherited stdio, so the live region and the
// end-of-run changed-journey prompt behave exactly like a user's own run;
// the in-process fixtures (todo app + mock LLM) just give it something to
// talk to. Act three's finale IS the child's own prompt: the UI changed,
// the journey survived, here is the review.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { start as startTodoApp } from "../todo-app/server.js";
import { start as startMockLlm } from "./testing/mock-llm.js";
import { ensureBrowser } from "./preflight.js";
import { DummyConfigError } from "./config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "cli.js");
const SUITE_SRC = path.resolve(HERE, "..", "demo");

// Model selection: a real key means the real model narrates — genuine
// thoughts are the magic in front of an audience, and three cases cost
// cents. Without one the child is pointed at the in-process mock, so the
// zero-key `npx` path always works. (llm.js reads its env at module load,
// which is exactly why the acts are child processes with a crafted env.)
const realKeyConfigured = () =>
  Boolean(process.env.PLAYTEST_LLM_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);

/** Case yamls in the copied suite (playtest.yaml files are config, not cases). */
function countCases(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const base = path.basename(String(entry));
    if (/\.ya?ml$/.test(base) && base !== "playtest.yaml") n++;
  }
  return n;
}

/**
 * Run the three-act demo. Throws DummyConfigError when an act fails (the cli
 * wrapper turns that into a clean message and a nonzero exit).
 * @param {{ keep?: boolean, headed?: boolean }} [opts]
 */
export async function demo(opts = {}) {
  // Nothing durable is measured here, so the system-Chrome fallback is
  // acceptable (preflight.js channel policy) — but only the demo's children
  // ever see it, via PLAYTEST_BROWSER_CHANNEL in their env.
  const { channel } = await ensureBrowser({ ...opts, allowChromeFallback: true });

  // realpath: macOS tmpdirs are symlinks (/var → /private/var); the child's
  // cwd resolves to the real path, so passing the symlinked spelling through
  // --runs-root would make its printed accept commands ../../-relative noise.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "playtest-demo-")));
  const suiteDir = path.join(tmp, "suite");
  const runsRoot = path.join(tmp, "runs");
  let app = null; // todo-app instance (replaced by the variant-b one in act three)
  let mock = null; // mock LLM, only when no real key is configured
  let child = null; // the live act, if any

  // Cleanup must run on every exit, including Ctrl-C mid-act: kill the live
  // child and remove the temp dir (--keep retains it and prints the path).
  // The fixture servers die with the process; finally also closes them
  // politely so a successful demo doesn't linger on open sockets.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      child?.kill("SIGKILL");
    } catch {}
    if (opts.keep) {
      console.log(`\ndemo directory retained (--keep): ${tmp}`);
      return;
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
    } catch (err) {
      // A SIGKILLed child can still be flushing a file: losing the race is
      // not worth an uncaught throw in a signal handler — say where it is.
      console.error(`playtest: demo temp dir left behind: ${tmp} (${err.message})`);
    }
  };
  const onSignal = (signal) => {
    cleanup();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    fs.cpSync(SUITE_SRC, suiteDir, { recursive: true });
    fs.mkdirSync(runsRoot, { recursive: true });
    const caseCount = countCases(suiteDir);

    app = await startTodoApp();
    if (!realKeyConfigured()) mock = await startMockLlm();

    const env = { ...process.env };
    if (channel === "chrome") env.PLAYTEST_BROWSER_CHANNEL = "chrome";
    if (mock) env.PLAYTEST_LLM_BASE_URL = mock.url;

    // One act = one real CLI run with inherited stdio; cwd is the temp dir so
    // even cwd-relative output (printed accept commands, persona lookup)
    // never touches the package or the user's project.
    const act = (header, baseUrl) => {
      console.log(`\n${header}`);
      return new Promise((resolve, reject) => {
        child = spawn(
          process.execPath,
          [
            CLI, "run", suiteDir,
            "--base-url", baseUrl,
            "--runs-root", runsRoot,
            ...(opts.headed ? ["--headed"] : []),
          ],
          { stdio: "inherit", env, cwd: tmp },
        );
        child.on("error", reject);
        child.on("close", (code) => {
          child = null;
          resolve(code);
        });
      });
    };
    const expectPass = (code, name) => {
      if (code !== 0) throw new DummyConfigError(`demo ${name} failed (exit code ${code}); see the run output above`);
    };

    console.log(
      mock
        ? "Playtest demo — bundled todo app, offline mock model (set an API key to watch a real model narrate)."
        : "Playtest demo — bundled todo app, real model (API key found).",
    );

    expectPass(await act("Act one — recording: the agent improvises each case from its story.", app.url), "act one (recording)");

    const callsBefore = mock?.requestCount() ?? 0;
    const started = Date.now();
    expectPass(await act("Act two — checking: the same cases follow the saved paths step for step.", app.url), "act two (checking)");
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    // Measured, not asserted: the mock counts its own requests; without the
    // mock the count is 0 by construction (act mode makes no actor/grader
    // calls and this suite has no assert: gates to call verdict on).
    const modelCalls = mock ? mock.requestCount() - callsBefore : 0;
    console.log(`\nSecond run followed the saved paths: ${modelCalls} model calls, ${caseCount} cases in ${seconds}s.`);

    await app.close();
    app = await startTodoApp({ variant: "b" });
    console.log('\nThe app changed under the tests: the Add button is now "Save" with a new data-testid.');
    expectPass(
      await act("Act three — healing: the saved paths miss, the agent recovers, and the changed journeys await your review.", app.url),
      "act three (healing)",
    );
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    if (app) await app.close().catch(() => {});
    if (mock) await mock.close().catch(() => {});
    cleanup();
  }
}
