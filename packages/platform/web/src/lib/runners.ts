// Self-hosted runner helpers, kept DOM-free so the offline gate can assert the
// two things that matter about this surface without a browser: the exact
// command a person pastes, and that the credential is genuinely a one-time
// reveal rather than something the page can show twice.

export interface RunnerStartCommand {
  server: string;
  credential: string;
  labels?: string[];
  isolation?: string | null;
}

/**
 * The one line a person pastes into a terminal on the machine that can reach
 * the target. Two rules it exists to keep:
 *
 *   - the credential rides the ENVIRONMENT, never an argument, so it cannot be
 *     read out of `ps` by anyone else on that machine;
 *   - it runs from a Playtest checkout with no install step of its own —
 *     `node_modules/.bin/runner-agent` is there after `npm install`.
 */
export function startCommand({ server, credential, labels = [], isolation = null }: RunnerStartCommand): string {
  const parts = ["./node_modules/.bin/runner-agent", "pool", "--server", trimSlash(server)];
  if (labels.length) parts.push("--labels", labels.join(","));
  if (isolation) parts.push("--isolation", isolation);
  return `PLAYTEST_RUNNER_CREDENTIAL='${credential}' ${parts.join(" ")}`;
}

const trimSlash = (url: string) => String(url || "").replace(/\/+$/, "");

/**
 * A value that can be read exactly once. The credential is minted once and
 * stored hashed — the server cannot show it again — so the console must not
 * either: a re-render, a reopened dialog or a back button gets null, and the
 * copy says to register again rather than pretending the secret is retrievable.
 */
export function oneShot<T>(value: T): { take: () => T | null; spent: () => boolean } {
  let held: T | null = value;
  return {
    take: () => {
      const out = held;
      held = null;
      return out;
    },
    spent: () => held === null,
  };
}

/** What a listed runner reads as. Never carries a credential: the list has none. */
export function runnerLabelsText(labels: string[] | null | undefined): string {
  return labels && labels.length ? labels.join(", ") : "any job in this project";
}
