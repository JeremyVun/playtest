// Loaded with `node --import` for every test tier. Tests may talk to local
// fixture servers, but never inherit model credentials or reach the public
// network. NODE_OPTIONS carries the same guard into CLI child processes.
const MODEL_ENV = [
  "PLAYTEST_LLM_BASE_URL",
  "PLAYTEST_LLM_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
];

declare global {
  var __playtestHermeticFetch: true | undefined;
}

const inheritedGuard = process.env.PLAYTEST_TEST_HERMETIC === "1";
if (!inheritedGuard) {
  for (const key of MODEL_ENV) delete process.env[key];
}
process.env.PLAYTEST_TEST_HERMETIC = "1";

const self = new URL(import.meta.url).pathname;
const importArg = `--import=${self}`;
if (!(process.env.NODE_OPTIONS || "").includes(importArg)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, importArg].filter(Boolean).join(" ");
}

if (!globalThis.__playtestHermeticFetch) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function hermeticFetch(input: string | URL | Request, init?: RequestInit) {
    const raw = typeof input === "string" || input instanceof URL ? input : input?.url;
    const url = new URL(String(raw));
    if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
      throw new Error(`hermetic test blocked external request: ${url.origin}`);
    }
    return realFetch(input, init);
  };
  globalThis.__playtestHermeticFetch = true;
}
