// Assertion helpers shared by the scenarios.
//
// The distinction that matters: *not refusing* an illegal request is a rule
// violation; refusing it with a different 4xx code than the OpenAPI document
// advertises is only an advisory, because the invariant statements say
// "rejected", not "rejected with exactly this code".

export function expectRefused(report, rule, what, entry, { statuses = [], code, note } = {}) {
  if (entry.transportError) return false; // already reported by the client audit
  if (entry.status >= 200 && entry.status < 400) {
    report.violation(rule, what, {
      expected: `refused with ${statuses.length ? statuses.join('/') : '4xx'}${code ? ` ${code}` : ''}`,
      observed: `${entry.status} ${entry.responseText.slice(0, 300)}`,
      requests: [entry],
      note,
    });
    return false;
  }
  if (statuses.length && !statuses.includes(entry.status)) {
    report.warn(
      'refused with an undocumented status',
      `${entry.method} ${entry.path} -> ${entry.status} (${entry.json?.error?.code}); the OpenAPI document says ${statuses.join('/')}`,
    );
  } else if (code && entry.json?.error?.code !== code) {
    report.warn(
      'refused with an undocumented code',
      `${entry.method} ${entry.path} -> ${entry.status} ${entry.json?.error?.code}, expected ${code}`,
    );
  }
  return true;
}

export function expectStatus(report, rule, what, entry, statuses, extra = {}) {
  if (entry.transportError) return false;
  if (!statuses.includes(entry.status)) {
    report.violation(rule, what, {
      expected: `HTTP ${statuses.join('/')}`,
      observed: `${entry.status} ${entry.responseText.slice(0, 300)}`,
      requests: [entry],
      ...extra,
    });
    return false;
  }
  return true;
}

export function expectEqual(report, rule, what, actual, expected, info = {}) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    report.violation(rule, what, {
      expected: b,
      observed: a,
      ...info,
    });
    return false;
  }
  return true;
}

/** Count the transfers a given account is named in, for side-effect checks. */
export async function transferIdsFor(api, accountId) {
  const res = await api.listTransfers({ accountId });
  return { ids: res.items.map((t) => t.id), items: res.items, requests: res.requests };
}
