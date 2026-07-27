// PORTED (S1 substrate parity). The P1 arm collected violations, setup failures
// and warnings into its own structure and printed them. Under the script
// contract those three things already have channels — a failing check, a script
// defect, and an advisory — so this file keeps the arm's collection and dedupe
// behaviour verbatim and adds one thing: `finalize`, which turns the collection
// into report records.
//
// Two rules make the translation faithful:
//
//   * one failing check per DISTINCT violation, citing the HAR entries the arm
//     already recorded as its evidence — the report column says exactly what the
//     arm said, with machine evidence attached;
//   * one passing check per rule that produced no violation, so every rule
//     obligation is accounted for. A rule the suite exercised and did not break
//     is a covered obligation, not a silent one.

export const RULES = {
  conservation: '1 conservation',
  idempotency: '2 idempotency',
  lifecycle: '3 lifecycle legality',
  pagination: '4 pagination identity',
  errorshape: '5 error shape / no 5xx',
  balance: '6 balance agreement',
  // Not one of the six. Used when the service accepts something its own
  // OpenAPI document says it refuses — a real defect, reported honestly as
  // outside the invariant set rather than filed under a rule it does not break.
  contract: '— contract (a documented refusal did not happen)',
};

const MAX_EVIDENCE_PER_KEY = 3;

const slug = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);

export function createReport() {
  const violations = new Map(); // dedupe key -> record
  const setupFailures = [];
  const warnings = new Map();
  let currentScenario = 'startup';

  return {
    get scenario() {
      return currentScenario;
    },
    enterScenario(name) {
      currentScenario = name;
    },
    /**
     * Record a counterexample.
     * @param {string} rule       key of RULES
     * @param {string} title      short, stable description (used for dedupe)
     * @param {object} info       { expected, observed, dedupe, requests: [logEntry] }
     */
    violation(rule, title, info = {}) {
      const key = `${rule}::${title}::${info.dedupe ?? ''}`;
      let rec = violations.get(key);
      if (!rec) {
        rec = {
          key,
          rule,
          title,
          dedupe: info.dedupe ?? '',
          scenario: currentScenario,
          expected: info.expected,
          observed: info.observed,
          occurrences: 0,
          evidence: [],
        };
        violations.set(key, rec);
      }
      rec.occurrences += 1;
      if (rec.evidence.length < MAX_EVIDENCE_PER_KEY) {
        rec.evidence.push({
          expected: info.expected,
          observed: info.observed,
          requests: info.requests ?? [],
          note: info.note,
        });
      }
      return rec;
    },
    warn(title, detail) {
      const rec = warnings.get(title) ?? { title, detail, count: 0 };
      rec.count += 1;
      warnings.set(title, rec);
    },
    setupFailure(scenario, message, requests = []) {
      setupFailures.push({ scenario, message, requests });
    },
    get violations() {
      return [...violations.values()];
    },
    get setupFailures() {
      return setupFailures;
    },
    get warnings() {
      return [...warnings.values()];
    },
    get failed() {
      return violations.size > 0 || setupFailures.length > 0;
    },

    /** Emit the collection into the harness's report channels. */
    finalize(check, { exercised = Object.keys(RULES) } = {}) {
      const broken = new Set();
      for (const rec of violations.values()) {
        broken.add(rec.rule);
        const refs = [];
        for (const ev of rec.evidence) {
          for (const request of ev.requests ?? []) {
            if (Number.isInteger(request?.ref) && !refs.includes(request.ref)) refs.push(request.ref);
          }
        }
        check({
          // The arm's dedupe key is part of the identity: two violations of the
          // same rule with the same title but different subjects are two checks.
          id: `${rec.rule}-${slug(rec.title)}${rec.dedupe ? `-${slug(rec.dedupe)}` : ''}`,
          obligation: `rule:${rec.rule}`,
          title: `${RULES[rec.rule] ?? rec.rule}: ${rec.title}`,
          pass: false,
          expected: rec.evidence[0]?.expected ?? rec.expected,
          observed: rec.evidence[0]?.observed ?? rec.observed,
          note: `scenario ${rec.scenario}${rec.occurrences > 1 ? `, ${rec.occurrences} occurrences` : ''}${
            rec.evidence[0]?.note ? ` — ${rec.evidence[0].note}` : ''
          }`,
          evidence: { requests: refs, subject: { scenario: rec.scenario, occurrences: rec.occurrences } },
        });
      }
      for (const rule of exercised) {
        if (broken.has(rule)) continue;
        check({
          id: `${rule}-held`,
          obligation: `rule:${rule}`,
          title: `${RULES[rule] ?? rule}: held against every state this suite reached`,
          pass: true,
          expected: RULES[rule] ?? rule,
          observed: 'no counterexample found',
        });
      }
      for (const failure of setupFailures) {
        check.defect({
          message: `${failure.scenario}: ${failure.message}`,
          evidence: { requests: (failure.requests ?? []).map((r) => r?.ref).filter(Number.isInteger).slice(0, 3) },
        });
      }
      for (const warning of warnings.values()) {
        check.advisory({ title: warning.title, detail: `${warning.detail}${warning.count > 1 ? ` (x${warning.count})` : ''}` });
      }
    },
  };
}
