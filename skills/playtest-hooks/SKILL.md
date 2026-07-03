---
name: playtest-hooks
description: Author a Playtest before_each lifecycle hook — JS that runs before every run of a suite to converge the world state the run presumes (seed a user, reset a tenant, put an account in arrears). Use when the precondition can only be set by side-effecting code (a backend SDK, queue, or API the harness can't drive), not by a URL/cookie/storage_state at launch.
---

# Playtest `before_each` hooks

Author code that runs once before every run to establish a precondition. The pre-actor mirror
of a custom assertion (the post-actor side — the playtest-assertions skill). An assertion runs
after the actor to observe a side effect; a hook runs before it to cause one. Trusted (your
code, harness privileges, not sandboxed), convention-discovered (no YAML, no schema). Use a hook
ONLY when the state can't be set at launch — confirm with the user that it can't, and prefer
`app.storage_state` (a session), `app.cookies` (a flag), or `app.init` (a global reset) when they fit.

## File (by convention)

```
my-suite/
  playtest.yaml
  hooks/before_each.js     # default-exports an async function
```

`before_each.js` at the suite root (nearest `playtest.yaml`) runs for every case under it, every
run. No `hooks/before_each.js` ⇒ the suite is byte-identical to having no hook.

## Contract

Default-export a function taking `ctx` — async in practice, since you'll do setup I/O (the
harness awaits whatever it returns; a sync function is accepted too). Optionally return a short
string the actor will see:

```js
// hooks/before_each.js — trusted, author-owned, NOT sandboxed
import { ensureUserInState } from "./client.js"; // your own dep

export default async function beforeEach(ctx) {
  // Compose your OWN handle (the harness mints none). Stable = reused across runs; runId = unique.
  const handle = `acme_user_${ctx.suiteName}_${ctx.storyId}`;
  // MUST be idempotent: may run against the previous run's end-state. "check, then create-or-move".
  await ensureUserInState(handle, "loan_in_arrears", { baseUrl: ctx.baseUrl });
  // Optional: a fact the actor needs to start. Return nothing to stay invisible.
  return `Test user ${handle} (password "hunter2"), signed up, loan in arrears.`;
}
```

### `ctx`

- `runId` — unique per run. Handle keyed on it ⇒ fresh entity every run (never contends; accumulates).
- `runDir` — logging only; don't write setup state here.
- `startedAt` — `Date`, run start.
- `baseUrl` — resolved base URL (post compose/env). Reach the app via this, never a hardcoded host.
- `driver` — `"web"` | `"mobile"` | `"api"`.
- `env` — `{ ...process.env, BASE_URL, RUN_ID }`. Read backend creds from here, never hardcode.
- `suiteName` — suite root basename.
- `storyId` — persona-independent base id. Key on it ⇒ one shared entity per discovery study.
- `caseId` — resolved fanned-out id (`base@persona`; ≡ `storyId` for a journey). Key on it ⇒ one
  entity per persona.

## Return value

Return nothing ⇒ invisible (actor prompt unchanged). Return a string ⇒ it rides as a
`## Run setup` message on every actor turn — for the handful of facts the agent can't discover
(a handle, a credential). Rules:

- Cap 2048 UTF-8 bytes (rides every turn). Over-cap is a hard error — fail fast, no truncation.
- **Never persisted** (may be a secret); only "context was returned" is recorded.
- Seed the precondition, not the outcome — in a discovery study, leaking the answer biases it.

## Idempotency (your contract, unenforced)

The harness calls the hook before every run; you guarantee re-running converges. A stable handle
reuses the entity, so the hook often runs against the last run's leftover state — write "ensure in
state X", never a bare "create".

## Local vs shared handle — decide with the user

The right handle depends on facts only the user knows (shared env? runs concurrent? teardown
tolerated?), so ask rather than assume:

- Stable handle (`suiteName` + `storyId`): no accumulation, but concurrent runs of the same story
  against a shared env contend. Use for local/serial — v1 does NOT solve shared-env concurrency, so
  don't run the same story concurrently against a shared env with a stable handle.
- `runId` handle: never contends; entities accumulate (no teardown yet). Use for shared envs that
  tolerate it.
- Discovery: `storyId` = one entity shared across personas; `caseId` = one per persona.

## Rails

- Runs once per run, any mode (record/act/heal), journey AND discovery. Heal re-entry does NOT re-run it.
- Hook throws ⇒ INFRA (exit 2): gate skipped, actor never starts. Fix setup/env, not app code.
- Non-string return or over-cap ⇒ config error (exit 2) naming `hooks/before_each.js`, no raw stack.

## When NOT to use a hook

- Asserting on a side effect, not causing one → a custom assertion, the post-actor mirror (the
  playtest-assertions skill).
- State settable at launch → `app.init` / `app.cookies` / `app.storage_state`.

## Not built yet

Only `before_each`. No `after_each`/`after_all` teardown, no `before_all`, no per-case opt-out —
don't author them. With a convergent stable handle, teardown is usually unnecessary.
