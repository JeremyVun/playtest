// End-of-run review prompt. Pure I/O
// orchestration: streams and both actions are injected, so the flow is
// testable with piped streams and cli.js keeps the actual accept/serve logic.
import readline from "node:readline/promises";

const yes = (answer, byDefault) => {
  const a = answer.trim().toLowerCase();
  return a === "" ? byDefault : a === "y" || a === "yes";
};

/**
 * "Open review? [Y/n]" (default yes), else "Accept all? [y/N]" (default no).
 * The caller gates on TTY/--ci/--yes; this assumes an interactive session.
 * @param {number} count pending changed journeys
 * @param {{ input?: import("node:stream").Readable, output?: import("node:stream").Writable,
 *           openReview: () => Promise<void>, acceptAll: () => Promise<void> }} io
 * @returns {Promise<"review"|"accepted"|"declined">}
 */
export async function promptChangedReview(count, { input = process.stdin, output = process.stdout, openReview, acceptAll }) {
  const rl = readline.createInterface({ input, output });
  try {
    output.write(`\n${count} changed journey(s) passed and need review.\n`);
    if (yes(await rl.question("Open review? [Y/n] "), true)) {
      await openReview();
      return "review";
    }
    if (yes(await rl.question("Accept all? [y/N] "), false)) {
      await acceptAll();
      return "accepted";
    }
    return "declined";
  } finally {
    rl.close();
  }
}

/**
 * Numbered picker for a named environment (app.envs) when no --env was passed
 * and the top-level app.* has no usable base_url. The caller gates on TTY; this
 * assumes an interactive session. An empty/invalid choice defaults to the first.
 * @param {string[]} names available env names (non-empty)
 * @param {{ input?: import("node:stream").Readable, output?: import("node:stream").Writable }} [io]
 * @returns {Promise<string>} the chosen env name
 */
export async function promptEnv(names, { input = process.stdin, output = process.stdout } = {}) {
  const rl = readline.createInterface({ input, output });
  try {
    output.write("\nNo app.base_url configured. Pick an environment:\n");
    names.forEach((name, i) => output.write(`  ${i + 1}) ${name}\n`));
    const answer = (await rl.question(`Environment [1-${names.length}, default 1]: `)).trim();
    const n = Number(answer);
    if (answer !== "" && Number.isInteger(n) && n >= 1 && n <= names.length) return names[n - 1];
    return names[0];
  } finally {
    rl.close();
  }
}
