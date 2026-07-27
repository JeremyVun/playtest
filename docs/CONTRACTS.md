# Playtest contracts

These are the authoritative Playtest contracts. Read only the theme
relevant to the change:

| Contract | Owns |
|---|---|
| [Artifact contracts](contracts/artifacts.md) | Persisted run formats, manifests, trajectories, baselines, pins, compatibility, storage providers, and `.ptrun` bundles |
| [Engine contracts](contracts/engine.md) | Configuration resolution, drivers, model protocols, execution modes, gates, grading, hooks, events, and concurrency |
| [Hosted platform contracts](contracts/hosted.md) | Hosted system boundaries, authorization, snapshots, dispatch, runner protocol, review, findings, plugins, events, retention, and web invariants |
| [Interface contracts](contracts/interfaces.md) | Supported package imports, CLI behavior and JSON, reporting, viewer HTTP routes, URL parameters, and degradation |
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

## Historical section crosswalk

Older plans and history may cite the former monolithic numbered sections:

| Former section | Current owner |
|---|---|
| §1 shared data shapes | [Artifacts](contracts/artifacts.md) for persisted shapes; [Engine](contracts/engine.md) for resolved cases and identity |
| §2 config | [Engine: Discovery and configuration](contracts/engine.md#discovery-and-configuration) |
| §3 trajectory | [Artifacts: Step envelope](contracts/artifacts.md#step-envelope), [Baseline files](contracts/artifacts.md#baseline-files), and [Trajectory projections](contracts/artifacts.md#trajectory-projections) |
| §4 and §16 drivers | [Engine: Driver contract](contracts/engine.md#driver-contract) |
| §5–§10 model and runtime | [Engine](contracts/engine.md) |
| §11–§13 reporting, CLI, viewer | [Interfaces](contracts/interfaces.md) |
| §13 storage seam and §18 bundles | [Artifacts: Storage providers and run bundles](contracts/artifacts.md#storage-providers-and-run-bundles) |

The former test-strategy, todo-fixture, and changelog sections were relocated
or removed because they were not contracts.
