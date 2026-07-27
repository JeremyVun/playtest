---
name: playtest-hooks
description: Author a Playtest before_each lifecycle hook — JS that runs before every run of a suite to converge the world state the run presumes (seed a user, reset a tenant, put an account in arrears). Use when the precondition can only be set by side-effecting code (a backend SDK, queue, or API the harness can't drive), not by a URL/cookie/storage_state at launch.
---

# Playtest `before_each` hooks

A hook runs once before every run to establish a precondition. It is the
pre-actor mirror of a custom assertion (the playtest-assertions skill): an
assertion runs after the actor to *observe* a side effect; a hook runs before it
to *cause* one. Hooks are trusted (your code, harness privileges, not sandboxed)
and discovered by convention — no YAML, no schema.

Use a hook ONLY when the state can't be set at launch. Confirm with the user
that it can't, and prefer these when they fit:

- `app.storage_state` — a pre-authenticated session.
- `app.cookies` — a flag or toggle.
- `app.init` — a global reset script.

## The file (by convention)

```
my-suite/
  playtest.yaml
  hooks/before_each.js     # default-exports a function (sync or async)
```

`hooks/before_each.js` at the suite root (the nearest ancestor with a
`playtest.yaml`) runs for every case under it, every run. No file ⇒ the suite
behaves exactly as if hooks didn't exist.

## Contract

Default-export a function taking `ctx`. The harness awaits its return value, so
make it async when you do I/O (you will). Optionally return a short string the
actor will see:

```js
// hooks/before_each.js — trusted, author-owned, NOT sandboxed
import { ensureUserInState } from "./client.js"; // your own dep

export default async function beforeEach(ctx) {
  // Compose your OWN handle — the harness mints none.
  // Stable handle = entity reused across runs; runId handle = fresh every run.
  const handle = `acme_user_${ctx.suiteName}_${ctx.storyId}`;
  // MUST be idempotent: it may run against the previous run's end-state.
  // Write "check, then create-or-move" — never a bare "create".
  await ensureUserInState(handle, "loan_in_arrears", { baseUrl: ctx.baseUrl });
  // Optional: a fact the actor can't discover. Return nothing to stay invisible.
  return `Test user ${handle} (password "hunter2"), signed up, loan in arrears.`;
}
```

### `ctx` fields

| Field | What it is |
|---|---|
| `runId` | Unique per run. Key a handle on it ⇒ fresh entity every run (never contends; accumulates). |
| `runDir` | For logging only — don't write setup state here. |
| `startedAt` | `Date`, run start. |
| `baseUrl` | Resolved base URL (post compose/env). Reach the app via this, never a hardcoded host. |
| `driver` | `"web"` \| `"mobile"` \| `"api"`. |
| `env` | `{ ...process.env, BASE_URL, RUN_ID }`. Read backend creds from here, never hardcode. |
| `suiteName` | Suite root basename. |
| `storyId` | Persona-independent base id. Key on it ⇒ one shared entity per discovery study. |
| `caseId` | Fanned-out id (`base@persona`; same as `storyId` for a journey). Key on it ⇒ one entity per persona. |

## Return value

- Return **nothing** ⇒ invisible; the actor prompt is unchanged. An empty or
  whitespace-only string counts as nothing.
- Return a **string** ⇒ it rides as a `## Run setup` message on every actor turn.
  Use it for the handful of facts the agent can't discover (a handle, a
  credential).

Rules for the string:

- **Cap: 2048 UTF-8 bytes** (it rides every turn). Over the cap is a hard error —
  fail fast, no truncation.
- **Never persisted** (it may hold a secret); only the boolean "context was
  returned" is recorded, in `manifest.setup`.
- **Seed the precondition, not the outcome** — in a discovery study, leaking the
  answer biases the study.

## Idempotency — your contract, unenforced

The harness calls the hook before every run; you guarantee re-running converges.
A stable handle reuses the entity, so the hook often runs against the last run's
leftover state. Write "ensure in state X", never a bare "create".

## Local vs shared handle — decide with the user

The right handle depends on facts only the user knows (shared env? concurrent
runs? teardown tolerated?), so ask rather than assume:

- **Stable handle** (`suiteName` + `storyId`): no accumulation, but concurrent
  runs of the same story against a shared env contend. Use for local/serial runs
  — v1 does NOT solve shared-env concurrency.
- **`runId` handle**: never contends; entities accumulate (there is no teardown
  yet). Use for shared envs that tolerate accumulation.
- **Discovery**: `storyId` ⇒ one entity shared across personas; `caseId` ⇒ one
  per persona.

## Rails (how it behaves at the edges)

- Runs once per run, in every mode (record / act / heal / explore), for journeys
  AND discovery. Heal re-entry does NOT re-run it.
- Hook throws ⇒ infra (exit 2): the actor never starts and the gate is skipped.
  Fix setup/env, not app code.
- Non-string return, or a string over the cap ⇒ config error (exit 2) naming
  `hooks/before_each.js` — friendly message, no raw stack.

## When NOT to use a hook

- You want to **assert on** a side effect, not cause one → write a custom
  assertion (the playtest-assertions skill), the post-actor mirror.
- The state is settable at launch → `app.init` / `app.cookies` /
  `app.storage_state`.

## Not built yet

Only `before_each` exists. No `after_each` / `after_all` / `before_all`, no
per-case opt-out — don't author them. With a convergent stable handle, teardown
is usually unnecessary.
