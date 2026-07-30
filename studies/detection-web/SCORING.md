# Scoring rules — ledger → headline metrics

Frozen at G4 close, before any measured round. These rules derive the
headline table from each round's `ledger.json`; they interpret, and do not
alter, the PREREG metric definitions.

1. **Duplicate resolution is per-arm.** Normalization is arm-blind, so a
   claim may be marked `duplicate_of` a primary from the *other* arm. For
   scoring, each claim inherits the resolved verdict of its duplicate chain's
   primary (verdict, fault_id), but is credited to **its own arm**. Within one
   arm, one fault credits once per the unique-fault rule regardless of how
   many of its claims resolve to that fault.
2. **Seeded found (per arm, per round):** distinct `fault_id`s over that
   arm's non-withdrawn claims whose resolved verdict is `seeded`.
   Cumulative = union across the trial's rounds. A fault already withdrawn
   for that arm cannot be re-credited (its manifestation is gone; a claim
   naming it would be judged on its own evidence and cannot be `seeded`
   against a withdrawn fault — the classify pass sees only fault cards, so
   the merge step drops `seeded` verdicts for faults already withdrawn for
   that arm as `invalid: not-a-bug`, logged in the ledger as an override with
   reason `withdrawn-before-round`).
3. **Latent found (per arm):** distinct latent issues (after duplicate
   resolution) among that arm's claims. Latents are counted per distinct
   underlying issue, not per claim.
4. **Invalid claims (per arm, per round):** that arm's claims resolving
   `invalid`, with `duplicate` broken out separately in the appendix. The B3
   noise ratio for arm P = invalid non-duplicate claims ÷ all non-duplicate
   arm P claims that round.
5. **Masking-aware recall (B1):** the denominator for a trial is the set of
   faults reachable in at least one round of that trial for that arm
   (round-1 reachable set ∪ faults unmasked by that arm's withdrawals).
   Raw recall uses all 20. Both are reported.
6. **Withdrawal set after round n:** every fault with resolved verdict
   `seeded` for that arm in round n (post human-audit overrides). Withdrawn
   via `build-injected.mjs --withdraw` of the cumulative set; `/__build`
   verified before the next round.
7. **Stop rule:** an arm stops after round 3, or when a round adds zero new
   seeded faults for that arm, whichever comes first (PREREG).
8. **Costs:** arm P = group `stats.cost_usd` + synthesis usage cost per
   round; arm C = transcript token totals priced at the PREREG table
   ($5/$30/$0.50 per M in/out/cache-read). Judge and author tokens are shared
   study overhead, reported separately.
