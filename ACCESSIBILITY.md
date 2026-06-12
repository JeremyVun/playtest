# Accessibility As A First-Class Output (parked)

Moved here 2026-06-13 from the improvement planning doc (formerly
IMPROVEMENTS_FOLLOWUP.md §10; that doc has since been deleted) to think
about after VERSION_1.1 ships. Status: **not yet convinced.** The open question
to answer before any of this is built: what does a dedicated a11y report
tell a team that the LLM actor does not already provide? The agent
navigates by accessibility tree, so journeys on badly-labeled apps already
fail or visibly struggle today — the marginal value of formalizing that
into a report layer (and of adding axe-core on top) is unproven. Revisit
with a concrete consumer in mind (compliance review? a design-system
team?) or drop it.

Original design follows unchanged.

---

The agent navigates by accessibility tree, so every run is implicitly an
a11y probe — and journey-level a11y evidence ("a screen-reader-class user
cannot complete checkout") carries legal weight under EAA/WCAG that
element-level lint output does not.

Two layers:

- **Signals already captured, just not reported:** ref-resolution failures,
  semantically sparse snapshots, unlabeled elements the agent guessed at,
  screenshot-fallback steps. Surface these as an `a11y` section in
  `grade.json` and the viewer, attributed to steps.
- **Add axe-core injection per step** (industry-standard, runs in-page,
  cheap): collect violations per step into the envelope's artifacts.
  Weight by relevance: a violation on an element the journey actually used
  is "blocking-path"; elsewhere on the page is "incidental". This
  distinction is what makes the report actionable rather than a wall of
  noise.

Gate integration stays opt-in and deterministic:

```yaml
perf:
  console_errors: 0
a11y:
  blocking_violations: 0   # axe criticals on elements the journey used
```

Report: per-journey a11y evidence page (journey, persona, violations on
path, screenshots) — exportable for compliance review.
