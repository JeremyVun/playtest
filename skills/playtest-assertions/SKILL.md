---
name: playtest-assertions
description: Author a Playtest custom assertion — a small JS module that lets a journey assert on an EXTERNAL side effect the harness can't see (a Kafka event fired, an outbox row written, a file landed in a bucket, a job enqueued). Use when a story's success depends on something off the UI/network surface, and the built-in success kinds (element_exists, api_called, response_matches, assert, …) can't reach it.
---

# Playtest custom assertions

A custom assertion adds a `success:` key, owned by your code, so a journey can
gate on an external side effect the harness never observes — the UI says "come
back later", the assertion proves the Kafka event actually fired.

Reach for one ONLY when no built-in fits. First ask if the truth is already on a
captured surface: a network signal → `api_called` / `response_matches`;
text/DOM/URL → `element_exists` / `url_matches` / `assert`. A custom assertion
is for the genuinely off-surface signal.

## Where an assertion lives

A folder under the suite root's `assertions/` dir, each with an `assertion.js`
ESM module (plus its own `node_modules` for any client library it needs):

```
my-suite/
  playtest.yaml
  assertions/
    kafka-events/
      assertion.js
      node_modules/          # the assertion's own deps (e.g. kafkajs)
  stories/
    place-order.yaml
```

Discovery is by convention — drop the folder in and the assertion's keys become
usable. No config entry in any YAML.

## The three-function contract

`assertion.js` default-exports an object with three functions:

```js
export default {
  // 1. Multiple keys allowed — but a key must not clash with a built-in kind or
  //    another assertion's key: a clash is a config error and the run never starts.
  keys() {
    return ["kafka_event_fired", "kafka_event_absent"];
  },

  // 2. CAPTURE — async, runs ONCE, after the actor finishes, before the gate.
  //    Do ALL your I/O here. Return small JSON-serializable evidence so it can
  //    be persisted; it is the only thing verdict() is handed.
  async gather(ctx) {
    const events = await drainTopic(ctx.env.KAFKA_TOPIC, { since: ctx.startedAt });
    return { count: events.length, keys: events.map((e) => e.key) };
  },

  // 3. VERDICT — judges ONE success entry. MUST be synchronous (the gate does
  //    not await it — an async verdict fails as a malformed result). `key` = which
  //    of your keys fired, `value` = the scalar spec value the author wrote
  //    (string | number | boolean), `evidence` = exactly what gather() returned.
  //    Return { pass, detail }.
  verdict({ key, value, evidence }) {
    if (key === "kafka_event_absent") {
      const pass = evidence.count === 0;
      return { pass, detail: pass ? "no events, as expected" : `saw ${evidence.count}` };
    }
    const want = Number((value.match(/count ≥ (\d+)/) ?? [])[1] ?? 1);
    const pass = evidence.count >= want;
    return { pass, detail: pass ? `${evidence.count} event(s)` : `expected ≥ ${want}, saw ${evidence.count}` };
  },
};
```

### The `gather` context (`ctx`)

A read-only snapshot of the finished run:

- `ctx.runId` / `ctx.runDir` — identifiers (`runDir` for logging only; return
  evidence from `gather`, don't write it there).
- `ctx.startedAt` — a `Date` for the run start, for "events since the run
  began" windows.
- `ctx.baseUrl` / `ctx.driver` — the driver kind (`web` / `mobile` / `api`),
  never hardcode.
- `ctx.env` — `process.env` plus `BASE_URL` and `RUN_ID` (read
  `KAFKA_BROKER` etc from here, never hardcode).
- `ctx.trajectory` — the step envelopes, to correlate a signal with a step
  (a mid-run traceId).

Unlike a hook's ctx, there is no `suiteName` / `storyId` / `caseId` here — an
assertion judges evidence, it doesn't key entities on case identity.

When `gather` runs: once per run, and only for an assertion whose keys actually
appear in this case's `success:` list — one evidence object can serve several
keys. On a clean `act` replay it may not run at all: if every key the assertion
owns is inherited (see below), the gate reuses the saved verdicts and skips
`gather`. That's the usual answer to "why didn't `gather` run?".

## Using the key in a story

A custom assertion key looks like a built-in in `success:` — same list, same
one-key-per-entry shape. Its value may be a string, number, or boolean; the
harness passes it through verbatim. This scalar flexibility applies only to
custom keys: the built-in model-graded `assert:` remains a natural-language
string.

```yaml
# stories/place-order.yaml
success:
  - element_exists: "[data-testid=order-confirmation]"   # built-in
  - kafka_event_fired: "topic=orders count≥1"            # your assertion key
  - console_errors: 0
```

## Authoring rules (the three that matter)

1. **Keep `gather` for I/O; keep `verdict` pure over its evidence argument.**
   This one rule earns reproducibility: JSON-serializable evidence is written
   onto the final trajectory envelope and rides into the baseline. Persistence
   is best-effort; the gate still receives the in-memory value if the final-line
   rewrite fails.
2. **A custom assertion is a HARD gate check.** Like every success kind except
   `console_errors` / perf, it gates the exit code AND baseline acceptance.
   There is no soft custom assertion: if the side effect didn't happen, the
   journey is red.
3. **For a signal that only exists at judgment time, set `inheritable: false`**
   — don't reach for live I/O in `verdict`. Assertions default to
   `inheritable: true`, so a clean `act` replay reuses the saved verdict and
   skips `gather` / `verdict` — a TTL'd row or ephemeral event would then be
   judged from stale evidence. The optional top-level `inheritable: false`
   forces a fresh `gather` + `verdict` on every replay (rule 1 still holds:
   `gather` for I/O, `verdict` pure):

```js
export default {
  inheritable: false, // re-observe every replay, never inherit
  keys() { return ["row_present_now"]; },
  async gather(ctx) { /* … */ },
  verdict({ evidence }) { /* … */ },
};
```

## How it behaves at the rails (so you can debug)

- **Capture failure is infra.** If `gather` throws (broker unreachable, etc.)
  the run ends with the infra exit code (2) and the gate never runs — a
  precondition problem, not a test failure. Fix the environment, not app code.
- **Verdict failure is a red journey.** If `verdict` returns `{pass: false}` —
  or throws, or returns a malformed result — that's a failed check, exit code 1.
  The `detail` you return is the failure output: make it say expected vs seen.
- **A key clash never starts the run.** Registering a key that a built-in or
  another assertion already owns is a config error naming both owners — caught
  before any case runs.
- **A typo'd key in a story is a named config error** ("unknown key …"), never a
  silent no-op. If your assertion seems ignored, the key in the YAML doesn't
  match what `keys()` returns, or the folder isn't under the suite's
  `assertions/`.

## When NOT to write a custom assertion

- The signal is already on a captured surface (network / page / screen / URL) →
  use the matching built-in, per the test at the top.
- You only need to **set up** state, not assert on it → that's a `before_each`
  hook (the playtest-hooks skill). An assertion gathers evidence about what
  happened during the run; a hook causes a precondition before it.
