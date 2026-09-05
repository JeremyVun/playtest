# Usability and copy review

Reviewed 5 September 2026 against the running ilovetrains console and current source. Screenshots and initial observations are in `/tmp/playtest-design-round-01/current/`. The owner approved dirty-edit protection, title generation, Findings search/filter controls and copy cleanup. Replay's initial-step change was declined. Story-list search is outside the approved scope.

## Usability priorities

| Priority | Finding and evidence | Recommendation |
| --- | --- | --- |
| High, reproduced | Adding an unsaved marker to a story enables Save. Clicking Suites in the rail immediately navigates away without a warning; returning restores the original text. `lib/router.ts` navigates unconditionally; `lib/source-editor.ts` only confirms explicit Discard. | Protect dirty stories and suite settings on internal navigation, Back, reload and tab close. Preserve the draft or ask before discarding it. |
| Accepted by owner | Interrupted Replay opens at successful step 1; the actor error is step 5. | No change. The owner considers the current behavior appropriate. |
| Medium, observed and source-confirmed | Many finding titles are cut mid-word at 180 characters. `control-plane/src/findings/intake.ts:353`, extractor and run-grade paths use fixed string slicing. | Produce a complete concise title while retaining the complete claim/evidence. Do not modify matching keys or historical records casually; title changes can affect duplicate detection. |
| Medium, approved for Findings | The 59-finding review bucket and 28-story suite list have no search or filters. | Add text search and severity filtering to Findings. Preserve controls and focus during updates. Story-list controls are out of scope. No new panels or navigation. |
| Medium, observed and source-confirmed | Story editor labels a persona “not in this project” beside “valid story.” The picker only checks the project/built-in catalog, while core supports suite-local persona files. Structural validation does not establish full execution readiness. | Show provenance such as Built in, Project, or From suite when resolved; use a missing warning only after checking all supported sources. Describe validation scope separately. |
| Medium, observed | Story editor leads with its file slug and puts several infrequent actions beside editing controls. | Lead with the human description and retain file identity in the existing File area. Move Delete and export/history actions into the established overflow menu where appropriate. |
| Small, source-confirmed | Run Cancel uses `.row-act.danger`, whose danger color appears only on hover. The disclosure control is 22×22px. | Keep danger discernible before hover and enlarge the disclosure target while preserving dense rows. These are already represented in the comp polish. |

The unsaved-edit reproduction used a disposable browser context on `/p/ilovetrains/suites/user-stories/stories/01-walking-twenty-minutes-out`. Durable API mutations were blocked; only read-only validate/lint POSTs ran. No saved data changed. Reload/tab-close and suite-settings draft handling remain source-based follow-up checks.

The launch dialog is a preserve reference: environment, target, mode, consequences and cost appear before launch. Finding detail already puts evidence close to the decision. Preserve these flows while removing repeated explanations.

## Copy proposals

| Current copy or pattern | Proposed treatment | Reason |
| --- | --- | --- |
| `ring chosen at launch` in the suite subtitle | Remove; if context requires the fact, use `Environment selected at launch`. | The launch dialog already asks this. “Ring” is an internal name. |
| `Live` beside `Idle` in the footer | `Connected` beside `No active runs` when those states apply. | Distinguishes the event connection from run activity. |
| `not in a tracker yet` when `external_ref` is absent | `No linked ticket`. | The app cannot know whether a ticket was created without linking it. |
| `Confirm and copy` / `Copy for tracker` | `Confirm and copy summary` / `Copy summary`; retain the visible copy receipt. | Names what reaches the clipboard. The action does not create a tracker ticket. |
| Long Findings subtitle plus automatic-duplicate explanation plus detail review banner | Keep one short explanation where the person first reviews; retain specific provenance beside evidence. Keep dismissal's suppression consequence in its dialog. | Repeating the lifecycle across three layers consumes space without adding a decision. |
| Generic page subtitles describing the page's purpose, such as Runs' `Every run, story by story…`; repeated headings such as `All suites` / `Project suites` in the comps | Remove when navigation, headings and controls already explain the page. Keep counts and state-specific guidance. | Instruction should earn its place by helping the current decision. The comps should not establish new boilerplate. |
| `Dedupe history`, `Automatic dedupe`, `Dedupe model` | `Duplicate review history`, `Merge duplicate findings`, `Duplicate review model`. | Use plain words consistently; keep the history link available. |
| Settings subtitle explaining that the project key is used in URLs, CLI and API and cannot change | Show `Project key: …` with a short immutability note in the relevant settings area; place usage explanation in help if needed. | The long sentence repeats across unrelated Settings tabs. |
| `valid story`, `lint: …`, `couldn't run checks` | `Story checks passed`; plain warning text; `Couldn't check this story. Try again.` with a retry control. Persona provenance needs the separate fix above. | Scope success honestly, remove implementation vocabulary, and provide a recovery action. |
| Empty Findings text explaining synthesis, grading, citations and repeat suppression in one paragraph | `No findings need review.` plus one sentence explaining where new findings appear. | An empty state needs orientation and a next step, not the entire lifecycle. |

These are wording proposals, not automatic global replacements. Final strings should be checked in their actual state and against the behavior they describe.

## Source-only cleanup candidate

`pages/story.ts:975` still contains a missing-URL error that directs the reader to Suite settings, then says the hosted environment supplies the URL. Current hosted validation uses structural resolution (`control-plane/src/suites/resolve.ts`) and does not require a physical target, so this branch was not observed in the live audit. Remove or correct the stale guidance if the branch remains reachable; do not report it as a reproduced flow bug.
