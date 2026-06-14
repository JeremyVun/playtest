# Prompt caching through a translating gateway

**Status:** implemented in the working tree (2026-06-14) — `src/harness/llm.js`,
`test/llm-cache.test.js`, `docs/CONTRACTS.md §5`. This doc is the spec + handoff: if
you are starting from a clean tree, apply the diffs in §3; if the changes are already
present, use §4–§6 to configure and verify. Self-contained — you don't need the
originating conversation.

---

## 1. Problem

The Anthropic dashboard reports "You're not using prompt caching." Two facts explain it:

1. **All model calls go through `src/harness/llm.js`**, which speaks the **OpenAI
   chat-completions contract** (`POST {baseUrl}/chat/completions`) and never sent a
   `cache_control` marker. `actor.js`/`grader.js` only assemble messages and delegate
   to `chat()` / `forcedToolCall()` there — caching is a transport concern, decided in
   `llm.js`.
2. The default `baseUrl` is `https://api.anthropic.com/v1` — **Anthropic's own
   OpenAI-compat endpoint, which does not support prompt caching at all** (it silently
   ignores `cache_control`; `usage.prompt_tokens_details` is always empty). See
   <https://platform.claude.com/docs/en/api/openai-sdk>.

The prompts are *already* shaped for caching (byte-stable system prefix + append-only
history, see `actor.js`), and `estimateCost` already discounts `cache_read` — only the
marker and a cache-capable transport were missing.

## 2. Approach (and rejected alternatives)

**Chosen:** keep the OpenAI contract and plain `fetch`; add `cache_control` blocks to
the request, gated on an **opt-in flag, default off**. In production the gateway is
**Portkey** (or LiteLLM), not Anthropic direct — and a *translating* gateway **does**
support Anthropic caching: it maps content-block `cache_control` onto the native
Messages API. So caching is achievable with no transport rewrite. Default-off keeps the
offline-mock / web-golden path byte-identical (no `prompts_version` churn).

**Rejected — do not re-litigate:**
- *Switch `llm.js` to the native Anthropic Messages API.* Bigger contract change
  (restructures the envelope: `system` becomes a top-level param), breaks the
  single-OpenAI-contract design (`CONTRACTS.md §5`) and the golden-bytes pin, and is
  unnecessary because the gateway already translates.
- *Pull in the Portkey SDK or the OpenAI Node SDK.* Adds a dependency to a no-build /
  minimal-dep repo, and doesn't reduce user config or solve any header question (both
  SDKs still put the key on `Authorization: Bearer`, same as the current code).
- *Infer the provider from the base URL, or blindly add `x-portkey-api-key`.*
  Unnecessary: Portkey accepts its key on `Authorization: Bearer` (confirmed working),
  and provider selection rides in the model slug (§4). Blind-adding `x-portkey-api-key`
  while keeping `Authorization` is actively unsafe — Portkey reads `Authorization` as
  the *upstream provider* key and can forward the Portkey key to Anthropic → 401.

## 3. Code change (the only code to implement)

All edits are in `src/harness/llm.js`.

**3a.** In `llmConfig()`, add a `cache` flag and return it:

```js
  // Mock servers need no key: any explicit base URL override counts as available.
  const available = Boolean(apiKey || baseUrlOverride);
  // Opt-in prompt caching (default off): only does anything through a gateway that
  // maps cache_control onto the native Messages API (Portkey, LiteLLM); off keeps the
  // offline/mock wire bytes identical. See applyCacheControl.
  const cache = /^(1|true|on|yes)$/i.test(process.env.PLAYTEST_LLM_CACHE || "");
  return { baseUrl, apiKey, available, cache };
```

**3b.** Add the exported transform (place it next to `llmConfig`):

```js
/**
 * Anthropic prompt caching expressed in the OpenAI request shape. A translating
 * gateway (Portkey, LiteLLM) maps a content-block `cache_control` marker onto the
 * native Messages API; Anthropic's own OpenAI-compat endpoint silently ignores it,
 * so this is a harmless no-op there. Marks every message BEFORE the volatile final
 * one (the per-turn snapshot / trajectory / claim) so the stable, append-only prefix
 * — tools + system + prior-step log — is cached and only the last message is fresh.
 * String content becomes a one-element text block; content already in block form (a
 * vision snapshot) is left untouched. Returns a new array; never mutates the input.
 * @param {object[]} messages
 * @returns {object[]}
 */
export function applyCacheControl(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const last = messages.length - 1;
  return messages.map((m, i) => {
    if (i === last || typeof m.content !== "string") return m;
    return { ...m, content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] };
  });
}
```

**3c.** In `chat()`, destructure `cache` and apply the transform when building the body:

```js
  const { baseUrl, apiKey, available, cache } = llmConfig();
  ...
  const body = { model, messages: cache ? applyCacheControl(messages) : messages, max_tokens: maxTokens };
```

**Why "all messages except the last":** for every caller the final message is the
volatile one — the actor's page snapshot, the grader's trajectory, the assertion
checker's claim — and everything before it is stable or append-only. Marking those
caches the whole `tools + system + log` prefix (≤ 2 breakpoints in practice; Anthropic
allows 4). The append-only history means each step's cached prefix is a byte-prefix of
the next, so reads accrue incrementally. (A non-vision actor step that fails schema
validation and retries appends one user message via `forcedToolCall`, pushing the
snapshot off the final slot → 3 breakpoints that turn — still under 4.)

**Document it in `docs/CONTRACTS.md §5`** (the live spec): add `cache: bool` to the
`llmConfig()` return, document `applyCacheControl`, and note that `chat()` runs messages
through it when `cache` is on. Contract changes must be recorded there.

## 4. Configuration (no code — for the operator)

Production routes through Portkey using the **model-catalog** flow (single key, provider
in the model slug):

```
PLAYTEST_LLM_BASE_URL=https://api.portkey.ai/v1     # the /v1 matters — llm.js appends /chat/completions
PLAYTEST_LLM_API_KEY=<portkey key>                  # sent as Authorization: Bearer (Portkey compat fallback)
PLAYTEST_LLM_CACHE=1                                # turn caching on
```

…and in the pinned case/`defaults` config, set the models to catalog slugs:

```yaml
actor_model:  "@anthropic/claude-opus-4-8"
grader_model: "@anthropic/claude-opus-4-8"
```

The slug satisfies `estimateCost`'s pricing match (`String(model).includes("opus-4-8")`),
so cost accounting keeps working. LiteLLM works the same way (OpenAI-shaped, key on
`Authorization`); only the base URL and model naming differ.

## 5. Tests & invariants

- Add `test/llm-cache.test.js` (already present): unit-tests `applyCacheControl`
  (incl. vision-array passthrough and no-mutation) plus an integration test that drives
  `chat()` against the in-process mock and asserts the captured request body carries
  `cache_control` **only** when `PLAYTEST_LLM_CACHE` is set.
- **`npm test` is the gate** (`node --test test/*.test.js`): must stay green and
  **0 skipped**.
- **The default path must remain byte-identical.** With caching off (the default, and
  what the whole suite runs under), the request body is unchanged. The guard is the
  existing test *"a journey run sends no image blocks and its prompts are unchanged"* —
  it must stay green. This is why the flag defaults off: the offline mock is an HTTP
  server that requests flow through, so an unconditional shape change would move the
  golden bytes.
- The mock (`src/harness/testing/mock-llm.js`) already flattens content-block arrays via
  `contentText()` (built for vision), so it parses the `cache_control` shape with no
  change.

## 6. Verifying caching is live (against a real gateway)

1. Set the §4 env and run a real **multi-step** actor case.
2. Watch `usage.prompt_tokens_details.cached_tokens` (Portkey's OpenAI-normalized
   cache-read field; `llm.js` reads it at the `cache_read` line): **0 on step 1** (the
   cache *write*), **non-zero from step 2 onward** (reads), within the 5-minute TTL.
3. **Gotcha — per-model minimums:** the stable prefix must clear the model's minimum
   cacheable size or `cached_tokens` silently stays 0 (no error, just no caching).
   **Opus 4.8 and Haiku 4.5 both need 4096 tokens**; **Sonnet 4.6 needs 2048**; only the
   Sonnet 4.5 family caches from 1024. Switching the actor to Opus does **not** lower the
   bar — Opus 4.8 shares Haiku 4.5's 4096 floor — so a compact actor prefix (system + an
   early, short log) can read cold on either. Sonnet 4.6 (2048) is the lowest-threshold
   catalog model; verify there, or confirm the prefix clears the configured model's
   minimum, before concluding caching is broken.

## 7. Optional follow-ups (not required)

- **Cache-write premium:** `estimateCost` bills the first-turn cache-creation tokens at
  1× input rather than 1.25× (Portkey folds them into `prompt_tokens`; only the read
  count is exposed via `cached_tokens`). Minor first-turn under-count; refine only if
  cost precision matters.
- **Pin the flag in config instead of env:** if caching should be a property of the
  pinned suite rather than an env var, move it into `defaults.schema.json` /
  `case.schema.json` (a schema + pins bump, recorded in `CONTRACTS.md`).
