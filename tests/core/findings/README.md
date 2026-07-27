# Findings intake + consolidation — P0 evaluation corpus

Offline, model-free fixtures and evaluator that **freeze** the candidate intake
and consolidation behavior contracted in
[`docs/contracts/hosted.md`](../../../docs/contracts/hosted.md) ("Bug candidates
and intake", "Candidate consolidation"). These files are fixtures and expected
data only — nothing here is imported by `src/**`.

## Files

| File | Purpose |
|---|---|
| `spec.ts` | Frozen pure reference functions: match-text/locus normalization, strict/loose recurrence keys, rare-word-weighted shortlist, score routing, and connected-component clustering. The executable spec the runtime must reproduce. **Never wire into runtime.** |
| `corpus.ts` | Twelve scrubbed run-evidence fixtures (real step-envelope, actor-raise, and `grade.json` shapes with run-specific ids/numbers/timestamps present) plus each fixture's recorded expected outcome. |
| `evaluator.ts` | Model-free evaluator: runs `spec.ts` over `corpus.ts`, reports the P0 baseline measures, and lists any mismatch against the recorded expectations. |
| `README.md` | This file. |

The hermetic tests that exercise all of the above live at
[`tests/core/unit/findings-consolidation.test.ts`](../unit/findings-consolidation.test.ts)
and run under `npm test` / `npm run test:core`.

## Vocabulary (frozen)

- **actor raise** — a structured sticky note on one step (`envelope.raises[]`).
- **grader finding** — a free-form UX/quality observation in one `grade.json`.
- **bug candidate** — a typed, cited claim the app malfunctioned.
- **platform finding** — a durable cross-run defect with identity and evidence.

## Run the evaluator

```sh
node tests/core/findings/evaluator.ts
```

It prints the baseline measures and exits non-zero if computed behavior diverges
from any recorded expectation:

- candidate recall on seeded defects;
- precision after human review;
- exact-match rate (strict recurrence keys);
- shortlist recall (true duplicates present in top-k);
- cluster model calls / input tokens / candidates per call (defined and computed
  over fixture data with **zero** model calls);
- evidence rows retained after promotion.

## The twelve cases

`exact-recurrence-noisy-ids`, `reworded-personas-duplicate`,
`cross-category-duplicate`, `loose-key-two-stories`,
`same-category-distinct-defects`, `expectation-vs-observed`,
`label-control-contradiction`, `actor-claim-contradicted`,
`required-affordance-vs-ux-wish`, `intended-404-not-a-bug`,
`ux-friction-stays-grader-finding`, `insufficient-evidence-unresolved`.

## Measured thresholds and baseline

The consolidation defaults in
[`docs/contracts/hosted.md`](../../../docs/contracts/hosted.md) were measured
here: 12 fixtures, 17 candidate/finding items, 120 pairs, scored with the shipped
runtime retrieval (`src/platform/control-plane/src/findings/shortlist.ts`).
`src/platform/control-plane/tests/unit/findings-shortlist.test.ts` asserts these
numbers, so they cannot drift silently — a regression fails the gate.

All 120 pairs were scored; duplicates and everything else separate cleanly:

| Pair | Score | Duplicate? |
|---|---|---|
| `f3-existing` / `f3-incoming` (cross-category duplicate) | 0.495 | yes |
| `f1-existing` / `f1-incoming` (exact recurrence, noisy ids) | 0.474 | yes |
| `f2-adversarial` / `f2-careful` (reworded personas) | 0.376 | yes |
| `f4-existing` / `f4-incoming` (two stories, one surface) | 0.316 | yes |
| `f1-existing` / `f6-badge` (strongest unrelated pair) | 0.175 | no |
| `f1-existing` / `f2-adversarial` | 0.167 | no |
| `f5-giftcard` / `f5-password` (same category, distinct defects) | 0.052 | no |

The floor 0.25 is the midpoint of the 0.175–0.316 gap; shortlist recall is 100%
and no unrelated pair is retrieved, including the two same-category `http_error`
defects that must never merge. No duplicate reaches the 0.6 auto-suggest
threshold, by design. At the floor no corpus candidate has more than one
neighbor, so `k` is not the binding constraint — it bounds how fast a connected
component can grow. The one cluster the corpus produces carries 96 estimated
input tokens (~1.6% of the 24000-byte cap), so the 15-item cap binds first and
the byte cap is the backstop for verbose claims; components over the item cap are
split into capped calls and the split is recorded, never truncated.

P0 baseline, measured with those defaults and excluding the three candidates
intake resolves by exact key (they never reach consolidation):

| Measure | Value |
|---|---|
| candidate recall on seeded defects | 100% (9 seeded) |
| precision after human review | 91.7% (11 accept / 1 reject / 1 unresolved) |
| exact-match rate | 50% over 4 recurrence pairs (the other two are loose/none by design) |
| shortlist recall (true duplicate in top-k) | 100% over 3 duplicate pairs |
| cluster model calls | 1 |
| candidates per call | 2 |
| estimated input tokens per call | 96 |
| per-candidate calls avoided | 1 (2 clustered candidates, 1 call) |
| evidence rows retained after promotion | 16 |

The call ratio is the one to watch as a corpus grows: per-candidate
classification costs one call per candidate, consolidation one per connected
component. Here that is 2 versus 1, and the saving scales with duplicate density.

### When to revisit

Driven by the `consolidation_labels` table rather than intuition:

- **Under-merging** (reviewers repeatedly promote two candidates the shortlist
  never paired) — lower the floor first; swap the scorer for embedding
  similarity only if the floor cannot separate them.
- **Over-merging** (reviewers repeatedly edit or reject proposed groups) — raise
  the floor and the auto-suggest threshold.
- **Oversized or too-frequent cluster calls** — tighten the floor or `k` before
  adding machinery.
