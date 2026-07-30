// Codex-gateway chat client for arm C (control agent). Completion-only (the
// gateway does not stream), 300 s server deadline, concurrency 2 — the study
// runs one call at a time. Every call's token usage is returned so the driver
// can log it into the transcript; dollars are priced-equivalents computed at
// report time from the PREREG-pinned table.

const GATEWAY = process.env.STUDY_GATEWAY_URL || "http://127.0.0.1:8900";
const MODEL = process.env.STUDY_CONTROL_MODEL || "claude-gpt-5.5";

export async function chat(messages, { tools, toolChoice, maxTokens = 8000, retries = 2 } = {}) {
  const body = {
    model: MODEL,
    messages,
    max_tokens: maxTokens,
    ...(tools ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
  };
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer subscription" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(305_000),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`gateway ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      const choice = data.choices?.[0];
      if (!choice) throw new Error(`gateway returned no choices: ${JSON.stringify(data).slice(0, 300)}`);
      return { message: choice.message, finishReason: choice.finish_reason, usage: data.usage ?? null, model: data.model };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 10_000 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export const controlModel = MODEL;
