# Home loan applicant capture fixture

Deliberately imperfect multi-step web app for lenders to capture home-loan
applicant data. Built as a zero-dependency Node fixture for playtest-style
bughunt / journey experiments. **Not a real product.**

Planted defects are catalogued in [ISSUES.md](./ISSUES.md) (`LOAN-001` …
`LOAN-035`).

## Requirements

- Node.js 20+ (ESM)
- No npm install required for this fixture

## Start

From the repository root:

```sh
node tests/app-fixture/server.js
```

Then open **http://127.0.0.1:4191/**

### Environment

| Variable | Default       | Meaning                          |
|----------|---------------|----------------------------------|
| `PORT`   | `4191`        | Listen port                      |
| `HOST`   | `127.0.0.1`   | Bind address                     |

Examples:

```sh
PORT=4200 node tests/app-fixture/server.js
HOST=0.0.0.0 PORT=4191 node tests/app-fixture/server.js
```

## Application flow

0. **Landing** — start CTA
1. **Identity** — first/last name, DOB, SSN, income
2. **Contact** — email, confirm email, phone, address, city, state, ZIP
3. **Property / loan** — property value, loan amount, purpose, consent
4. **Review** — summary + submit
5. **Confirmation** — reference number from `POST /api/applications`

## API

`POST /api/applications` with a JSON body returns:

```json
{
  "ok": true,
  "reference": "HL-…",
  "message": "received",
  "echo": { /* request body */ }
}
```

Static assets are served from `public/`.

## Programmatic start (tests)

```js
import { start } from "./server.js";

const server = await start({ port: 0 }); // ephemeral port
// server.url, server.port, await server.close()
```

## Tests

```sh
node --test tests/app-fixture/fixture.test.js
```

These tests are standalone. They are **not** part of the hermetic root
`npm test` gate.

## Happy path tips (despite bugs)

- Use DOB as `M/D/YYYY` with year ≤ 2020 (e.g. `3/15/1988`).
- On Contact, use the quiet underlined **Next** (not the green one).
- Prefer money values without thousands separators, or with only one comma
  (e.g. `450000` or `450,000` not `1,250,000`).
- Loan amount must be at least 50000.
- ZIP: avoid leading zeros if you need them preserved (`type=number` strips them).
