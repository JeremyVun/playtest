# Playtest contracts

These are the authoritative Playtest contracts. Read only the theme
relevant to the change:

| Contract | Owns |
|---|---|
| [Artifact contracts](contracts/artifacts.md) | Persisted run formats, manifests, trajectories, baselines, pins, compatibility, storage providers, and `.ptrun` bundles |
| [Engine contracts](contracts/engine.md) | Configuration resolution, drivers, model protocols, execution modes, gates, grading, hooks, events, and concurrency |
| [Hosted platform contracts](contracts/hosted.md) | Hosted storage, authorization, suites, applications, runs, review, events, and retention |
| [Hosted runner contracts](contracts/hosted-runners.md) | Placement, dispatch, executor fencing, runner trust and isolation, claims, mint recovery, and live evidence upload |
| [Hosted findings contracts](contracts/hosted-findings.md) | Finding identity and lifecycle, consolidation, auto-resolution, rule cards, synthesis, and assisted authoring |
| [Hosted web contracts](contracts/hosted-web.md) | Console information architecture, vocabulary, launch and review UX, live presentation, operations, and accessibility |
| [Interface contracts](contracts/interfaces.md) | Supported package imports, CLI behavior and JSON, the runner agent CLI and its configuration file, reporting, viewer HTTP routes, URL parameters, and degradation |
| [Script contracts](contracts/scripts.md) | Script suites: the entry contract, the injected client, the check report, runner semantics, the coverage-obligation manifest, the two-column verdict, the risk profile, the leak scan, the HAR lifecycle, and the execution trust boundaries |

`docs/playtest-design.md` explains product concepts and rationale. The contract
files specify behavior that implementations and consumers may rely on.

## Contract-change rules

- Update the owning thematic file in the same change as a contract change.
- Persisted shape changes also update every applicable schema and reader.
- Public import, CLI JSON, viewer route, and bundle changes require
  compatibility treatment.
- Incompatible step changes bump the step schema version. Comparability changes
  update the artifact pin contract. Prompt text is not versioned.
- Preserve legacy behavior explicitly documented under artifact compatibility
  unless the change deliberately removes it.
- Use file-and-heading links, not numbered section references.

Repository layout, implementation history, test inventories, fixtures, and
release notes do not belong in these contracts. `CLAUDE.md`, local READMEs,
tests, and Git history own those concerns.

## Source-of-truth boundaries

- JSON/YAML schemas own directly expressible validation. Engine contracts own
  merge precedence and cross-field rules that schemas cannot express.
- Workspace `package.json` export maps and package-owned public facades own the
  executable list of supported import specifiers and names. Interface contracts
  own their behavioral guarantees.
- Commander definitions own the complete human help inventory. Interface
  contracts record stable command resolution, side effects, machine output,
  safety, and exit behavior.
- Artifact contracts remain explicit for persisted formats that do not have
  executable schemas.
