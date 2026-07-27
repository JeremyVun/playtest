// HTTP client: counts requests, logs them for evidence, times them out, and
// audits every single response against rule 5 (error envelope, no 5xx, no
// refusal smuggled inside a 2xx). Because the audit runs on every response the
// suite ever gets, rule 5 is exercised by all ~300 requests, not by the handful
// aimed at it.

const TOKENS = {
  customer: 'Bearer customer-token-dev',
  admin: 'Bearer admin-token-dev',
};

const ERROR_KEYS = new Set(['code', 'message', 'details']);

export class ScenarioAbort extends Error {
  constructor(message, requests = []) {
    super(message);
    this.name = 'ScenarioAbort';
    this.requests = requests;
  }
}

/** Thrown when the run hits its hard request ceiling; stops the whole suite. */
export class BudgetExhausted extends ScenarioAbort {
  constructor(message) {
    super(message);
    this.name = 'BudgetExhausted';
  }
}

export function createClient({ baseUrl, report, timeoutMs = 10000, maxRequests = 350 }) {
  const log = [];
  const acceptedDeposits = [];
  let count = 0;
  let transportErrors = 0;
  let unaccountedDeposits = 0;

  async function request(method, path, options = {}) {
    const {
      body,
      rawBody,
      principal = 'customer',
      headers = {},
      contentType = 'application/json',
      auditRefusalIn2xx = true,
    } = options;

    const requestHeaders = {};
    for (const [k, v] of Object.entries(headers)) requestHeaders[k.toLowerCase()] = v;
    const auth = TOKENS[principal] ?? (principal === 'none' || principal == null ? null : principal);
    if (auth) requestHeaders.authorization = auth;
    const payload = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
    if (payload !== undefined && contentType && !('content-type' in requestHeaders)) {
      requestHeaders['content-type'] = contentType;
    }

    if (count >= maxRequests) {
      throw new BudgetExhausted(
        `request budget exhausted at ${maxRequests} requests — a healthy build of this service needs far fewer, so the service is very likely handing back listings that never terminate`,
      );
    }

    count += 1;
    const entry = {
      index: count,
      scenario: report.scenario,
      method,
      path,
      principal: principal === 'customer' ? '' : principal,
      requestHeaders,
      requestBody: payload,
      status: null,
      responseHeaders: null,
      responseText: '',
      json: null,
      transportError: null,
      durationMs: 0,
    };
    log.push(entry);

    const started = Date.now();
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: requestHeaders,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
      const text = await res.text();
      entry.status = res.status;
      entry.responseHeaders = Object.fromEntries(res.headers);
      entry.responseText = text;
      try {
        entry.json = text === '' ? null : JSON.parse(text);
      } catch {
        entry.json = null;
        entry.parseError = true;
      }
    } catch (err) {
      entry.transportError = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : String(err?.message ?? err);
    }
    entry.durationMs = Date.now() - started;

    // Every deposit the service *accepted* is external money entering the
    // ledger, whoever asked for it and however odd the request was. Recording
    // acknowledged deposits here (rather than only the ones the suite meant to
    // make) keeps the whole-world conservation sum honest.
    if (method === 'POST' && entry.path.split('?')[0] === '/deposits') {
      if (entry.status >= 200 && entry.status < 300) {
        if (Number.isInteger(entry.json?.amount)) {
          acceptedDeposits.push({ id: entry.json.id, accountId: entry.json.account_id, amount: entry.json.amount, index: entry.index });
        } else {
          unaccountedDeposits += 1; // accepted, but the suite cannot tell for how much
        }
      } else if (entry.transportError) {
        unaccountedDeposits += 1; // may or may not have landed
      }
    }

    audit(entry, { auditRefusalIn2xx });
    return entry;
  }

  function audit(entry, { auditRefusalIn2xx }) {
    if (entry.transportError) {
      transportErrors += 1;
      report.violation('errorshape', 'the service failed to answer a request at all', {
        dedupe: entry.transportError.slice(0, 40),
        expected: 'an HTTP response (a refusal is fine, silence is not)',
        observed: entry.transportError,
        requests: [entry],
        note: 'a hang or a dropped connection is not one of the documented outcomes of any operation',
      });
      return;
    }

    const s = entry.status;

    if (s >= 500) {
      report.violation('errorshape', 'operation answered 5xx', {
        dedupe: `${entry.method} ${route(entry.path)} ${s}`,
        expected: 'no operation answers 5xx at all',
        observed: `${s} on ${entry.method} ${entry.path}`,
        requests: [entry],
      });
    }

    if (s >= 300 && s < 400) {
      report.warn('3xx response', `${entry.method} ${entry.path} -> ${s} (no operation documents a redirect)`);
    }

    if (s >= 400) {
      const problems = envelopeProblems(entry);
      for (const problem of problems) {
        report.violation('errorshape', `${s} body is not the documented error envelope: ${problem}`, {
          dedupe: `${problem}|${entry.method} ${route(entry.path)}`,
          expected: '{"error":{"code":<string>,"message":<string>,"details"?:<object>}} and nothing else',
          observed: `${s} ${entry.responseText.slice(0, 300)}`,
          requests: [entry],
        });
      }
      if (s === 401 && !entry.responseHeaders?.['www-authenticate']) {
        report.violation('errorshape', '401 without a WWW-Authenticate header', {
          dedupe: `${entry.method} ${route(entry.path)}`,
          expected: '401 responses additionally carry WWW-Authenticate',
          observed: `headers: ${JSON.stringify(entry.responseHeaders)}`,
          requests: [entry],
        });
      }
    }

    if (s >= 200 && s < 300 && auditRefusalIn2xx) {
      if (entry.parseError || entry.responseText === '') {
        report.violation('errorshape', entry.responseText === '' ? '2xx body is empty' : '2xx body is not JSON', {
          dedupe: `${entry.method} ${route(entry.path)}`,
          expected: 'every documented 2xx response of this API carries a JSON body',
          observed: entry.responseText === '' ? '(empty body)' : entry.responseText.slice(0, 200),
          requests: [entry],
        });
      } else if (entry.json && typeof entry.json === 'object') {
        const failureField = smuggledFailure(entry.json);
        if (failureField) {
          report.violation('errorshape', 'a refusal was reported inside a 2xx response', {
            dedupe: `${entry.method} ${route(entry.path)}|${failureField}`,
            expected: 'a refused request is answered with 4xx, never a 2xx carrying the failure',
            observed: `${s} ${entry.responseText.slice(0, 300)}`,
            requests: [entry],
          });
        }
      }
    }
  }

  return {
    request,
    get acceptedDeposits() {
      return acceptedDeposits;
    },
    /**
     * The whole-world money sum is only meaningful if every deposit the service
     * accepted is known to the suite. A request that never came back, or a
     * deposit acknowledged with an unreadable body, breaks that premise.
     */
    depositTotal(baseline = 0) {
      if (transportErrors > 0 || unaccountedDeposits > 0) return undefined;
      return baseline + acceptedDeposits.reduce((acc, d) => acc + d.amount, 0);
    },
    get transportErrors() {
      return transportErrors;
    },
    get count() {
      return count;
    },
    get log() {
      return log;
    },
    logSince(index) {
      return log.filter((e) => e.index > index);
    },
    scenarioRequests(name, limit = 40) {
      const all = log.filter((e) => e.scenario === name);
      return all.slice(-limit);
    },
  };
}

// Collapse ids out of a path so dedupe keys group by route, not by resource.
function route(path) {
  return path
    .split('?')[0]
    .replace(/acc_[0-9a-z_]+/g, '{accountId}')
    .replace(/tr_[0-9a-z]+/g, '{transferId}')
    .replace(/dep_[0-9a-z]+/g, '{depositId}');
}

function envelopeProblems(entry) {
  const problems = [];
  if (entry.responseText === '') return ['body is empty'];
  if (entry.parseError) return ['body is not JSON'];
  const b = entry.json;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return ['body is not a JSON object'];
  const keys = Object.keys(b);
  if (!keys.includes('error')) return ['no "error" member'];
  if (keys.length > 1) problems.push(`extra top-level members: ${keys.filter((k) => k !== 'error').join(',')}`);
  const e = b.error;
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return [...problems, 'error member is not an object'];
  if (typeof e.code !== 'string') problems.push(`error.code is ${describe(e.code)}, expected string`);
  else if (e.code === '') problems.push('error.code is empty');
  if (typeof e.message !== 'string') problems.push(`error.message is ${describe(e.message)}, expected string`);
  else if (e.message === '') problems.push('error.message is empty');
  if ('details' in e && (e.details === null || typeof e.details !== 'object' || Array.isArray(e.details))) {
    problems.push(`error.details is ${describe(e.details)}, expected object`);
  }
  const extra = Object.keys(e).filter((k) => !ERROR_KEYS.has(k));
  if (extra.length) problems.push(`extra error members: ${extra.join(',')}`);
  return problems;
}

// Generic smell test only. "status":"failed" is legitimate on a *read* of a
// transfer that failed at settlement, so status is checked per-operation in the
// scenarios (a freshly created transfer must be "pending"), not here.
function smuggledFailure(body) {
  if (Array.isArray(body)) return null;
  if ('error' in body) return 'error';
  if ('errors' in body) return 'errors';
  if (body.ok === false) return 'ok:false';
  return null;
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
