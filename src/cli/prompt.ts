// End-of-run review prompt. Pure I/O
// orchestration: streams and both actions are injected, so the flow is
// testable with piped streams and cli.ts keeps the actual accept/serve logic.
import readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

interface PromptIo {
  input?: Readable;
  output?: Writable;
}

interface ChangedReviewIo extends PromptIo {
  openReview: () => Promise<void>;
  acceptAll: () => Promise<void>;
}

interface ConfirmIo extends PromptIo {
  defaultYes?: boolean;
}

const yes = (answer: string, byDefault: boolean) => {
  const a = answer.trim().toLowerCase();
  return a === "" ? byDefault : a === "y" || a === "yes";
};

/**
 * "Open review? [Y/n]" (default yes), else "Accept all? [y/N]" (default no).
 * The caller gates on TTY/--json; this assumes an interactive session.
 * @param {number} count pending changed journeys
 * @param {{ input?: import("node:stream").Readable, output?: import("node:stream").Writable,
 *           openReview: () => Promise<void>, acceptAll: () => Promise<void> }} io
 * @returns {Promise<"review"|"accepted"|"declined">}
 */
export async function promptChangedReview(count: number, { input = process.stdin, output = process.stdout, openReview, acceptAll }: ChangedReviewIo) {
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
 * A single yes/no confirmation. The caller gates on TTY/--json; this assumes an
 * interactive session. Used by `playtest findings consolidate` so a proposed
 * plan is only ever applied after an explicit human answer.
 * @returns {Promise<boolean>}
 */
export async function promptConfirm(question: string, { input = process.stdin, output = process.stdout, defaultYes = false }: ConfirmIo = {}) {
  const rl = readline.createInterface({ input, output });
  try {
    return yes(await rl.question(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `), defaultYes);
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
export async function promptEnv(names: string[], { input = process.stdin, output = process.stdout }: PromptIo = {}) {
  const rl = readline.createInterface({ input, output });
  try {
    output.write("\nNo app.base_url configured. Pick an environment:\n");
    names.forEach((name, i) => output.write(`  ${i + 1}) ${name}\n`));
    const answer = (await rl.question(`Environment [1-${names.length}, default 1]: `)).trim();
    const n = Number(answer);
    if (answer !== "" && Number.isInteger(n) && n >= 1 && n <= names.length) return names[n - 1] as string; // TODO(ts): range check guarantees the selected name exists
    return names[0] as string; // TODO(ts): callers provide a documented non-empty name list
  } finally {
    rl.close();
  }
}
