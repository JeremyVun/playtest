#!/usr/bin/env node
// Render the round's RESULTS.md tables from RESULTS.json + builds-digest.json.
// Numbers only: this file deliberately writes no verdict against §9's bars.

import fs from "node:fs";
import path from "node:path";

const roundDir = process.argv[2];
const R = JSON.parse(fs.readFileSync(path.join(roundDir, "RESULTS.json"), "utf8"));
const D = JSON.parse(fs.readFileSync(path.join(roundDir, "builds-digest.json"), "utf8"));

const ARMS = ["t1", "t2", "t3", "proposal"];
const NAME = { t1: "T1", t2: "T2", t3: "T3", proposal: "PROP" };
const CATS = [
  "state-machine",
  "cross-resource-invariant",
  "conditional-branch",
  "pagination",
  "idempotency",
  "temporal-boundary",
  "authorization",
  "error-semantics",
];
const FAULTS = Object.keys(R.faults);

// D1's check, derived from the committed per-build digest: `verdict.failing_ids`
// carries every failing check id for every build, so the round is re-checkable
// without the run-local reports.
const D1_CHECK = "accounts-enumeration-is-complete";
const d1Rows = D.builds.filter((b) => b.arm === "t3");
const d1Fails = d1Rows.filter((b) => (b.verdict?.failing_ids ?? []).includes(D1_CHECK));
const d1 = {
  total: d1Rows.length,
  fail: d1Fails.length,
  pass: d1Rows.length - d1Fails.length,
  fails: d1Fails.map((b) => b.id),
  cleanFail: d1Fails.filter((b) => b.label.startsWith("clean")).length,
};

const out = [];
const w = (line = "") => out.push(line);

const c1 = (f) => (f.column_one_covered === false ? "n/c" : f.column_one === true ? "**yes**" : "no");
const c2 = (f) => (f.column_two === true ? "**yes**" : f.column_two === false ? "no" : "—");

w("# S0 sealed round — results");
w();
w(`Generated ${R.generated_at} by the sealed-round operator, offline, from the`);
w("round's artifacts alone. **No verdict against `PREREGISTRATION.md` §9's bars is");
w("recorded here** — that is the orchestrator's call in `REPORT.md`. This file is");
w("the numbers.");
w();
w("| | |");
w("|---|---|");
w(`| Round | \`${R.round}\` |`);
w(`| Replay-order seed | \`${R.seed}\` (§8.1) |`);
w(`| Sealed bundle | \`sealed-set-v2.tar.gz\` sha256 \`${R.sealed_set.tarball_sha256.slice(0, 16)}…\` |`);
w(`| Sealed patch | sha256 \`${R.sealed_set.patch_sha256.slice(0, 16)}…\`, 68 863 bytes |`);
w(`| Sealed faults | ${R.sealed_set.faults} (${R.sealed_set.semantic} semantic-tier, ${R.sealed_set.faults - R.sealed_set.semantic} schema-reachable) |`);
w(`| Inside the pinned oracles' vocabulary | ${R.sealed_set.column_one_covered} of ${R.sealed_set.faults} — the other ${R.sealed_set.faults - R.sealed_set.column_one_covered} read *not covered by the pinned oracle*, never *miss* |`);
w(`| Arms | 4 — three statements-trials and the proposal trial |`);
w(`| Builds per arm | ${R.arms.t1.false_positives.conforming_builds + R.sealed_set.faults} (${R.arms.t1.false_positives.conforming_builds} conforming + ${R.sealed_set.faults} fault) |`);
w(`| Builds in the round | ${R.economics.round.builds} |`);
w(`| Infrastructure failures recorded in this attempt | ${R.economics.round.infrastructure_failures} |`);
w(`| Model calls in the verdict path | 0 |`);
w();
w("**One arithmetic note on §5, reported and not corrected.** The frozen text");
w("says \"16 conforming builds per suite … 64 conforming builds in the round\", but");
w("the list it enumerates in the same sentence is 3 canonical clean + 4 variant");
w("builds + 10 jittered repeats, which is **17**, and 4 arms × 17 = **68**. The");
w("harness defaults §5 pins (`--clean-repeats 3`, three variants plus the combined");
w("build, `--jitter-repeats 10`) produce the enumerated set, so the round ran 17");
w("conforming builds per arm and 68 in total. Nothing was added or dropped: the");
w("preregistration's summary integer disagrees with its own enumeration by one.");
w();
w("## 0. Reruns and infrastructure failures (§8.3)");
w();
w("One infrastructure failure is on the record, and it invalidated a whole");
w("attempt rather than a build:");
w();
w("- **Attempt 1 — discarded, port collision.** An orphaned ledger fixture from an");
w("  earlier session (started the previous evening, parent `init`, serving");
w("  `/tmp/ledger-links/server.js`) held `127.0.0.1:4184`, the harness's default");
w("  replay port. Every per-build fixture the harness started died with");
w("  `EADDRINUSE`, and `waitHealthy` was satisfied by the stale listener, so the");
w("  31 builds of arm `t1` and the first 8 of `t2` ran against a foreign,");
w("  unfaulted, unvarianted, unjittered instance. The give-away was in the");
w("  numbers before it was in the logs: every build, faulted or clean, jittered or");
w("  not, returned exactly 205 requests in ~0.4 s. All 39 attempt-1 builds were");
w("  discarded unscored; none of their artifacts is in this round directory.");
w("  This is §8.3's *port collision*, at attempt 1 of 3.");
w("- **Attempt 2 — the scored round.** The stale process was killed, the port");
w("  asserted free before the first build, and all 124 builds completed with **0**");
w("  infrastructure failures. Every build's fixture log was then read back and");
w("  matched against the configuration its build id names (§8 below), which is the");
w("  check the harness cannot do for itself.");
w();
w("No other rerun of any kind was performed. No build that produced a scored");
w("result was re-run, and no result was re-scored (§8.5).");
w();
w("## 0.1 Instrument verification (§4.2)");
w();
w("`verify-instrument.mjs` before applying the patch: bench pins match the tree;");
w("the P1 vendored oracle copy in sync; sealed set matches its committed digest");
w("(`2d7a0d28…b406`, 68 863 bytes); sealed set still applies. **Instrument");
w("verified.**");
w();
w("After `git apply -p1` and `npm run bench:pins -- --write`: bench pins match the");
w("tree; the vendored copy still in sync; digest still matches. The");
w("*still-applies* row fails, necessarily and only because the patch is now");
w("applied — `git apply -R --check` reverses cleanly, which is the post-apply form");
w("of the same assertion. `shared_oracle` is unchanged either side of the apply:");
w("`lib/oracles.js` `04a3c69f…131c`, `lib/trace.js` `8d822ce6…df64`, byte-identical");
w("to P1's freeze. Re-recorded `bench_scoring` digests: `lib/score.js`");
w("`38565dde…54ed`, `lib/witnesses.js` `5924fb6e…6f78`, `../src/faults.js`");
w("`3ef70436…2ae4`.");
w();
w("Fixture suite with the patch applied and the pins re-recorded: **132 tests, 132");
w("pass, 0 fail, 0 skipped**, as the sealed author's manifest requires.");
w();

w("## 0.2 Substrate drift, in two parts");
w();
w("§3 pins 54 substrate files and a substrate digest, and a reader will check it,");
w("so both ways this round's tree differs from the frozen one are recorded here.");
w("Neither decision is adjudicated here; both predate this round.");
w();
w("**(a) The unpatched tree: exactly one file.** `fingerprints.mjs` on the tree the");
w("suites replayed against, before the sealed patch, gives **`381caf11…6878`** and");
w("not the frozen **`99dd1549…1b26e`**. The file *set* is unchanged (54) and one");
w("digest moved:");
w();
w("| File | at the freeze | at this round |");
w("|---|---|---|");
w("| `$LEDGER_FIXTURE_DIR/src/ledger.js` | `9fc4dd23…0325a3` | `e9b2cf1b…1ab887c` |");
w();
w("That is `12cba1d`, *ledger-api: make page order total so a quiescent walk drops");
w("nothing* — the D1 fix, taken after the freeze and recorded in `ROUND-LOG.md`");
w("with the sealed set's rebase onto it. Every other substrate file is");
w("byte-identical to the freeze: all seven oracles, both `shared_oracle` files, the");
w("runner, the injected client, the report schema, the OpenAPI document,");
w("`oracle-pins.json`, and all four briefs and handouts.");
w();
w("**(b) With the sealed patch applied, four pinned files differ, not three.**");
w("§4.2 anticipates the patch extending `src/faults.js`, `bench/lib/witnesses.js`");
w("and `bench/lib/score.js`, and instructs the operator to re-record them. The v2");
w("patch also modifies **`src/ledger.js`** — necessarily, since that is where every");
w("`[FAULT …]` branch lives — and `src/ledger.js` is one of the 54. The sealed");
w("bundle's own manifest lists it; §4.2's `touches:` line does not. The measured");
w("digests, all four reproducible by applying the patch to this tree:");
w();
w("| Pinned file | pre-seal (§3) | with the sealed patch applied |");
w("|---|---|---|");
w("| `src/ledger.js` | `e9b2cf1b…1ab887c` | `58435dc3…7e510b` |");
w("| `src/faults.js` | `99224090…6e3d3e` | `3ef70436…2282ae4` |");
w("| `bench/lib/witnesses.js` | `72a947d0…1304d8c9` | `5924fb6e…a9a8e6f78` |");
w("| `bench/lib/score.js` | `a36caf69…93a9b10` | `38565dde…7a0bad54ed` |");
w();
w("`shared_oracle` — `lib/oracles.js` `04a3c69f…131c` and `lib/trace.js`");
w("`8d822ce6…df64` — is untouched by the patch and byte-identical to P1's freeze,");
w("which is the property the probe rematch depends on.");
w();

w("## 1. Per-fault detection, both columns");
w();
w("`n/c` = the fault's rule is outside the seven pinned oracles' vocabulary, so");
w("column one **cannot speak to it** (§6.1). It is not a miss.");
w();
w(`| # | Fault | Category | Tier | C1 covered | ${ARMS.map((a) => `${NAME[a]} c1/c2`).join(" | ")} |`);
w(`|---|---|---|---|---|${ARMS.map(() => "---").join("|")}|`);
FAULTS.forEach((id, index) => {
  const meta = R.faults[id];
  w(
    `| ${index + 1} | \`${id}\` | ${meta.category} | ${meta.tier === "semantic" ? "semantic" : "schema"} | ` +
      `${meta.column_one_covered ? "yes" : "no"} | ` +
      ARMS.map((a) => `${c1(R.arms[a].faults[id])} / ${c2(R.arms[a].faults[id])}`).join(" | ") +
      " |",
  );
});
w();
w("### Totals per arm");
w();
w("| Arm | C1 detected / covered | C1 not covered | C2 detected /14 | C2 semantic /13 | C2 strict semantic /13 | reported-without-evidence |");
w("|---|---|---|---|---|---|---|");
for (const a of ARMS) {
  const t = R.arms[a].totals;
  w(
    `| ${R.arms[a].label} | ${t.column_one_detected} / ${t.column_one_covered} | ${t.column_one_not_covered} | ` +
      `${t.column_two_detected} | ${t.column_two_detected_semantic} | ${t.column_two_strict_semantic} | ${t.reported_without_evidence} |`,
  );
}
w();

w("## 2. Per-category detection, both columns");
w();
w("A fault counts for its category once per arm, however many builds it appeared");
w("in (§4.3, N12). `c1` is scored only over the faults the pinned oracles cover.");
w();
for (const a of ARMS) {
  w(`### ${R.arms[a].label} (\`${a}\`)`);
  w();
  w("| Category | faults | semantic | C1 detected / covered | C2 detected | C2 semantic | missed on C2 |");
  w("|---|---|---|---|---|---|---|");
  for (const category of CATS) {
    const c = R.arms[a].categories[category];
    w(
      `| ${category} | ${c.faults} | ${c.semantic} | ${c.column_one_detected} / ${c.column_one_covered} | ` +
        `${c.column_two_detected} / ${c.faults} | ${c.semantic_column_two} / ${c.semantic} | ` +
        `${c.missed_ids.length ? c.missed_ids.map((id) => `\`${id}\``).join(", ") : "—"} |`,
    );
  }
  w();
}

w("## 3. The five-stage funnel, and every miss diagnosed");
w();
w("Stages: 1 obligation enumerated · 2 scenario executed · 3 fault manifested in");
w("traffic · 4 assertion detected · 5 evidence correctly cited. `T`/`F`/`?`; the");
w("first `F` is the diagnosis (§6.2). `?` is *the artifacts cannot answer*, never");
w("a miss.");
w();
w("Two readings the tables below need, because the funnel is mechanical and the");
w("first-false rule does not know whether the arm went on to succeed:");
w();
w("- **`reachability` covers two different failures.** A `F` at stage 2 means the");
w("  suite never drove the API into the state the fault lives in. A `F` at stage 3");
w("  means it *did* reach that state and the fault still did not manifest in the");
w("  recorded traffic — the suite touched the surface but not the corner of it the");
w("  fault occupies. The `first false stage` column separates them.");
w("- **A row can be diagnosed and still be a detection.** The diagnosis is the");
w("  first false stage whatever happens afterwards, so a fault whose stage 1 or 2");
w("  reads `F` but whose stages 4–5 read `T` was detected with correct evidence and");
w("  is credited on column two. Those rows are listed under \"detected with an");
w("  earlier stage false\" rather than under misses.");
w();
const stageKeys = [
  "obligation_enumerated",
  "scenario_executed",
  "manifested_in_traffic",
  "assertion_detected",
  "evidence_correctly_cited",
];
const cell = (v) => (v === true ? "T" : v === false ? "F" : "?");
for (const a of ARMS) {
  w(`### ${R.arms[a].label} (\`${a}\`)`);
  w();
  w("| Fault | 1 | 2 | 3 | 4 | 5 | diagnosis | witness fired |");
  w("|---|---|---|---|---|---|---|---|");
  for (const id of FAULTS) {
    const f = R.arms[a].faults[id];
    w(
      `| \`${id}\` | ${stageKeys.map((k) => cell(f.funnel?.[k])).join(" | ")} | ` +
        `${f.diagnosis === "none" ? "— (detected)" : f.diagnosis} | ${f.witness ? f.witness.manifestations : "—"} |`,
    );
  }
  w();
  const diag = R.arms[a].diagnoses;
  w(
    `Diagnosis counts: ${Object.entries(diag)
      .map(([k, v]) => `${k === "none" ? "detected" : k} ${v}`)
      .join(" · ")}`,
  );
  w();
  if (R.arms[a].misses.length) {
    w("Misses in detail:");
    w();
    for (const miss of R.arms[a].misses) {
      w(
        `- \`${miss.fault}\` (${miss.category}, ${miss.tier}) — **${miss.diagnosis}**` +
          (miss.first_false ? `, first false stage \`${miss.first_false}\`` : "") +
          `; witness ${miss.witness?.known ? (miss.witness.reached ? `reached, ${miss.witness.manifestations} manifestation(s)` : "not reached") : "unknown"}` +
          `; column one ${miss.column_one_covered ? (miss.column_one ? "confirmed" : "did not confirm") : "not covered by the pinned oracle"}.`,
      );
    }
    w();
  } else {
    w("No misses on column two.");
    w();
  }
  const oddities = FAULTS.filter((id) => R.arms[a].faults[id].column_two === true && R.arms[a].faults[id].diagnosis !== "none");
  if (oddities.length) {
    w("Detected with an earlier stage false (credited on column two regardless):");
    w();
    for (const id of oddities) {
      const f = R.arms[a].faults[id];
      w(
        `- \`${id}\` — stage \`${f.first_false}\` is false (diagnosis \`${f.diagnosis}\`), stages 4 and 5 true` +
          `${f.column_two_strict ? "" : ", strict column two not credited"}. ` +
          (f.first_false === "obligation_enumerated"
            ? "The suite's own rule tag for this check does not match the vocabulary the witness files the rule under, so the enumeration stage cannot see it; the check exists, ran, failed, and cited resolving evidence."
            : "The witness did not fire on this arm's traffic, so the bench cannot confirm the fault manifested in the exchanges the arm recorded, but the arm's own failing check is attributable and its citation resolves on target."),
      );
    }
    w();
  }
}

w(`## 4. False positives on the ${R.arms.t1.false_positives.conforming_builds} conforming builds (§5, §6.3)`);
w();
w("Per arm: 3 canonical clean + `terse-optionals` + `trailing-page` + `wide-ids` +");
w(`\`all-variants\` + 10 jittered repeats = ${R.arms.t1.false_positives.conforming_builds} conforming builds; ${R.arms.t1.false_positives.conforming_builds * 4} in the round.`);
w();
w("| Arm | conforming builds | column-1 FP (oracle) | column-2 FP (failing checks) | distinct failing checks |");
w("|---|---|---|---|---|");
for (const a of ARMS) {
  const fp = R.arms[a].false_positives;
  const ids = new Set();
  for (const bucket of Object.values(fp.by_label)) for (const check of bucket.checks) ids.add(check.check_id);
  w(`| ${R.arms[a].label} | ${fp.conforming_builds} | ${fp.oracle} | ${fp.reported} | ${ids.size ? [...ids].map((i) => `\`${i}\``).join(", ") : "—"} |`);
}
w();
w("Per conforming-build label:");
w();
w(`| Arm | ${["clean", "clean.terse-optionals", "clean.trailing-page", "clean.wide-ids", "clean.all-variants", "clean.jitter"].join(" | ")} |`);
w(`|---|${Array(6).fill("---").join("|")}|`);
for (const a of ARMS) {
  const fp = R.arms[a].false_positives.by_label;
  const cellFor = (label) => {
    const b = fp[label];
    return b ? `${b.oracle} / ${b.reported} (${b.traces})` : "—";
  };
  w(
    `| ${NAME[a]} | ${["clean", "clean.terse-optionals", "clean.trailing-page", "clean.wide-ids", "clean.all-variants", "clean.jitter"]
      .map(cellFor)
      .join(" | ")} |`,
  );
}
w();
w("Cells are `column-1 FP / column-2 FP (builds)`.");
w();
w("Every column-two false positive, by the check that produced it:");
w();
w("| Arm | check | rule | builds it failed on |");
w("|---|---|---|---|");
let anyFp = false;
for (const a of ARMS) {
  for (const check of Object.values(R.arms[a].false_positives.by_check)) {
    anyFp = true;
    w(
      `| ${NAME[a]} | \`${check.check_id}\` | ${check.rule ?? "—"} | ${check.builds} of ${R.arms[a].false_positives.conforming_builds} ` +
        `(${Object.entries(check.labels).map(([l, n]) => `${l}×${n}`).join(", ")}) |`,
    );
  }
}
if (!anyFp) w("| — | — | — | none |");
w();
w("`status-400-for-a-wrongly-typed-field` is **D2**, the verified clean-build");
w("defect in `ROUND-LOG.md`: the fixture answers `422 invalid_amount` to a");
w("wrongly-typed `amount` where statement §11 requires `400`. §6.3 says a real");
w("fixture defect found on a conforming build is a true positive, not a false");
w("positive, and the operator ruling that D2 is a defect predates this round. Both");
w("counts are therefore given and neither is adjudicated here:");
w();
w("| Arm | column-2 FP as the bench counts them | excluding the D2 check |");
w("|---|---|---|");
for (const a of ARMS) {
  w(`| ${R.arms[a].label} | ${R.arms[a].false_positives.reported} | ${R.arms[a].false_positives.reported_excluding_D2} |`);
}
w();

w("## 4.1 D1 at replay (the pagination tie-drop)");
w();
w("`ROUND-LOG.md` records D1 — a quiescent `GET /accounts?limit=1` walk dropping");
w("`acc_fee_eur` — as a genuine clean-build defect found during authoring and fixed");
w("publicly in `12cba1d`, and statements-trial 3 independently rediscovered it on");
w("its pre-fix authoring instance. Its check is");
w("`accounts-enumeration-is-complete`. At replay against the fixed build:");
w();
w(`| | |`);
w("|---|---|");
w(`| Builds the check ran on | ${d1.total} of 31 (every build in t3's round) |`);
w(`| Pass | ${d1.pass} |`);
w(`| Fail | ${d1.fail} — ${d1.fails.map((x) => `\`${x.replace(/^t3\./, "")}\``).join(", ")} |`);
w(`| Fail on any conforming build | ${d1.cleanFail} |`);
w();
w("It resolves green on all 17 conforming builds and on 13 of the 14 fault builds.");
w("Its one failure is on `f-include-closed-ignored`, a sealed fault that makes");
w("`?include_closed=true` filter closed accounts out — an incomplete enumeration by");
w("construction, so that failure is a detection, not a regression. Trial 3's");
w("authoring finding is therefore an authoring-time true positive that the fix");
w("closed, exactly as the round log predicted.");
w();
w("## 5. Cross-trial variance (statements-trials only)");
w();
const V = R.cross_trial_variance;
w(`- Column-two semantic detections per trial: ${Object.entries(V.column_two_semantic_per_trial).map(([k, v]) => `${k} ${v}/13`).join(" · ")}`);
w(`- Range ${V.min}–${V.max} (spread ${V.range}); mean ${V.mean}; sd ${V.sd}`);
w(`- Detected by all three: ${V.unanimous_detected.length ? V.unanimous_detected.map((f) => `\`${f}\``).join(", ") : "none"}`);
w(`- Missed by all three: ${V.unanimous_missed.length ? V.unanimous_missed.map((f) => `\`${f}\``).join(", ") : "none"}`);
w(`- Split (some trials only): ${V.split.length ? V.split.map((s) => `\`${s.fault}\` (${s.detected_by.join(", ")})`).join("; ") : "none"}`);
w();

w("## 6. CI-flake estimate from the jittered repeats");
w();
w("`LEDGER_JITTER_MS=250`, 10 repeats per arm (§5). An *outcome signature* is the");
w("arm's failing-check set, its oracle-violation set, and its request count on that");
w("build; a flake is any repeat whose signature differs from the others.");
w();
w("| Arm | jitter repeats | distinct signatures | canonical clean repeats | distinct | jitter ≡ canonical | flake rate |");
w("|---|---|---|---|---|---|---|");
for (const a of ARMS) {
  const f = R.arms[a].flake;
  w(
    `| ${R.arms[a].label} | ${f.jitter_repeats} | ${f.distinct_outcome_signatures} | ${f.canonical_repeats} | ` +
      `${f.canonical_distinct_signatures} | ${f.jitter_matches_canonical ? "yes" : "no"} | ${(f.flake_rate * 100).toFixed(1)} % |`,
  );
}
w();

w("## 7. Economics — what a replay actually costs");
w();
w("| Arm | builds | requests | wall clock | mean/build | canonical clean build | jittered build | model calls | $ |");
w("|---|---|---|---|---|---|---|---|---|");
for (const a of ARMS) {
  const e = R.economics.per_arm[a];
  w(
    `| ${R.arms[a].label} | ${e.builds} | ${e.requests_total} | ${(e.wall_ms_total / 1000).toFixed(1)} s | ` +
      `${(e.wall_ms_per_build_mean / 1000).toFixed(2)} s | ${(e.wall_ms_canonical_clean_mean / 1000).toFixed(2)} s | ` +
      `${(e.wall_ms_jitter_mean / 1000).toFixed(2)} s | 0 | $0.00 |`,
  );
}
const nonJitterRows = D.builds.filter((b) => b.label !== "clean.jitter");
const nonJitter = {
  builds: nonJitterRows.length,
  wall: nonJitterRows.reduce((t, b) => t + b.wall_ms, 0),
  requests: nonJitterRows.reduce((t, b) => t + b.requests, 0),
};
const er = R.economics.round;
w(
  `| **round** | **${er.builds}** | **${er.requests_total}** | **${(er.wall_ms_total / 1000).toFixed(1)} s** | ` +
    `${(er.wall_ms_total / er.builds / 1000).toFixed(2)} s | | | **0** | **$0.00** |`,
);
w();
w("Requests per build are inside the wire-enforced 360 ceiling on every build");
w("(§7.2): " +
  ARMS.map((a) => `${NAME[a]} ${R.economics.per_arm[a].requests_per_build_min}–${R.economics.per_arm[a].requests_per_build_max}`).join(", ") +
  ".");
w();
w("The jittered builds are the only slow ones, and the delay is the fixture's, not");
w("the suite's: `LEDGER_JITTER_MS=250` adds ~125 ms of server-side sleep per");
w("response. With the 40 jittered builds excluded, the other 84 builds of the round");
w(`cost **${(nonJitter.wall / 1000).toFixed(1)} s** of wall clock and`);
w(`**${nonJitter.requests}** requests in total — a mean of`);
w(`**${(nonJitter.wall / nonJitter.builds / 1000).toFixed(2)} s** per build:`);
w();
w("| Arm | non-jittered builds | requests | wall clock | mean/build |");
w("|---|---|---|---|---|");
for (const a of ARMS) {
  const rows = D.builds.filter((b) => b.arm === a && b.label !== "clean.jitter");
  const wall = rows.reduce((t, b) => t + b.wall_ms, 0);
  w(
    `| ${R.arms[a].label} | ${rows.length} | ${rows.reduce((t, b) => t + b.requests, 0)} | ` +
      `${(wall / 1000).toFixed(1)} s | ${(wall / rows.length / 1000).toFixed(2)} s |`,
  );
}
w();
w("That is the \"replay is free\" number: one authored suite, re-run against all 31");
w("builds of a round, with **zero model calls and zero dollars of inference**. The");
w("only per-round cost is CPU seconds, and there are fewer than twenty of them per");
w("arm once the deliberately-slowed jitter builds are set aside.");
w();

w("## 8. Isolation audit");
w();
w("The harness cannot prove it started its own fixture — a stale listener on the");
w("port would answer `/health` just as well — so every build's fixture log was");
w("read back and matched against the configuration its build id names.");
w();
const bad = D.builds.filter((b) => b.fixture_boot.address_in_use);
w(`- ${D.builds.length} builds; ${bad.length} with \`EADDRINUSE\` in the fixture log.`);
w(`- Every build's banner names exactly its own faults, variants and jitter (see \`builds-digest.json\`).`);
w("- Replay order: identical across all four arms, as §8.1 requires — the four");
w("  `order.<arm>.json` files carry the same 31-entry sequence under the same seed.");
w();

w("## 9. What is in this directory, and what is not");
w();
w("| File | What it is |");
w("|---|---|");
w("| `order.<arm>.json` | the seeded replay order, written before the first build ran |");
w("| `manifest.jsonl` | the append-only per-build row: status, exit, requests, wall time |");
w("| `builds-digest.json` | per build: the HAR's sha256 and byte count, the script report's sha256, the fixture's boot banner, and the report's counters |");
w("| `scores.round.json` / `.txt` | the bench's own output over all 124 builds, in one pass |");
w("| `RESULTS.json` | this file's tables, machine-readable |");
w("| `RESULTS.md` | this file |");
w("| `tools/` | the three offline scripts that produced `builds-digest.json`, `RESULTS.json` and this file from the round's artifacts |");
w();
w("**The raw HARs and the 124 per-build `script-report.json` files are not");
w("committed.** They are ~56 MB of run-local traffic recordings; `builds-digest.json`");
w("carries a sha256 of every one of them, so a re-run can be checked against this");
w("round byte for byte.");
w();

fs.writeFileSync(path.join(roundDir, "RESULTS.md"), `${out.join("\n")}\n`);
process.stdout.write(`wrote RESULTS.md (${out.length} lines)\n`);
