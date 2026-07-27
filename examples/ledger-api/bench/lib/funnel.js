// Column two and the five-stage funnel (DESIGN N10 / BUILD_PLAN S0 scope 4).
//
// Column one — *oracle-confirmed-in-traffic* — lives in `score.js` and is the
// P1 instrument unchanged. This module adds the second column,
// *reported-with-correct-evidence*, and the funnel that explains a miss:
//
//   1 obligation enumerated      the report shows the rule was considered
//   2 scenario executed          the traffic reached the state the fault lives in
//   3 fault manifested           the fault is visible in the traffic
//   4 assertion detected         a check failed, attributable to the fault
//   5 evidence correctly cited   the citation resolves in the HAR, on target
//
// The first false stage is the diagnosis: enumeration, reachability, assertion,
// or reporting. A stage the artifacts cannot answer is `null`, never `false` —
// "the probe arm shipped no structured report" is a different fact from "the
// suite never enumerated the rule", and conflating them would flatter or damn an
// arm for free.
//
// Everything here is a pure function of a recorded HAR plus a report file. No
// model call, no network, no clock.

import { route } from "./trace.js";
import { witnessFor, witnessSubjectIds } from "./witnesses.js";
import { exercisedTags, enumerationIsAnswerable, failingChecks, tagsMatch } from "./suite-report.js";

export const FUNNEL_STAGES = Object.freeze([
  "obligation_enumerated",
  "scenario_executed",
  "manifested_in_traffic",
  "assertion_detected",
  "evidence_correctly_cited",
]);

/** Which failure a `false` at each stage names. */
export const STAGE_DIAGNOSIS = Object.freeze({
  obligation_enumerated: "enumeration",
  scenario_executed: "reachability",
  manifested_in_traffic: "reachability",
  assertion_detected: "assertion",
  evidence_correctly_cited: "reporting",
});

/**
 * Resolve one citation against the recorded traffic.
 *
 * A citation is only useful if a human can follow it, so resolution is strict in
 * one specific way: when the citation *describes* the exchange as well as
 * addressing it, the description has to match. A report that cites entry 41 and
 * calls it `POST /transfers` when entry 41 is a health check has not cited
 * evidence — it has produced a plausible-looking reference, which is the
 * failure mode a model-authored report is most likely to have.
 */
export function resolveCitation(citation, trace) {
  const entryIds = trace.meta?.entry_ids ?? null;

  let index = null;
  let via = null;
  if (Number.isInteger(citation.index) && trace.exchanges[citation.index]) {
    index = citation.index;
    via = "index";
  } else if (citation.entry_id && Array.isArray(entryIds)) {
    const position = entryIds.indexOf(citation.entry_id);
    if (position >= 0) {
      index = position;
      via = "entry_id";
    }
  }
  if (index === null && citation.path) {
    const matches = trace.exchanges.filter(
      (exchange) =>
        exchange.path === citation.path &&
        (citation.method === null || exchange.method === citation.method) &&
        (citation.status === null || exchange.status === citation.status),
    );
    const pick = citation.ordinal !== null ? matches[citation.ordinal] : matches.length === 1 ? matches[0] : null;
    if (pick) {
      index = pick.index;
      via = citation.ordinal !== null ? "descriptor+ordinal" : "descriptor";
    } else if (matches.length > 1) {
      return { resolved: false, index: null, via: "descriptor", reason: `${matches.length} entries match the description` };
    }
  }
  if (index === null) {
    return { resolved: false, index: null, via: null, reason: "no HAR entry matches the citation" };
  }

  const exchange = trace.exchanges[index];
  const mismatch = [];
  if (via !== "descriptor" && via !== "descriptor+ordinal") {
    if (citation.method && citation.method !== exchange.method) mismatch.push(`method ${citation.method} ≠ ${exchange.method}`);
    if (citation.path && citation.path !== exchange.path) mismatch.push(`path ${citation.path} ≠ ${exchange.path}`);
    if (citation.status !== null && citation.status !== exchange.status) {
      mismatch.push(`status ${citation.status} ≠ ${exchange.status}`);
    }
  }
  if (mismatch.length) {
    return { resolved: false, index, via, reason: `citation describes a different exchange: ${mismatch.join(", ")}` };
  }
  return { resolved: true, index, via, reason: null, route: route(exchange).kind, exchange };
}

/**
 * Attribute a failing check to a labelled fault and grade its evidence.
 *
 * Attribution is deliberately generous — three independent bases, any of which
 * is enough — because a suite names rules in its own vocabulary and must not be
 * penalised for calling conservation "rule 1". Evidence correctness is where the
 * strictness lives.
 */
export function attributeCheck(check, { trace, fault, expectation, witnesses, oracles }) {
  const basis = [];
  const tags = [check.obligation, check.rule, check.category].filter(Boolean);
  if (oracles.some((oracle) => tags.some((tag) => tagsMatch(tag, oracle)))) basis.push("rule");

  const citations = check.evidence.entries.map((citation) => ({ citation, ...resolveCitation(citation, trace) }));
  const resolved = citations.filter((item) => item.resolved);
  const routes = [...new Set(resolved.map((item) => item.route))];
  const onRoute = expectation ? routes.some((kind) => expectation.routes.includes(kind)) : false;
  if (onRoute) basis.push("route");

  const witnessIndices = new Set(witnesses.map((item) => item.index));
  const onWitness = resolved.some((item) => witnessIndices.has(item.index));
  const subjectIds = witnessSubjectIds(witnesses);
  const namesSubject = subjectIds.length > 0 && check.named_ids.some((id) => subjectIds.includes(id));
  if (onWitness || namesSubject) basis.push("subject");

  return {
    check_id: check.id,
    rule: check.rule,
    attribution: basis,
    attributed: basis.length > 0,
    citations: citations.map(({ citation, resolved: ok, index, via, reason, route: kind }) => ({
      cited: citation,
      resolved: ok,
      index,
      via,
      route: kind ?? null,
      reason,
    })),
    citations_total: citations.length,
    citations_resolved: resolved.length,
    evidence_resolvable: resolved.length > 0,
    on_route: onRoute,
    on_witness: onWitness,
    names_subject: namesSubject,
    // The scoring rule the preregistration names: a report counts as correctly
    // evidenced when at least one cited entry resolves in the HAR *and* the
    // citation lands on the fault — by route, or by naming the resource the
    // manifestation is about. `on_witness` alone is reported as the stricter
    // variant so a report can present both numbers.
    evidence_correct: resolved.length > 0 && (onRoute || onWitness || namesSubject),
    evidence_strict: onWitness,
  };
}

const stagesFrom = (values) => Object.fromEntries(FUNNEL_STAGES.map((stage, index) => [stage, values[index]]));

/**
 * Score one trace's second column and funnel.
 *
 * `report` may be null (no structured report accompanied the trace), in which
 * case stages 1, 4 and 5 are `null` and the column is `null` — not a miss.
 */
export function scoreFunnel({ trace, fault, expectation, facts, violations, report }) {
  const witness = witnessFor(fault, { trace, facts, violations });

  const enumerated = report
    ? enumerationIsAnswerable(report)
      ? exercisedTags(report).some((tag) => witness.oracles.some((oracle) => tagsMatch(tag, oracle)))
      : null
    : null;

  const attributions = report
    ? failingChecks(report).map((check) =>
        attributeCheck(check, {
          trace,
          fault,
          expectation,
          witnesses: witness.witnesses,
          oracles: witness.oracles,
        }),
      )
    : [];
  const attributed = attributions.filter((item) => item.attributed);
  const credited = attributed.filter((item) => item.evidence_correct);

  const stages = stagesFrom([
    enumerated,
    witness.known ? witness.reached : null,
    witness.known ? witness.witnesses.length > 0 : null,
    report ? attributed.length > 0 : null,
    report ? credited.length > 0 : null,
  ]);

  const firstFalse = FUNNEL_STAGES.find((stage) => stages[stage] === false);
  const firstUnknown = FUNNEL_STAGES.find((stage) => stages[stage] === null);

  return {
    columns: {
      // Column one is filled in by `score.js`; this is column two.
      reported_with_evidence: report ? credited.length > 0 : null,
      reported_with_evidence_strict: report ? attributed.some((item) => item.evidence_strict) : null,
      reported_without_evidence: report ? attributed.length > 0 && credited.length === 0 : null,
    },
    funnel: {
      stages,
      diagnosis: firstFalse ? STAGE_DIAGNOSIS[firstFalse] : firstUnknown ? "indeterminate" : "none",
      first_false: firstFalse ?? null,
      first_unknown: firstUnknown ?? null,
    },
    witness: {
      known: witness.known,
      reached: witness.reached,
      manifestations: witness.witnesses.length,
      subject_ids: witnessSubjectIds(witness.witnesses),
      exchanges: witness.witnesses.slice(0, 5),
      oracles: witness.oracles,
    },
    attributions,
  };
}

/**
 * A failing check on a build with no fault enabled is a second-column false
 * positive: the suite encoded an implementation detail rather than the contract.
 * This is what makes the conforming-variant builds scorable (DESIGN §7).
 */
export function reportedFalsePositives({ trace, report }) {
  if (!report) return { total: 0, checks: [] };
  const checks = failingChecks(report).map((check) => {
    const citations = check.evidence.entries.map((citation) => resolveCitation(citation, trace));
    return {
      check_id: check.id,
      rule: check.rule,
      title: check.title,
      observed: check.observed,
      citations_resolved: citations.filter((item) => item.resolved).length,
      citations_total: citations.length,
      routes: [...new Set(citations.filter((item) => item.resolved).map((item) => item.route))],
    };
  });
  return { total: checks.length, checks };
}
