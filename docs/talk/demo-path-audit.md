# Demo-path viewer audit (VERSION_1.1 item 1)

Audited 2026-06-13 against fresh `playtest demo --keep` runs (all three acts),
walked in the viewer with headless chromium, every screen screenshotted and
reviewed. Scope: only the talk's narrative path — replay with thought
captions → heal-diff view with the divergence frame. Every claim below has
screenshot evidence from the audit run; the fixes were re-verified with a
second scripted walk after landing.

## Checklist: act → screen → finding → resolution

| Act | Screen | Finding | Resolution |
|---|---|---|---|
| 1–3 | Brief panel (`#cap-brief`), any case with `tags: []` | Literal `null` text node rendered under the persona row — `renderBrief` passed ternary `null`s straight to `replaceChildren`, which stringifies them (unlike `h()`) | **Fixed**: filter children before `replaceChildren` (app.js) |
| 1–3 | Brief panel, all cases | YAML block-scalar hard wraps rendered verbatim (`white-space: pre-wrap`), reading as accidental mid-sentence breaks | **Fixed**: single newlines collapse to spaces, blank lines stay paragraph breaks (app.js) |
| 2 | Caption, replayed done step (last caption of the talk's example case) | Fallback read `— done I added "buy milk". The page shows the result..` — ungrammatical splice + double period | **Fixed**: done/give_up args are quoted (`finished: “…”`), trailing punctuation stripped (app.js; clip.js mirrors it) |
| 1, 3 | Step inspector, SUMMARY row on done steps | Prose broke mid-word (`The page s/hows`) from `.kv dd { word-break: break-all }` | **Fixed**: `overflow-wrap: anywhere` — word boundaries first, mid-token only when a locator forces it (style.css) |
| 3 | Diff tab (the finale), divergence frame | The money shot was a 300px thumbnail — unreadable from an audience seat — and the only non-clickable element in the pane | **Fixed**: `min(480px, 46%)` + click opens the step in Stills (style.css, app.js) |
| 3 | Diff tab, "this run" column | Step numbering jumped 01→03: the failed replay attempt (the heal point!) was silently absent from the track | **Fixed**: the removed baseline row now faces a red `replay attempt failed — agent took over` cell, clickable to that step (app.js) |
| 2 | Diff tab head | `2 same` vs the header's `3 STEPS` invited a "why 2?" beat (done step is not part of the action track) | **Fixed**: head now says `· executed UI actions only` (app.js) |

## Won't fix (off the talk path, or not viewer code)

| Act | Screen | Finding | Why not |
|---|---|---|---|
| 1 | Picker entry | Every picker load logs one deliberate 404 (`/run/manifest.json` single-run probe in `boot()`) | Devtools-only; eliminating it moves the 404 to single-run mode. Item 5's smoke test allowlists deliberate probes. |
| 2 | Inspector Run tab | "not graded — grade.json absent" leaks an artifact filename | Off the talk path (wording-only; Milestone C copy pass) |
| 1–3 | Stills | Step stills are pre-action frames (caption "type buy milk" over an empty input) | Cross-act harness convention; record/act parity holds. Changing capture semantics is runner work, out of item-1 scope. |
| 3 | Changed list from a far-away cwd | Long `run_dir_rel` paths widen the commands `<pre>` past the card edge (clipped, no scrollbar) | Talk path serves from the demo cwd (short paths, renders clean). Note for Milestone C. |
| 3 | clear-completed heal run | The healed agent repeats the whole journey (re-adds "pay rent"): mock-llm can't see replayed `type` text in acted history lines, so its rule fires again. Adds a REGRESSION chip + doubled duration on this one case. | Fixture behavior, not viewer; an actor-prompt history change would touch `PROMPTS_VERSION`. The viewer renders the data honestly. Talk finale uses add-todo; presenter note: lead with add-todo. |
| 2 | Video view, final frame | A faint arc over the settled page when landing on the last step | Transient (Chromium seek spinner per the act-3 re-check); not reproducible in settled frames. |

## Acceptance

- Three demo acts present cleanly: re-verified post-fix — no blank panels,
  no broken images, no misaligned diff steps on the talk path; zero page
  errors across picker, all three cases, all stage views.
- The finale reads: removed `click add-button` ↔ failed replay attempt,
  added `click submit-button`, and a large clickable divergence frame
  showing the renamed green Save button with "buy milk" typed.
