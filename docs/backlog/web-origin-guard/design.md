# Web origin guard

## What and why

An external daemon (`~/projects/hillclimb`) turns untrusted user feedback into
Playtest discovery cases and runs them against a production website. The api
driver has confined its egress since it shipped; the web driver did not. It
recorded every off-origin request in `har.json` and let all of them through, so
a story written from an attacker's feedback could walk the actor onto any site
and read whatever it found there.

`app.allowed_origins` therefore becomes a web key as well, and the web driver
enforces it. The behaviour is binding in
[Engine contracts: Origin confinement](../../contracts/engine.md#origin-confinement).

## Mechanism

The admitted set is `base_url`'s origin plus each `app.allowed_origins` entry,
matched exactly on scheme, host and port. Every browser context the driver opens
routes through `context.route("**/*")`: an admitted request continues, anything
else is aborted with `blockedbyclient` and recorded as a `request_blocked`
progress event (`{ url, method, resource_type }`) on the run's event stream and
in `events.jsonl`. A blocked subresource does not fail the case. The `navigate`
verb checks its target before Playwright is asked for it, so an off-origin or
`javascript:` target fails that step with a message the actor reads.

Two document paths cannot be refused up front. A link click is a navigation the
page starts, and Playwright does not invoke a route handler for a redirect hop,
so an admitted URL that answers `302` to another origin is followed by the
browser before any handler runs. Both are unwound instead: the driver records
the block, fails the step, and returns the page to the last admitted URL, so the
off-origin document reaches neither the actor's snapshot nor the grader. The
residue is one uncredentialed request at the redirect hop.

The alternative — fetching each navigation with `route.fetch({ maxRedirects: 0 })`
and fulfilling it — does abort the hop, and it was built and rejected. A
fulfilled document has no remote address for Chromium to classify, so it is
treated as public address space and its cross-origin requests to a loopback
origin are blocked as local network access. Every local suite whose app talks to
a second local port would break, including this item's own `allowed_origins`
test. Confining the transport is not worth losing the transport.

## Decision

Enforced in the driver, deterministic, with no agent-side bypass and no prompt
text as part of the guard: an actor that could talk its way past the guard is
not a guard (owner, 2026-09-09, ruling D8 in the hillclimb daemon design). The
allowlist resolves from the case and its defaults chain only; nothing at run
time widens it.

The guard is **not** exported by `export-playwright.ts`, which does export
`app.clock`. The clock is a determinism pin: an exported spec that reads a
different instant fails for the wrong reason. The guard is a confinement of an
untrusted actor, and an exported spec has no actor — it replays a fixed, reviewed
action list in the user's own Playwright project, where the user owns the network
policy. Exporting the aborts would only break the third-party fonts, images and
analytics the recorded page legitimately loads.

## Hazards

A production site's third-party assets (fonts, analytics, CDN images, embedded
maps) are blocked unless the case names their origins. That is the intended
behaviour and it is visible — every block is an event — but a case whose site
needs them must list them in `app.allowed_origins`, and a run whose page looks
unstyled should be read as a missing origin before it is read as a bug.
