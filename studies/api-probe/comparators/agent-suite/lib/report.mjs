// Violation collection and evidence rendering.
//
// A "violation" is a concrete counterexample to one of the six invariants. A
// "setup failure" is the suite being unable to reach the state it needed —
// still fatal (exit non-zero) but reported separately so a human can tell the
// difference between "the rule broke" and "the world would not build".

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
          rule,
          title,
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
  };
}

function truncate(value, max) {
  if (value == null) return String(value);
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s === undefined) return String(value);
  return s.length > max ? `${s.slice(0, max)}… [${s.length} bytes]` : s;
}

export function renderRequest(entry, { bodyMax = 400 } = {}) {
  const lines = [];
  const reqBody = entry.requestBody === undefined ? '' : ` ${truncate(entry.requestBody, bodyMax)}`;
  const hdr = Object.entries(entry.requestHeaders ?? {})
    .filter(([k]) => k !== 'authorization' && k !== 'content-type')
    .map(([k, v]) => `${k}: ${truncate(v, 80)}`)
    .join(', ');
  lines.push(
    `    #${entry.index} ${entry.method} ${entry.path}${entry.principal ? ` [as ${entry.principal}]` : ''}${
      hdr ? ` {${hdr}}` : ''
    }${reqBody}`,
  );
  if (entry.transportError) {
    lines.push(`        -> TRANSPORT ERROR after ${entry.durationMs}ms: ${entry.transportError}`);
  } else {
    const extra = entry.responseHeaders?.['www-authenticate']
      ? ` www-authenticate="${entry.responseHeaders['www-authenticate']}"`
      : entry.responseHeaders?.['idempotency-replayed']
        ? ` idempotency-replayed="${entry.responseHeaders['idempotency-replayed']}"`
        : '';
    lines.push(`        -> ${entry.status}${extra} ${truncate(entry.responseText, bodyMax + 200)}`);
  }
  return lines.join('\n');
}

/** One compact line per state-changing request, so a reader can rebuild the world. */
function mutationTrace(log, scenario) {
  return log
    .filter((e) => e.scenario === scenario && e.method !== 'GET')
    .map(
      (e) =>
        `    #${e.index} ${e.method} ${e.path}${e.principal ? ` [as ${e.principal}]` : ''}${
          e.requestHeaders?.['idempotency-key'] ? ` [key ${truncate(e.requestHeaders['idempotency-key'], 40)}]` : ''
        } ${truncate(e.requestBody ?? '', 160)} -> ${e.transportError ? 'no response' : e.status}${
          e.json?.id ? ` ${e.json.id}` : e.json?.error?.code ? ` ${e.json.error.code}` : ''
        }`,
    );
}

export function printReport(report, { requestCount, elapsedMs, baseUrl, scenarioLog, log = [] }) {
  const out = [];
  const rule = (k) => RULES[k] ?? k;
  const tracedScenarios = new Set();

  const MAX_PRINTED = Number(process.env.MAX_REPORTED || 20);
  if (report.violations.length) {
    out.push('');
    out.push('================ INVARIANT VIOLATIONS ================');
    const shown = report.violations.slice(0, MAX_PRINTED);
    if (report.violations.length > shown.length) {
      out.push(
        `(${report.violations.length} distinct violations; showing the first ${shown.length}. Set MAX_REPORTED to see more.)`,
      );
    }
    for (const v of shown) {
      out.push('');
      if (!tracedScenarios.has(v.scenario)) {
        tracedScenarios.add(v.scenario);
        const trace = mutationTrace(log, v.scenario);
        if (trace.length) {
          out.push(`--- how scenario "${v.scenario}" built its state (every state-changing request, in order) ---`);
          out.push(...trace.slice(0, 60));
          if (trace.length > 60) out.push(`    … ${trace.length - 60} more`);
          out.push('');
        }
      }
      out.push(`VIOLATION  rule ${rule(v.rule)}  —  ${v.title}`);
      out.push(`  scenario: ${v.scenario}`);
      if (v.occurrences > 1) out.push(`  occurrences: ${v.occurrences} (first ${v.evidence.length} shown)`);
      for (const ev of v.evidence) {
        if (ev.expected !== undefined) out.push(`  expected: ${truncate(ev.expected, 500)}`);
        if (ev.observed !== undefined) out.push(`  observed: ${truncate(ev.observed, 500)}`);
        if (ev.note) out.push(`  note: ${ev.note}`);
        if (ev.requests?.length) {
          out.push('  requests, in the order they were sent:');
          for (const entry of ev.requests) out.push(renderRequest(entry));
        }
        out.push('  --');
      }
    }
  }

  if (report.setupFailures.length) {
    out.push('');
    out.push('================ SETUP FAILURES ======================');
    out.push('(the suite could not reach the state a rule needed; the service did not');
    out.push(' behave the way its OpenAPI document says it does)');
    for (const f of report.setupFailures) {
      out.push('');
      out.push(`SETUP FAILURE  scenario ${f.scenario}: ${f.message}`);
      for (const entry of f.requests) out.push(renderRequest(entry));
    }
  }

  if (report.warnings.length) {
    out.push('');
    out.push('---------------- advisories (not rule violations) ----------------');
    for (const w of report.warnings) {
      out.push(`  ${w.title}${w.count > 1 ? ` (x${w.count})` : ''}: ${w.detail}`);
    }
  }

  out.push('');
  out.push('================ SUMMARY =============================');
  out.push(`base url:      ${baseUrl}`);
  out.push(`scenarios:     ${scenarioLog.map((s) => `${s.name}${s.ok ? '' : ' (FAILED)'}`).join(', ')}`);
  out.push(`http requests: ${requestCount}`);
  out.push(`wall time:     ${(elapsedMs / 1000).toFixed(2)}s`);
  if (report.failed) {
    const byRule = new Map();
    for (const v of report.violations) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
    const broken = [...byRule.entries()].map(([k, n]) => `${rule(k)} (${n})`).join('; ');
    out.push(`result:        FAIL — ${report.violations.length} violation(s)${broken ? `: ${broken}` : ''}${
      report.setupFailures.length ? `, ${report.setupFailures.length} setup failure(s)` : ''
    }`);
  } else {
    out.push('result:        PASS — all six invariants held against every state exercised');
  }
  console.log(out.join('\n'));
}
