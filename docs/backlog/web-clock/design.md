# Web driver clock

Status: ruled 2026-09-09 by the owner as part of the ilovetrains
`feedback-hillclimbing` item (`~/projects/trains_app/docs/backlog/
feedback-hillclimbing/`, decision D14). Build straight from this doc.

## What and why

A checked-in regression suite replays recorded journeys with `--no-grade`
and no model, so a baseline must replay step for step. Replay compares
accessibility snapshots for exact text, and apps that print times (a
departure board says "12:48" and "in 4 min") only replay if the browser
sees the same instant every run. The ilovetrains suite serves captured
upstream fixtures verbatim, so each case needs to pin the page clock to
the instant those fixtures were captured.

Playtest has no clock setting today. The owner rejected an app-side
override read from storage state because it puts a test seam in the
product; the clock belongs in the driver, where every project replaying a
time-dependent screen can use it.

## Mechanism

`app.clock` is a web-only environment key:

```yaml
app:
  driver: web
  base_url: http://127.0.0.1:8080
  clock:
    time: "2026-08-31T22:44:00+10:00"
    timezone: Australia/Sydney
```

- `time` is an RFC 3339 instant. `timezone` is an IANA zone name and is
  required with `time`; there is no default zone because a bare instant
  renders differently on every machine.
- It is valid wherever `viewport` is valid: `playtest.yaml` defaults, a
  case, and an `app.envs.<name>` overlay; the case wins over defaults and
  the overlay wins over both, exactly like the other environment keys.
- It is applied at browser context creation for every context the driver
  opens for a case, in record, act and heal alike: `timezoneId` on the
  context, and Playwright's clock API so that `Date.now()`, `new Date()`
  and `Intl` formatting in the page return the fixed instant on every
  call while timers (`setTimeout`, `setInterval`, `requestAnimationFrame`)
  keep running. An app's refresh loop must keep firing; only the reading
  of the clock is frozen.
- The resolved case echoes it under `env.clock` (null when absent) and the
  run manifest records it, so a reviewer can see which instant a baseline
  was recorded at.
- Omitted means real time, as today. A mobile or API case that declares it
  is a configuration error naming the key. A malformed instant or unknown
  zone is a configuration error at load, not a run failure.

## Decisions

| # | Question | Ruling |
| --- | --- | --- |
| 1 | Driver setting or app-side override? | Driver setting, owner 2026-09-09 (D14 in the ilovetrains item). |
| 2 | Freeze timers too? | No. Fixed reading, running timers: the apps under test poll and animate. |
| 3 | Default timezone? | None; `timezone` is required with `time`. |
| 4 | Overlay or hosted ring? | No: defaults and case only, owner 2026-09-09; the design's "wherever viewport is valid, including overlays" sentence was self-contradictory. |

## Verify

- `npm run typecheck` and `npm run test:core` cover load validation,
  merge order (defaults, case, overlay), the resolved-case echo and the
  driver option plumbing.
- One real Chromium test under the core `test:browser` suite loads a page
  that prints `new Date().toISOString()` and a zone-formatted time twice a
  few hundred milliseconds apart with a running `setInterval` counter, and
  asserts both readings equal the fixed instant in the given zone while
  the counter advanced.
- `docs/contracts/engine.md` gains the key next to `viewport`, and
  `README.md` shows the YAML above.

Done 2026-09-09 (029a57d).

## Closeout

Migrate the key's description into `docs/contracts/engine.md` and delete
this folder.
