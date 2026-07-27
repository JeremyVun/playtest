# ux-lab

A throwaway hosted Playtest, filled with realistic content, that a browser can
walk end to end. Built so a UX pass argues from evidence — screenshots and a
control inventory — instead of from memory.

```sh
node tools/ux-lab/lab.mjs serve     # seeded console at http://127.0.0.1:4188, held open
node tools/ux-lab/lab.mjs shoot     # screenshot every surface, both themes → out/
node tools/ux-lab/lab.mjs list      # print the surface inventory
```

Useful flags for `shoot`:

```sh
--only runs,settings     # substring match against surface ids
--theme dark             # one theme instead of both
--width 860              # e.g. to see the sub-900px scope gate
--tag narrow             # write to out-narrow/ instead of clobbering out/
--headed                 # watch it drive
```

## What it does

`plane.mjs` boots `packages/platform/control-plane` **in-process** (the same
`createApp` + `listen` path the integration harness uses) against
`tools/ux-lab/.data`, wiped on every start. It never touches your own
`.playtest-data` or port 4177.

Dispatch is stubbed: the real GitHub client refuses to launch without a GitHub
App, and `PLAYTEST_DISPATCH=local` would spawn a browser-and-model run per
story. `StubDispatch` accepts the launch and reports a workflow id, and
`seed.mjs` then drives the **public runner protocol** — exchange → start →
upload bundle → report → complete — exactly as a GitHub Actions executor would.
That is what makes the server compute real baselines, candidate diffs, findings,
events, and group summaries rather than hand-forged rows. Run bundles are
genuine committed trajectories from `studies/viewer-self-test/fixtures`; only
the small `manifest.json` is patched per run.

Three things have no public path and are written directly, marked `SEAM` in
`seed.mjs`: backdating rows so trends read like a real week, and bug-candidate
intake (which normally arrives from model synthesis).

## What gets seeded

- `todo-app` — the rich project. A suite with four stories (one of them a
  two-persona discovery study) plus an empty second suite; two environments, a
  secret, an auth provider, an API token; six run groups spanning pass, fail,
  infra, changed-awaiting-review, explored, and one still in flight; two
  findings (one accepted, one promoted by hand); two unassigned bug candidates.
- `acme-checkout` — an empty project, so the first-run screens are always in
  the capture set.

## Output

```
out/dark/<surface>.png     full-page screenshot, deviceScaleFactor 2
out/light/<surface>.png
out/report.json            per surface: headings, visible copy, and the
                           accessible name of every interactive control
out/problems.json          console errors, uncaught exceptions, failed
                           requests, and 4xx/5xx responses, per surface
```

`report.json` is the adversarial half. Unlabelled buttons, inputs that only have
a placeholder, and several controls sharing one accessible name on a single
screen all fall out of it with a one-line query:

```sh
node -e "const r=require('./tools/ux-lab/out/report.json');
for (const [id,s] of Object.entries(r))
  for (const c of s.controls||[])
    if (!c.name || c.name.startsWith('(placeholder')) console.log(id, c.tag, JSON.stringify(c.name));"
```

## Adding a surface

Surfaces live in `surfaces.mjs` as `{ id, title, path(data), act?, note? }`.
`path` receives the seeded ids; `act` is an optional async step run after the
page settles (open the modal, pick the tab) before the screenshot. `act` steps
address controls by their visible label on purpose: if a control cannot be
reached by its label, that is itself an audit finding.

## Gotchas

- Never wait for `networkidle`. Every project page holds a long-poll on the
  event feed, so the network is idle only when the feed is broken.
- The pointer keeps whatever position the last click left it in; a stray
  `:hover` in the rail photographs as an active navigation state. `capture.mjs`
  parks the mouse in the bottom-left gutter before each shot.
- `.data/`, `out/`, and `out-*/` are gitignored.
