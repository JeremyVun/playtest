# Sign-in providers and secrets — scoping, placement, and reference semantics

Three defects found while asking a single question: *why do "Sign-in providers"
and "Secret references" sit on the Applications page?* The answer is that both
are project-scoped registries referenced from one place — an environment — and
the console puts the registry next to the reference instead of next to its
peers. Pulling that thread surfaced a scoping gap and a server/UI disagreement
that are worth more than the placement fix.

Read first:

- `CLAUDE.md`
- `docs/CONTRACTS.md`
- `docs/contracts/hosted.md` — "Applications, rings, secrets, and target
  authentication" (the owning contract for all three phases)
- `packages/platform/control-plane/src/api/secrets.ts`
- `packages/platform/control-plane/src/api/executor-api.ts` — `resolvedSecrets`
- `packages/platform/runner-agent/src/workspace.ts` — `buildRingOverlay`
- `packages/platform/web/src/pages/applications.ts`,
  `packages/platform/web/src/pages/application-authorization.ts`

Standing rules:

- Update `docs/contracts/hosted.md` in the same change as shipped behavior.
- `npm test` stays hermetic and zero-skipped.
- Do not widen the secrets read surface without deciding the role question in
  A1 first.

## What the model actually is

Both resources are project registries referenced by name from a ring. Only
providers can additionally be pinned to one ring.

| | project registry | referenced from a ring | hard-bound to a ring |
|---|---|---|---|
| secrets | `(project_id, name)`, `0001_baseline.sql:228` | by name in `secret_env` | **none** |
| auth providers | `(project_id, name)`, `0001_baseline.sql:246` | `provider/identity` in `auth.identities` | optional `ring_id` |

The consumer graph has exactly one shape. `sessionRefs()`
(`executor-api.ts:895-901`) scans only `ringConfig.auth.identities` and
`ringConfig.secret_env`; `resolvedSecrets()` (`executor-api.ts:869-885`)
collects names only from `secret_env` and `$secret_file` in the overlay. The
runner turns both into `app.auth_states` entries and process env
(`workspace.ts:52-71`), and a story names the resulting *label* — `auth:
"member"`. No application, suite, story, or persona references either resource
directly. The single `auth_providers` reference in `api/applications.ts:344` is
a delete guard, not a configuration relationship.

The registry model is correct and should stay: rotation is an upsert on
`(project_id, name)` (`api/secrets.ts:45-50`) that reaches every reference at
once; values are write-only, so a per-ring copy could never be duplicated from
an existing one; and sessions cache per `(provider, identity)`
(`hosted.md:219-220`), so a shared provider mints once for N rings instead of N
times against a customer's real auth endpoint.

What is missing is the scoping half, and what is wrong is where the registries
are drawn and what a bare string in `secret_env` means.

## Phase map

| Phase | Outcome |
|---|---|
| **A0** | `secret_env` means one thing; the console and the server agree |
| **A1** | The two registries live with their peers in Settings |
| **A2** | A secret can be scoped to one environment, as a provider already can |

A0 → A1 → A2 is the recommended order: A0 changes the copy that A1 relocates,
and A1 puts the forms in their final home before A2 adds a field to them. None
of the three strictly blocks another.

---

## A0 — `secret_env` string semantics

### Problem

The server and the console disagree about what a bare string value in
`secret_env` is, and the console's reading is the one that fails.

- **Server:** a secret *name* to resolve. Every string that is not a
  `$session:` reference is added to the wanted set, and a name with no matching
  row aborts the claim exchange with `environment configuration references
  missing secrets: …` (`executor-api.ts:872-882`).
- **Console:** a pasted *literal value*. `maskSecretEnv` masks strings as
  secrets-in-the-clear (`secret-mask.ts:10-18`) and the environment form warns
  *"pasted values are stored readable by anyone with this page. Prefer
  `{"$secret": "name"}`"* (`applications.ts:670`).

Following the console's framing — paste a value, accept the warning — produces
an environment that saves cleanly and then fails at exchange, in a message that
names the pasted value back to the operator. The runner's
`resolvedSecrets[ref] ?? ref` fallback (`workspace.ts:63`) looks like it
handles literals but is unreachable; the server throws first.

### Scope

Settle it in the server's favour: a `secret_env` string is a secret name, never
a value. That is what `hosted.md:188` already calls the overlay's contents
("secret references"), and it makes literals in a developer-readable document
impossible rather than merely discouraged. No working configuration changes
behaviour — a pasted literal is already a failing run.

1. `maskSecretEnv` renders a string as the reference it is
   (`VAR=$secret:name`), not as `MASK`. `literalSecretKeys` and the warning it
   feeds are retired or re-pointed at the new failure mode.
2. The environment form validates at save: a `secret_env` string must name a
   secret that exists, reported as a field problem rather than deferred to a
   run. This needs the name list, which is admin-only today — see the role
   decision in A1. Until that lands, validate shape and let the exchange
   report the unknown name.
3. `resolvedSecrets` keeps its behaviour; the error text gains the environment
   key so an operator knows which of several rings referenced the missing name.
4. Contract: state the string form explicitly in `hosted.md` alongside
   `$secret_file` and `$session:`.

Adjacent, deliberately not folded in: the roadmap's *"Validate ring `config`
values by shape, not just key"* item covers the general case of an overlay that
saves and then fails at run time. A0 is the one instance worth fixing ahead of
it because it is the instance the UI actively recommends.

### Exit gate

- A `secret_env` entry naming an unknown secret is refused with an actionable
  message; a run is never the first place it is reported.
- No console surface describes a bare string as a stored value.
- Control-plane integration coverage for the missing-name path names the ring.

---

## A1 — The registries move to Settings

### Problem

Both panels hang off the Applications *index* (`applications.ts:105-128`),
folded into `<details>`. On a project with no applications they render below
the empty state as the only other content on the page — which is what prompted
this plan. Nothing on the surface says either one is project-scoped; the only
hint is a `project-wide` chip visible after expanding a panel that already has
a provider in it (`application-authorization.ts:35`).

The placement rationale is written down (`applications.ts:24-27`): authorization
belongs with the applications that use it rather than in a settings tab. The
codebase contains the counter-example. **Runner labels** are also project-scoped,
also referenced only from a ring, and Runners lives in Settings
(`settings-sections.ts:14-18`) — with the environment form showing *derived
feedback* about which runners a label set reaches (`paintPlacement`,
`applications.ts:746-770`) rather than hosting the registry. Two resources of
identical shape should not land in different places.

The stated reason Applications left Settings (`settings-sections.ts:7-9`) was
about executable surfaces and deployment targets. Write-only credentials are
policy in the ordinary sense, so moving them back does not reopen that
decision.

### Scope

1. Two new entries in `SETTINGS_SECTIONS`, reusing the existing min-role
   machinery instead of the hand-rolled `canEdit`/`canAdmin` gates in the page
   body:

   ```
   { id: "providers", label: "Sign-in", min: "developer" }
   { id: "secrets",   label: "Secrets", min: "admin" }
   ```

2. `authProvidersPanel` and `secretsPanel` move as-is behind a thin adapter —
   they already take `(projectKey, slot)` and fetch their own data. The
   providers panel fetches the applications it needs for the ring-binding
   picker rather than receiving them.
3. Applications keeps the reference half, which it already has: the identity
   picker (`sessionRefOptions`, `rings.ts:319-330`) and the environment card's
   "Signs in as" and "Secret variables" rows (`applications.ts:310-318`). Those
   gain a link to the relevant Settings section.
4. Add the inverse of `paintPlacement`: each provider in the registry says
   which environments reference it. Nothing today answers *"is this provider
   used?"*, and deletion is blocked by exactly that
   (`hosted.md:207`), so an admin meets the question at the worst moment.
5. **Role decision, needed by A0:** a developer is told to add a name "under
   Secret references" (`applications.ts:670`) on a surface `min: "admin"` hides
   from them, and cannot list names to validate a reference they are allowed to
   write. Either the copy becomes role-aware, or `listSecrets`
   (`api/secrets.ts:16`) drops to `developer` — it returns names and timestamps
   only, never ciphertext. Recommend the latter: developers already read secret
   *names* off environment cards, so admin-gating the list hides nothing it
   protects, and the alternative leaves a validation gap in A0.

Touchpoints: `settings-sections.ts` and its comment, the `RENDER` map in
`settings.ts`, deletion of `applications.ts:105-128`, and
`packages/platform/web/tests/web-ia.test.ts`, which asserts the section set and
role disclosure. `hosted.md` specifies scoping and roles, not placement — no
contract change unless the role decision moves `listSecrets`.

### Exit gate

- Neither registry appears on Applications; both appear in Settings under the
  correct role.
- The environment card and form link to the registry that backs each reference.
- A provider row names the environments referencing it.
- `web-ia.test.ts` asserts the new section set and its role disclosure.

---

## A2 — Ring-scoped secrets

### Problem

`ring_id` on a provider is a real containment boundary: ring-bound providers are
usable only by that ring, `ON DELETE RESTRICT` so it is never silently widened
(`0001_baseline.sql:239-249`, `hosted.md:217-218`). Secrets have no equivalent
— any ring in the project may name any secret.

That makes provider binding weaker than it appears. A `storage_state_secret`
provider is a thin wrapper over a secret (`sessions.ts:538-542`); binding it to
`prod` protects the minting path, but the underlying secret is still nameable
from any ring's `secret_env`. The names are not hidden — `maskSecretEnv` keeps
reference objects readable by design (`secret-mask.ts:14-15`) — so a developer
reading one environment's card learns a name and can reference it from a ring
they control, and ring config is a `developer` mutation
(`api/applications.ts:279`). Admin-gating the secrets list asserts that
developers should not reach values; the ring path routes around the assertion.

Whether that matters is a threat-model call about how much `developer` is
trusted relative to `admin`. The product already answered it once by gating
secrets at `admin`. A2 makes the rest of the system agree.

### Scope

1. Migration: `secrets.ring_id TEXT REFERENCES rings(id) ON DELETE RESTRICT`,
   nullable. `NULL` is project-wide and is every existing row, so the migration
   is additive and changes no current behaviour.
2. Enforcement in one place: `resolvedSecrets()` (`executor-api.ts:869`) refuses
   a name whose `ring_id` is set and does not match the ring being resolved.
   The call site already has `target.ring_id` in hand (`executor-api.ts:313-322`)
   and passes only `target.config` today.
3. `loadSecret()` (`sessions.ts:556-563`) applies the same rule for
   `storage_state_secret` providers, resolved against the provider's own
   `ring_id`. A project-wide provider may not read a ring-scoped secret.
4. Secret form gains the environment picker the provider form already has, with
   the same copy: bound means reachable only from that environment; unbound
   means any environment may name it.
5. Deletion of a ring already refuses on auth-provider references
   (`hosted.md:207`); extend the same refuse-not-cascade to scoped secrets and
   name them in the error.
6. Contract: `hosted.md:211-223` gains the secret scoping rule beside the
   provider one, and the delete-guard list gains scoped secrets.

### Exit gate

- A ring-scoped secret referenced from another ring fails the exchange with a
  message naming both the secret and the ring that owns it.
- A project-wide provider cannot mint from a ring-scoped secret.
- Existing project-wide secrets behave exactly as before, proven by migrating a
  populated data root.
- Ring deletion names scoped secrets among its referrers.
- `docs/contracts/hosted.md` records the rule.
