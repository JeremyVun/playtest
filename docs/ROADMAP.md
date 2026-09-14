# Roadmap

This file lists unfinished work only. Completed behavior belongs in contracts
and Git history. The previous backlog was intentionally cleared on 2026-09-05.

Before starting an item, read `CLAUDE.md`, `docs/CONTRACTS.md`, its design and
build plan. Keep `npm test` offline, Node-only and green with zero skipped tests;
run each feature's explicit integration gates as well.

## Active work

- [ ] **Hosted Compose deployment** — Postgres metadata, private Spaces objects,
  containerized control plane/web and isolated runners on one VM, integrated
  with Caddy, Authelia and deployctl. First prove the stack locally, including
  persistence and restore, before VM rollout.
  [Design](backlog/hosted-compose/design.md) ·
  [Build plan](backlog/hosted-compose/build_plan.md).
  Architecture drafted; existing-data and authentication/authorization choices
  await the owner's answers.

- [ ] **Repair claims** — a lease an external repairer takes on one finding, so
  more than one repairer can share a project's findings without colliding and a
  crashed one releases its hold on its own. Playtest arbitrates the lease and
  records the outcome; it dispatches nothing.
  [Design](backlog/repair-claim/design.md).
  Built and green on branch `hillclimb/p0`, awaiting merge and a hosted
  redeploy; the behavior is already written into
  [Hosted findings contracts](contracts/hosted-findings.md#repair-claims).
- [ ] **Web origin guard** — `app.allowed_origins` on the web driver: every
  browser context blocks requests outside the case's origins and records them,
  and the `navigate` verb refuses an off-origin target. Built for the external
  daemon that runs feedback-written discovery cases against production.
  [Design](backlog/web-origin-guard/design.md). The behaviour is built and
  binding in [Engine contracts](contracts/engine.md#origin-confinement); the
  folder closes out and is deleted once that daemon runs against it.
