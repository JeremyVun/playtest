# Loanpoint — study subject application

Loanpoint is a small internal desk console for a university media-services
equipment lending desk: staff book camera, audio, lighting, support and
computing kit out to departments, high-value or long requests wait for a
supervisor decision, kit is collected, sometimes extended, and eventually
checked back in with a late fee and a deposit outcome. Five connected flows —
desk overview, equipment catalogue, loans, a three-step new-loan flow, and an
approvals queue — share one pool of state, so an action in any one of them
moves the numbers in the others. It exists to be exercised by automated
testers, so it has zero runtime dependencies, a frozen clock, seeded data and a
reset hook; [`SPEC.md`](SPEC.md) is the authoritative description of what it
does.

## Run it

```sh
node studies/detection-web/subject/server.js
```

Then open <http://127.0.0.1:4620>.

| Variable | Default | Meaning |
|---|---|---|
| `SUBJECT_PORT` | `4620` | Listen port. The server always binds `127.0.0.1`. |
| `SUBJECT_NOW` | `2026-03-16T09:00:00Z` | The frozen desk clock, as an ISO instant. Every date-dependent value derives from it; the machine clock is never read. |

Requires Node.js 24.18 or newer. Nothing is installed and nothing is built —
the server uses only `node:` built-ins and serves the files under `public/`
as they are.

## Test it

```sh
node --test "studies/detection-web/subject/tests/*.test.js"
```

On Node 24 the directory form also works:

```sh
node --test studies/detection-web/subject/tests/
```

(On Node 25.8 a bare directory argument is not expanded by the test runner, so
prefer the quoted glob.)

The suite is offline, dependency-free and deterministic. It covers every
business rule and formula in `SPEC.md`, every validation message, each flow's
happy path at the API level, the state-conflict refusals, the static routes and
the reset hook — including an assertion that the seeded state comes back
exactly after heavy use.

## Operational hooks

Two endpoints exist for the harness and are deliberately absent from the
interface:

- `POST /__reset` — restore the exact seeded state, including loan numbering
  and the empty draft list.
- `GET /__build` — `{"app":"Loanpoint","variant":"clean","now":"…"}`.

## Layout

```text
server.js          HTTP server: route table, JSON API dispatch, static files
src/
  time.js          the frozen desk clock and calendar arithmetic
  data.js          seeded catalogue and loans; every value is literal
  store.js         in-memory state, reset, id allocation
  rules.js         business rules (pure): availability, quotes, due dates,
                   approval, late fees, extensions, desk metrics
  validate.js      input validation and its exact messages
  present.js       view models handed to the browser
  format.js        money and unit wording used in server messages
  api.js           one handler per endpoint
public/
  app.html         the page shell
  app.js           routing, chrome and view dispatch
  styles.css       the whole stylesheet
  lib/             fetch wrapper, element builder, formatting, validation, UI parts
  views/           one module per page
tests/             node:test suites, plus helpers.js
SPEC.md            the product specification
```
