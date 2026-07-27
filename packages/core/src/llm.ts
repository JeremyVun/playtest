// OpenAI chat-completions client.
// See docs/contracts/engine.md#gateway.
// All model calls go through a gateway speaking the OpenAI contract; the
// gateway config is part of the pinned agent.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
export type { FetchLike } from "./types.ts";

export interface TokenUsage {
  in: number;
  out: number;
  cache_read: number;
}

export interface RetryInfo {
  status: number | null;
  attempt: number;
  maxAttempts: number;
  waitMs: number;
}

export type RetryCallback = (info: RetryInfo) => void;

export interface ContentPart {
  type: string;
  text?: string;
  cache_control?: { type: string };
  image_url?: { url: string };
}

export interface ChatMessage {
  role: string;
  content: string | ContentPart[] | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface RawAttempt {
  attempt: number;
  finishReason: string | null;
  rawArguments: string | null;
}

export class LlmError extends Error {
  declare rawAttempts?: RawAttempt[];
}

// The env vars that supply a model API key, in resolution order.
const API_KEY_VARS = ["PLAYTEST_LLM_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"];

// Built-in enum → fully-qualified model defaults (the gateway-specific names).
// Shipped, never hardcoded in JS; users override per enum via PLAYTEST_<ENUM>_MODEL.
const here = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DEFAULTS = JSON.parse(readFileSync(path.join(here, "models.json"), "utf8")) as Record<string, string>; // SAFETY: models.json is a shipped string map

/**
 * The short model-tier enums this build ships (the keys of models.json), in
 * file order. For surfaces that offer a model choice (hosted settings, docs):
 * any OTHER string is still accepted everywhere a model is configured — it is
 * passed through as an already-qualified gateway name — so this list is
 * suggestions, never validation.
 */
export function modelTiers(): string[] {
  return Object.keys(MODEL_DEFAULTS);
}

/**
 * Resolve a configured model value to the name actually sent to the gateway.
 * A short enum (a key in models.json — "sonnet" / "haiku" / "opus" / "gpt5_4")
 * resolves to its fully-qualified name: PLAYTEST_<ENUM>_MODEL wins, else the
 * built-in models.json default. Any other value is assumed to be a
 * fully-qualified model name already and is passed through unchanged.
 */
export function resolveModel(model: string): string {
  if (!Object.prototype.hasOwnProperty.call(MODEL_DEFAULTS, model)) return model;
  return process.env[`PLAYTEST_${model.toUpperCase()}_MODEL`] || MODEL_DEFAULTS[model] as string;
}

/**
 * A short, human display label for a configured model value — the inverse of
 * resolveModel, for surfaces that show "which model" (the live run line). A
 * known enum ("opus") is shown as-is; a fully-qualified name that happens to be
 * a built-in default is collapsed back to its enum; any other fully-qualified
 * name keeps only the part after the gateway routing prefix
 * (`@bedrock-eus2/us.anthropic.claude-opus-4-8` → `us.anthropic.claude-opus-4-8`).
 */
export function shortModel(model: string): string {
  if (!model) return model;
  if (Object.prototype.hasOwnProperty.call(MODEL_DEFAULTS, model)) return model;
  for (const [alias, full] of Object.entries(MODEL_DEFAULTS)) if (full === model) return alias;
  const slash = model.startsWith("@") ? model.indexOf("/") : -1;
  return slash >= 0 ? model.slice(slash + 1) : model;
}

export function llmConfig(): { baseUrl: string; apiKey: string | null; available: boolean; cache: boolean } {
  const baseUrlOverride = process.env.PLAYTEST_LLM_BASE_URL || null;
  // No default endpoint: a run is only available with an explicit base URL
  // (see below), so there is no fallback origin to compute here. Productionised
  // Playtest always points at an OpenAI-compatible gateway — never Anthropic direct.
  const baseUrl = (baseUrlOverride || "").replace(/\/+$/, "");
  const apiKey = API_KEY_VARS.map((v) => process.env[v]).find(Boolean) || null;
  // A model is "available" only when the gateway is fully specified. An explicit
  // base URL alone is fine (a keyless mock/gateway — this is the offline test
  // path), but a key WITHOUT an explicit base URL is NOT: there is no default
  // endpoint, so the gateway would be unspecified and a key alone is useless. So
  // once a key is set, an explicit PLAYTEST_LLM_BASE_URL is required too. See
  // missingLlmConfigMessage for the per-case guidance the CLI preflight prints.
  const available = Boolean(baseUrlOverride);
  // Prompt caching (default ON): only does anything through a gateway that maps
  // cache_control onto the native Messages API (Portkey, LiteLLM); a no-op elsewhere.
  // Opt OUT with PLAYTEST_LLM_CACHE=0/false/off/no — the offline self-tests do this to
  // keep their wire bytes byte-identical (see applyCacheControl).
  const cache = !/^(0|false|off|no)$/i.test(process.env.PLAYTEST_LLM_CACHE || "");
  return { baseUrl, apiKey, available, cache };
}

/**
 * A friendly, actionable message for when the model is not fully configured —
 * names exactly which of the two required pieces (base URL, API key) is missing
 * and reminds the user to reload their shell. Used by the CLI's early preflight
 * so a half-configured gateway fails fast here instead of surfacing as a cryptic
 * per-check 4xx from the gateway mid-run. Returns a multi-line string.
 */
export function missingLlmConfigMessage(): string {
  const { apiKey } = llmConfig();
  const hasBaseUrl = Boolean(process.env.PLAYTEST_LLM_BASE_URL);
  const missing = [];
  if (!hasBaseUrl) missing.push("PLAYTEST_LLM_BASE_URL=\"https://portkey.aipe.cba\"  (your OpenAI-compatible gateway base URL)");
  if (!apiKey) missing.push(`${API_KEY_VARS.join(" / ")}  (your gateway API key)`);
  const lead = missing.length === 2
    ? "no model configured — Playtest needs an LLM gateway to drive and grade the run."
    : "the LLM gateway is only half-configured — Playtest needs BOTH a base URL and an API key.";
  return [
    lead,
    "",
    `Missing: ${missing.map((m) => m.split("  ")[0]).join(" and ")}`,
    "",
    "Set the following in your environment, then reload your shell (e.g. open a new",
    "terminal, or `source` your profile) so the values are exported:",
    "",
    ...missing.map((m) => `  ${m}`),
  ].join("\n");
}

/**
 * Anthropic prompt caching expressed in the OpenAI request shape. A translating
 * gateway (Portkey, LiteLLM) maps a content-block `cache_control` marker onto the
 * native Messages API; Anthropic's own OpenAI-compat endpoint silently ignores it,
 * so this is a harmless no-op there.
 *
 * Marks a SINGLE message — at `breakpoint` — with a `cache_control` block. A cache
 * breakpoint caches the whole prefix up to and including that message, so one marker
 * on the last STABLE message caches everything before the volatile tail. One marker
 * (not one-per-message) is deliberate: Anthropic caps a request at 4 `cache_control`
 * blocks and returns a NON-retryable 400 above it — the grader / checkAssertion
 * tool-use loops append a message per fetch turn, so marking every prefix message
 * (the old behavior) blew past 4 after ~3 turns and killed the verdict. A fixed
 * breakpoint index also stays put as the loop appends, so the cached prefix is
 * stable turn to turn.
 *
 * Default `breakpoint = 1` = the first user message: for the grader/checkAssertion
 * that's the large stable trajectory digest (everything after it grows/volatile);
 * for a no-setup actor turn it's the "Steps so far" log. The actor passes
 * `messages.length - 2` explicitly so a run-setup message doesn't push the log out
 * of the cached prefix. String content becomes a one-element text block; a message
 * already in block form (a vision snapshot) or a non-string breakpoint is left
 * unmarked. Returns a new array; never mutates the input.
 * `breakpoint` is the index of the last stable message to cache through.
 */
export function applyCacheControl(messages: ChatMessage[], breakpoint = 1): ChatMessage[] {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const m = messages[breakpoint];
  if (breakpoint < 1 || breakpoint >= messages.length || !m || typeof m.content !== "string") return messages;
  return messages.map((msg, i) =>
    i === breakpoint
      ? { ...msg, content: [{ type: "text", text: msg.content as string, cache_control: { type: "ephemeral" } }] }
      : msg,
  );
}

// Abortable sleep: a long retry-after wait must yield to the run's deadline
// signal, otherwise a setTimeout would outlive a hard-timeout abort. Resolves on
// elapse OR on abort (the loop re-checks signal.aborted after waking), never rejects.
const sleep = (ms: number, signal: AbortSignal | null = null): Promise<void> =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      signal?.removeEventListener("abort", finish);
      clearTimeout(timer);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
  });

// Per-attempt cap so a stalled gateway cannot hang a case past its deadline or
// keep the process alive after the suite; a timed-out attempt is retryable.
// PLAYTEST_LLM_TIMEOUT_MS raises the cap for gateways whose single turn can
// legitimately run long (a grading call carries a whole trajectory).
const ATTEMPT_TIMEOUT_MS = 60000;
function attemptTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = Number(env.PLAYTEST_LLM_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : ATTEMPT_TIMEOUT_MS;
}
// The LLM POST goes over node:http(s), not fetch: Node's fetch (undici)
// enforces a 300s headersTimeout that no fetch option or AbortSignal can
// raise, so it silently clips PLAYTEST_LLM_TIMEOUT_MS above 300s — a busy
// gateway can queue a grading call past 300s before it sends response
// headers. Plain node:http has no such cap; the per-attempt deadline is
// enforced solely by `signal`. The returned shape mimics the slice of the
// fetch Response the retry loop uses (status/ok/headers.get/text/json).
interface PostJsonResponse {
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

function postJson(
  url: string,
  headers: Record<string, string | number>,
  payload: string,
  signal: AbortSignal
): Promise<PostJsonResponse> {
  return new Promise<PostJsonResponse>((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? https : http).request(u, { method: "POST", headers, signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode as number, // SAFETY: a completed Node client response always has an HTTP status
          ok: res.statusCode as number >= 200 && res.statusCode as number < 300, // SAFETY: a completed Node client response always has an HTTP status
          headers: { get: (name) => res.headers[String(name).toLowerCase()] as string | null ?? null }, // SAFETY: Retry-After is a singleton response header
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

// Retry budget: 5xx is transient-and-fast (3 tries), but a 429 is a rate-limit
// window that needs several real chances to clear under sustained saturation —
// honouring the gateway's retry-after between them (capped so a misbehaving
// gateway can't stall a run).
const MAX_ATTEMPTS_5XX = 3;
const MAX_ATTEMPTS_429 = 7;
const RETRY_AFTER_CAP_MS = 60000;

// 429 backoff base, doubling per retry: 1000ms * 2^(retry+1) where retry = attempt+1
// (1-indexed), so retry 1 → 4s, retry 2 → 8s, retry 3 → 16s, … capped at 60s.
// Many concurrent cases hitting the same rate-limit window would retry in
// lockstep on a fixed schedule (a thundering herd that re-trips the limit each
// wave), so the actual wait is FULL JITTER: a uniform random in [0, base]. This
// de-syncs the herd while keeping the expected wait at base/2. Jitter applies to
// the computed backoff only — a gateway-supplied Retry-After is a precise reset
// hint and is honoured exactly (just capped). 5xx keeps the old fast 500ms*2^n.
const jitter = (base: number): number => Math.floor(Math.random() * (base + 1));

/**
 * Parse an HTTP `Retry-After` header into milliseconds: either delta-seconds
 * ("120") or an HTTP-date (RFC 9110). Returns null when absent/unparseable so
 * the caller falls back to its own backoff. Negative/past values clamp to 0.
 */
export function parseRetryAfter(value: string | null): number | null {
  if (!value || !value.trim()) return null; // "" and whitespace-only are not a value
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - Date.now());
}

/**
 * cacheBreakpoint: index of the last stable message to mark for prompt caching
 * (default 1 = the first user message). The actor passes messages.length - 2 so
 * the volatile per-turn snapshot stays outside the cached prefix. See applyCacheControl.
 * onRetry: called just before each backoff sleep so a caller can surface
 * progress ("retry 2/5, retrying in 3s"); `status` is null for a network error.
 * `finishReason`/`rawArguments` expose the gateway's raw tool-call bytes so a
 *  caller can persist them when validation later rejects the parsed args.
 */
export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[] | null;
  toolChoice?: string | Record<string, unknown> | null;
  maxTokens?: number;
  signal?: AbortSignal | null;
  onRetry?: RetryCallback | null;
  cacheBreakpoint?: number;
}

export interface ChatResult {
  text: string;
  toolCall: ToolCall | null;
  usage: TokenUsage;
  finishReason: string | null;
  rawArguments: string | null;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: Array<{
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    input_tokens?: number;
    completion_tokens?: number;
    output_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_read_input_tokens?: number;
  };
}

export async function chat({
  model,
  messages,
  tools = null,
  toolChoice = null,
  maxTokens = 1024,
  signal = null,
  onRetry = null,
  cacheBreakpoint = 1
}: ChatOptions): Promise<ChatResult> {
  const { baseUrl, apiKey, available, cache } = llmConfig();
  if (!available) {
    throw new LlmError("no LLM configured: set PLAYTEST_LLM_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY) or PLAYTEST_LLM_BASE_URL");
  }

  const resolvedModel = resolveModel(model);
  // Azure OpenAI's GPT-5 family rejects `max_tokens` ("Unsupported parameter ...
  // Use `max_completion_tokens` instead"). Pick the token-limit key off the
  // resolved name so a gpt-5x gateway works while every other model keeps the
  // standard OpenAI `max_tokens`.
  const tokenLimitKey = /gpt-?5/i.test(resolvedModel) ? "max_completion_tokens" : "max_tokens";
  const body: Record<string, unknown> = {
    model: resolvedModel,
    messages: cache ? applyCacheControl(messages, cacheBreakpoint) : messages,
    [tokenLimitKey]: maxTokens
  };
  if (tools) body.tools = tools;
  if (toolChoice) {
    // "auto"/"none"/"required" are bare-string choices in the OpenAI contract;
    // any other string names a specific function to force.
    body.tool_choice = typeof toolChoice === "string"
      ? (["auto", "none", "required"].includes(toolChoice)
          ? toolChoice
          : { type: "function", function: { name: toolChoice } })
      : toolChoice;
  }
  const headers: Record<string, string | number> = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  // A retry sleep resolves early on abort (sleep honours the signal); re-check
  // here so we surface the abort explicitly instead of relying on the next fetch
  // to reject on the aborted signal (which it does, but the dependency is subtle).
  const throwIfAborted = () => {
    if (signal?.aborted) throw new LlmError(`LLM request aborted: ${signal.reason?.message ?? signal.reason ?? "aborted"}`);
  };

  const payload = JSON.stringify(body);
  headers["content-length"] = Buffer.byteLength(payload);

  let res;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted();
    const timeout = AbortSignal.timeout(attemptTimeoutMs());
    try {
      res = await postJson(`${baseUrl}/v1/chat/completions`, headers, payload,
        signal ? AbortSignal.any([signal, timeout]) : timeout);
    } catch (err: any) { // SAFETY: node:http rejects with Error instances
      throwIfAborted();
      if (attempt + 1 >= MAX_ATTEMPTS_5XX) throw new LlmError(`LLM request failed: ${err.message}`);
      const waitMs = 500 * 2 ** attempt;
      onRetry?.({ status: null, attempt: attempt + 1, maxAttempts: MAX_ATTEMPTS_5XX, waitMs });
      await sleep(waitMs, signal);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      const maxAttempts = res.status === 429 ? MAX_ATTEMPTS_429 : MAX_ATTEMPTS_5XX;
      if (attempt + 1 >= maxAttempts) throw new LlmError(`LLM request failed with status ${res.status} after ${attempt + 1} attempts`);
      // 429 backs off exponentially with full jitter (a uniform random in
      // [0, base] where base doubles with each attempt) to detach concurrent
      // clients that retry in lockstep. 5xx uses a fixed 500ms * 2 ** attempt
      // window. When the gateway sends Retry-After we honour the LARGER of
      // that and our own backoff so a slow upstream can ask us to wait longer,
      // but a bogus header can't stall us past RETRY_AFTER_CAP_MS.
      const backoff = res.status === 429 ? jitter(1000 * 2 ** (attempt + 2)) : 500 * 2 ** attempt;
      const retryAfter = res.status === 429 ? parseRetryAfter(res.headers.get("retry-after")) : null;
      const waitMs = Math.min(Math.max(retryAfter as number, backoff), RETRY_AFTER_CAP_MS); // SAFETY: Math.max preserves the existing null-to-zero coercion
      onRetry?.({ status: res.status, attempt: attempt + 1, maxAttempts, waitMs });
      await sleep(waitMs, signal);
      continue;
    }
    break;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new LlmError(`LLM request failed for model "${resolvedModel}": ${res.status} ${detail.slice(0, 500)}`);
  }
  let data: ChatCompletionResponse;
  try {
    data = await res.json() as ChatCompletionResponse; // SAFETY: the gateway response is narrowed by defensive optional reads below
  } catch (err: any) { // SAFETY: JSON parse failures are Error instances
    throw new LlmError(`LLM returned invalid JSON: ${err.message}`);
  }

  const choice = data.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  let toolCall = null;
  const tc = msg.tool_calls?.[0];
  if (tc) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.function.arguments) as Record<string, unknown>; // SAFETY: tool arguments are runtime-validated by each caller
    } catch (err: any) { // SAFETY: JSON parse failures are Error instances
      throw new LlmError(`tool call "${tc.function?.name}" has unparseable arguments: ${err.message}`);
    }
    toolCall = { name: tc.function.name, args };
  }
  const u = data.usage ?? {};
  return {
    text: typeof msg.content === "string" ? msg.content : "",
    toolCall,
    finishReason: choice.finish_reason ?? null,
    rawArguments: tc?.function?.arguments ?? null,
    usage: {
      // The OpenAI shape (our supported transport) is authoritative: prompt_tokens is
      // the TOTAL and cached_tokens a subset of it, so estimateCost's prompt_tokens is
      // fresh != cache_read is correct. The anthropic-native fallbacks
      // (input_tokens / cache_read_input_tokens) are defensive only and must not be
      // relied on together: native input_tokens EXCLUDES cache reads, so mixing the
      // pair would double-subtract the cached tokens. Unreachable on the documented
      // transports (the OpenAI-compat endpoint never populates cached_tokens; the
      // translating gateway emits prompt_tokens), so the mismatch can't fire today.
      in: u.prompt_tokens ?? u.input_tokens ?? 0,
      out: u.completion_tokens ?? u.output_tokens ?? 0,
      cache_read: u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0,
    },
  };
}

/**
 * Some gateways/models JSON-encode a nested object/array tool argument as a
 * STRING (e.g. args.action arrives as {"type":"type",...} instead of an
 * object), which then fails object-shaped schema validation. For each
 * TOP-LEVEL value that is a string parsing to an object or array, replace it
 * with the parsed value; plain strings, numbers, and existing objects are left
 * untouched. Returns a new object (never mutates the input).
 */
export function coerceStringifiedArgs(args: Record<string, unknown>): Record<string, unknown> {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === "object") {
            out[key] = parsed;
            continue;
          }
        } catch {
          // Not JSON — leave the genuine string field alone.
        }
      }
    }
    out[key] = value;
  }
  return out;
}

/**
 * chat() with a forced tool call whose arguments must pass `validate`; retried
 * once with the validation error attached. This closes the schema loop for the
 * actor and the grader without heavier schema-alignment machinery.
 * `validate` returns an error string, or null when the args are acceptable.
 *          `onRetry` is forwarded to chat() (transport 429/5xx backoff).
 *          `cacheBreakpoint` is forwarded to chat() (prompt-cache marker index).
 * `tokens` sums usage across attempts (a retry
 *          pays for a second full prompt); `retries` carries the validation
 *          error behind each extra attempt so callers can persist why.
 */
export interface ForcedToolCallOptions {
  model: string;
  messages: ChatMessage[];
  tool: ToolDefinition;
  validate?: (args: Record<string, unknown>) => string | null;
  maxTokens?: number;
  signal?: AbortSignal | null;
  onRetry?: RetryCallback | null;
  cacheBreakpoint?: number;
}

export async function forcedToolCall<T extends Record<string, unknown> = Record<string, unknown>>({
  model,
  messages,
  tool,
  validate = () => null,
  maxTokens = 1024,
  signal = null,
  onRetry = null,
  cacheBreakpoint = 1
}: ForcedToolCallOptions): Promise<{ args: T; tokens: TokenUsage; retries: string[] }> {
  const name = tool.function.name;
  const tokens = { in: 0, out: 0, cache_read: 0 };
  let lastError = "";
  // Raw gateway tool-call bytes per attempt, attached to the thrown LlmError so
  // a caller can persist them for offline root-causing (a stringified/garbled
  // argument is invisible once it has been JSON.parsed away).
  const rawAttempts = [];
  const retries = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) retries.push(lastError);
    const turnMessages = attempt === 0 ? messages : [...messages, {
      role: "user",
      content: `Your previous ${name} was invalid: ${lastError}\nCall the ${name} tool again with a corrected ${name}. Emit each array/object field as a real JSON array/object, never as a quoted string.`,
    }];
    // One tool only → `required` is equivalent to forcing that name, and some
    // providers (xAI Grok via CLIProxy) stream-die on tool_choice={function:name}
    // with vision (`xai stream error: stream disconnected`). `required` works.
    // We still validate the returned tool name below.
    const { toolCall, usage, finishReason, rawArguments } = await chat({ model, messages: turnMessages, tools: [tool], toolChoice: "required", maxTokens, signal, onRetry, cacheBreakpoint });
    tokens.in += usage.in;
    tokens.out += usage.out;
    tokens.cache_read += usage.cache_read;
    rawAttempts.push({ attempt, finishReason, rawArguments });
    if (!toolCall || toolCall.name !== name) {
      lastError = `expected a "${name}" tool call, got ${toolCall ? `"${toolCall.name}"` : "none"}`;
      continue;
    }
    lastError = validate(toolCall.args) as string; // SAFETY: null is deliberately assigned at runtime and handled by the following falsy check
    if (!lastError) return { args: toolCall.args as T, tokens, retries }; // SAFETY: caller validation establishes the requested argument shape
    // Some gateways stringify a nested object/array argument; if un-stringifying
    // the top-level values makes the args valid, use them without burning a retry.
    // No identity guard needed: when coerceStringifiedArgs changes nothing it returns
    // the same args, and validate() (deterministic) already failed on them at line
    // 392 — so validate(coerced) fails again and we fall through, same as before.
    const coerced = coerceStringifiedArgs(toolCall.args);
    if (!validate(coerced)) {
      return { args: coerced as T, tokens, retries }; // SAFETY: caller validation establishes the requested argument shape
    }
    continue;
  }
  const err = new LlmError(`${name} failed validation after retry: ${lastError}`);
  err.rawAttempts = rawAttempts;
  throw err;
}

// USD per million tokens, pinned with the harness. Keyed by
// the bare model-tier enum (the value pinned in manifests): pricing is the same
// across versions within a tier (sonnet-4-5 and sonnet-4-6 cost the same).
// Each tier matches its bare enum AND its fully-qualified wire form (models.json):
// the Anthropic names carry sonnet/haiku/opus verbatim, but the GPT wire names are
// hyphenated (`gpt-54-mini`) and share no substring with the underscore enum
// (`gpt5_4_mini`) — so a user who configures actor_model as a qualified GPT name
// (the documented pass-through) would otherwise price at $0. Aliases keep both
// forms billed. Order matters: the mini tier precedes gpt5_4/gpt-54 because those
// are substrings of the mini forms.
const PRICING = [
  { match: ["haiku"], in: 1, out: 5, cacheRead: 0.1 },
  { match: ["sonnet"], in: 3, out: 15, cacheRead: 0.3 },
  { match: ["opus"], in: 5, out: 25, cacheRead: 0.5 },
  { match: ["gpt5_6_terra", "gpt-5.6-terra", "gpt-56-terra"], in: 2.5, out: 15, cacheRead: 0.25 },
  { match: ["gpt5_5", "gpt-55"], in: 5, out: 30, cacheRead: 0.5 },
  { match: ["gpt5_4_mini", "gpt-54-mini"], in: 0.75, out: 4.50, cacheRead: 0.075 },
  { match: ["gpt5_4", "gpt-54"], in: 2.5, out: 15, cacheRead: 0.25 },
];

/** USD; unknown models cost 0. */
export function estimateCost(model: string, usage: Partial<TokenUsage> | null | undefined): number {
  const m = String(model);
  const price = PRICING.find((p) => p.match.some((s) => m.includes(s)));
  if (!price || !usage) return 0;
  const cached = usage.cache_read ?? 0;
  const fresh = Math.max(0, (usage.in ?? 0) - cached);
  return (fresh * price.in + cached * price.cacheRead + (usage.out ?? 0) * price.out) / 1e6;
}
