# Brief: write a functional test suite for the minibank ledger API

You are testing an HTTP API you have never seen the source of. Your job is to
write a test suite that tries to prove six stated business rules wrong.

## What you are given, and nothing else

- `handout/openapi.json` — the service's OpenAPI 3.1 document (also served live
  at `GET /openapi.json`).
- `handout/INVARIANTS.md` — six invariant statements: the rule, where it
  applies, and its declared exceptions.
- A live instance to develop against: **http://127.0.0.1:4181**
- Credentials (static, throwaway, published defaults of a disposable local
  fixture): `Authorization: Bearer customer-token-dev` for the ordinary
  surface, `Authorization: Bearer admin-token-dev` for `/admin/*`.

## Hard rules

1. **Do not read, list, search, or open any file outside
   `/tmp/comparator-agent-suite/`.** The service's source code, its tests, and
   the study that commissioned this suite all live in a repository you must not
   look at. Reading it invalidates the measurement this suite is part of. If you
   are ever unsure whether a path is in bounds, it is not.
2. Do not search the web.
3. You may send as much traffic as you like to 127.0.0.1:4181 while developing.

## What to build

`suite/` — a Node.js 20+ ESM test suite, **zero external dependencies**
(`node:test`, `node:assert`, and global `fetch` only). Entry point
`suite/run.mjs`, runnable as:

```sh
BASE_URL=http://127.0.0.1:4191 node suite/run.mjs
```

Requirements:

- `BASE_URL` comes from the environment and defaults to
  `http://127.0.0.1:4181`. **Every** HTTP request must go through it — no
  hardcoded host or port anywhere.
- Start by resetting the service to a known state:
  `POST /admin/reset` with body `{"seed":"ledger-dev-seed"}` and the admin
  token. The service is deterministic under a seed; identifiers are a pure
  function of it.
- Budget: aim to finish in **under 360 HTTP requests** for a whole execution.
  Print the total request count at the end. Going slightly over is recorded,
  not fatal — but do not spend 3000 requests.
- Exit code 0 when every rule held, non-zero when any rule was broken.
- On a violation, print the evidence a human needs to reproduce it: the
  requests you sent in order, the responses you got back, and which rule
  broke. Terse and factual.
- The suite runs unattended against builds of this service you have never
  seen, some of which contain deliberate defects. Write it so a failure is
  informative and so a *pass* means something: prefer tests that reach real
  state (create, activate, fund, transfer, settle, close, paginate) over tests
  that only check the shape of an error.
- It must be robust to a service that misbehaves: a 500, a malformed body, a
  missing field, a hang. Never crash with an unhandled exception where a clear
  failure report would do; use timeouts on every request.
- No test may depend on a previous test having run, beyond the single reset at
  the start. Keep the ordering deterministic.

Deep coverage of the six rules is the goal. Read the OpenAPI document
carefully — settlement, fees, idempotency, cursors, closure semantics, and the
error envelope are all described there, and the rules' declared exceptions
matter as much as the rules.

## Also write

`TRANSCRIPT.md` — a short authoring record: what you understood each rule to
mean, what sequences you chose to exercise it and why, what you tried that did
not work, roughly how long it took, and anything about the API that surprised
you. This is study evidence and gets published; write it for a reader who
wants to know how hard this was and how you thought about it, not to impress.

State explicitly in `TRANSCRIPT.md` whether you read anything outside
`/tmp/comparator-agent-suite/`.

## Done means

`BASE_URL=http://127.0.0.1:4181 node suite/run.mjs` runs clean against the
instance you were given (exit 0, no rule broken, request count printed), and
`TRANSCRIPT.md` exists. Report the request count and the runtime.
