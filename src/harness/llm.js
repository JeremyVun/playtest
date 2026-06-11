// OpenAI chat-completions client over fetch (CONTRACTS.md §5).
// All model calls go through a gateway speaking the OpenAI contract; the
// gateway config is part of the pinned agent.

export class LlmError extends Error {}

export function llmConfig() {
  // PLAYTEST_* are the documented names; DUMMY_* remain as deprecated fallbacks.
  const baseUrlOverride = process.env.PLAYTEST_LLM_BASE_URL || process.env.DUMMY_LLM_BASE_URL || null;
  const baseUrl = (baseUrlOverride || "https://api.anthropic.com/v1").replace(/\/+$/, "");
  const apiKey =
    process.env.PLAYTEST_LLM_API_KEY ||
    process.env.DUMMY_LLM_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.OPENAI_API_KEY ||
    null;
  // Mock servers need no key: any explicit base URL override counts as available.
  const available = Boolean(apiKey || baseUrlOverride);
  return { baseUrl, apiKey, available };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Per-attempt cap so a stalled gateway cannot hang a case past its deadline or
// keep the process alive after the suite; a timed-out attempt is retryable.
const ATTEMPT_TIMEOUT_MS = 60000;

/**
 * @param {{ model: string, messages: object[], tools?: object[]|null,
 *           toolChoice?: string|object|null, maxTokens?: number,
 *           signal?: AbortSignal|null }} opts
 * @returns {Promise<{ text: string, toolCall: {name: string, args: object}|null,
 *                     usage: {in: number, out: number, cache_read: number} }>}
 */
export async function chat({ model, messages, tools = null, toolChoice = null, maxTokens = 1024, signal = null }) {
  const { baseUrl, apiKey, available } = llmConfig();
  if (!available) {
    throw new LlmError("no LLM configured: set PLAYTEST_LLM_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY) or PLAYTEST_LLM_BASE_URL");
  }

  const body = { model, messages, max_tokens: maxTokens };
  if (tools) body.tools = tools;
  if (toolChoice) {
    body.tool_choice = typeof toolChoice === "string"
      ? { type: "function", function: { name: toolChoice } }
      : toolChoice;
  }
  const headers = { "content-type": "application/json" };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  let res;
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS);
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw new LlmError(`LLM request aborted: ${signal.reason?.message ?? signal.reason ?? "aborted"}`);
      }
      if (attempt >= 2) throw new LlmError(`LLM request failed: ${err.message}`);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 2) throw new LlmError(`LLM request failed with status ${res.status} after ${attempt + 1} attempts`);
      await sleep(500 * 2 ** attempt);
      continue;
    }
    break;
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new LlmError(`LLM request failed: ${res.status} ${detail.slice(0, 500)}`);
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new LlmError(`LLM returned invalid JSON: ${err.message}`);
  }

  const msg = data.choices?.[0]?.message ?? {};
  let toolCall = null;
  const tc = msg.tool_calls?.[0];
  if (tc) {
    let args;
    try {
      args = JSON.parse(tc.function.arguments);
    } catch (err) {
      throw new LlmError(`tool call "${tc.function?.name}" has unparseable arguments: ${err.message}`);
    }
    toolCall = { name: tc.function.name, args };
  }
  const u = data.usage ?? {};
  return {
    text: typeof msg.content === "string" ? msg.content : "",
    toolCall,
    usage: {
      in: u.prompt_tokens ?? u.input_tokens ?? 0,
      out: u.completion_tokens ?? u.output_tokens ?? 0,
      cache_read: u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0,
    },
  };
}

/**
 * chat() with a forced tool call whose arguments must pass `validate`; retried
 * once with the validation error attached. This closes the schema loop for the
 * actor and the grader without heavier schema-alignment machinery.
 * @param {{ model: string, messages: object[], tool: object,
 *           validate?: (args: object) => string|null, maxTokens?: number,
 *           signal?: AbortSignal|null }} opts `validate` returns an error
 *           string, or null when the args are acceptable.
 * @returns {Promise<{ args: object, tokens: {in: number, out: number, cache_read: number} }>}
 */
export async function forcedToolCall({ model, messages, tool, validate = () => null, maxTokens = 1024, signal = null }) {
  const name = tool.function.name;
  const tokens = { in: 0, out: 0, cache_read: 0 };
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const turnMessages = attempt === 0 ? messages : [...messages, {
      role: "user",
      content: `Your previous ${name} was invalid: ${lastError}\nCall the ${name} tool again with a corrected ${name}.`,
    }];
    const { toolCall, usage } = await chat({ model, messages: turnMessages, tools: [tool], toolChoice: name, maxTokens, signal });
    tokens.in += usage.in;
    tokens.out += usage.out;
    tokens.cache_read += usage.cache_read;
    if (!toolCall || toolCall.name !== name) {
      lastError = `expected a "${name}" tool call, got ${toolCall ? `"${toolCall.name}"` : "none"}`;
      continue;
    }
    lastError = validate(toolCall.args);
    if (lastError) continue;
    return { args: toolCall.args, tokens };
  }
  throw new LlmError(`${name} failed validation after retry: ${lastError}`);
}

// USD per million tokens, pinned with the harness (CONTRACTS.md §5).
const PRICING = [
  { match: "haiku-4-5", in: 1, out: 5, cacheRead: 0.1 },
  { match: "sonnet-4-6", in: 3, out: 15, cacheRead: 0.3 },
];

/** @returns {number} USD; unknown models cost 0. */
export function estimateCost(model, usage) {
  const price = PRICING.find((p) => String(model).includes(p.match));
  if (!price || !usage) return 0;
  const cached = usage.cache_read ?? 0;
  const fresh = Math.max(0, (usage.in ?? 0) - cached);
  return (fresh * price.in + cached * price.cacheRead + (usage.out ?? 0) * price.out) / 1e6;
}
