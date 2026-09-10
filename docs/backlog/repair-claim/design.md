# Repair claims

Status: built 2026-09-10 on branch `hillclimb/p0`. This item exists because an
external repair daemon (the `hillclimb` project) needs to know which finding is
its to work on. The behavior is specified in
[Hosted findings contracts](../../contracts/hosted-findings.md#repair-claims);
this file records why it looks the way it does.

## What and why

A daemon outside Playtest reads user feedback, triages it, files findings and
attempts fixes. More than one such repairer may exist, and each may crash mid
attempt. Two things have to be true and neither was:

- exactly one repairer works a given finding at a time, decided by something
  neither of them owns; and
- a crashed repairer releases its hold without anyone intervening.

That is a lease. Playtest is already the durable ledger for findings, already
arbitrates one-winner races the same way for dispatches, and is the only party
both repairers can see, so the lease belongs here.

Playtest gains no knowledge of repair itself. It does not know what a worktree,
a branch, a gate or a pull request is, it never calls the repairer, and it holds
no attempt state. It answers "may I work this finding?", "am I still working
it?" and "here is what came of it".

## Routes

`POST /findings/:f/repair-claim` (developer) takes `{owner, ttl_s}` and answers
`200 {finding_id, owner, generation, expires_at, heartbeat_interval_s}`, or
`409` naming the live owner when someone else holds it.

`POST /findings/:f/repair-claim/heartbeat` (developer) takes
`{owner, generation, ttl_s}` and extends the lease, or `409` when the claim is
not the caller's or has expired.

`POST /findings/:f/repair-claim/release` (developer) takes
`{owner, generation, outcome, external_ref?, note?}`, clears the lease, records
the outcome, and emits `finding.repair_suggested` or `finding.repair_released`.

`POST /findings/:f/repair-outcome/reset` (reviewer) puts a concluded finding
back in the queue and emits `finding.repair_reset`.

`POST /findings/:f/notes` (editor) attaches prose to a finding with no run
evidence, and emits `finding.note_added`.

`GET /projects/:p/findings?repairable=1` is the queue.

## Decisions

**The claim lives on the finding row, not in `leases`.** Eligibility for a claim
is a fact about the finding — its state, its merge status, whether a repair
already concluded — and the whole precondition has to be restatable in one
mutating WHERE. A separate lease row would put half the precondition in a second
table and turn one UPDATE into a join with a gap in it. This is the shape
`dispatch/state.ts` already uses for `claimDispatchForRunner`.

**Playtest never dispatches repair work.** The queue is a read the repairer
polls. Nothing here schedules, calls out, or holds a job. A repairer that stops
polling simply stops repairing, and every finding it held returns to the queue
when its lease runs out.

**Developer to claim, reviewer to reset.** Claiming is a machine acting on a
project's code, which is the developer tier the code-file routes already use.
Resetting an outcome overrides a recorded machine conclusion, which is a review
decision. Notes are editor: writing prose about a finding is authoring, and the
triage half of the daemon holds an editor token only.

**A concluded outcome is sticky.** Without it a repairer that cannot fix a
finding would claim it again on the next poll, forever. The outcome is the
memory that stops the loop, and reopening the finding — genuinely new evidence —
clears it.
