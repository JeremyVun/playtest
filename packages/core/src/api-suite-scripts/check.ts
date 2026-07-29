import type {
  CheckAdvisoryRecord,
  CheckDefectRecord,
  CheckEvidence,
  CheckRecord,
  CheckSkipRecord,
  CheckUnsupportedRecord,
  CheckVerdictRecord,
  DynamicValue,
} from "./types.ts";

// The `check` channel, as the SCRIPT sees it
// (docs/contracts/scripts.md#the-check-channel).
//
// Four record kinds, deliberately separate, because N5's soundness rule depends
// on telling them apart:
//
//   check(…)               a verdict about the API — pass or fail
//   check.skip(…)          an obligation deliberately not covered, with a reason
//   check.unsupported(…)   an obligation this substrate cannot express
//   check.defect(…)        the SCRIPT could not do its job (it could not build
//                          the state a check needed, its own expectation was
//                          unbuildable, …). Never a statement about the API.
//   check.advisory(…)      an observation that gates nothing
//
// Records are buffered synchronously and streamed to the parent piggybacked on
// the next request (and in full at exit), so a script killed mid-run still
// leaves the records it had made and the parent can prove the final report did
// not contradict them.
const text = (value: unknown): string | undefined => (value === undefined || value === null ? undefined : typeof value === "string" ? value : JSON.stringify(value));

function requireString(value: unknown, what: string, where: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${where} needs a non-empty ${what} (got ${JSON.stringify(value ?? null)})`);
  }
  return value.trim();
}

function normalizeEvidence(evidence: DynamicValue, where: string): CheckEvidence {
  if (evidence === undefined || evidence === null) return { requests: [] };
  if (typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new TypeError(`${where}: evidence must be an object like { requests: [ref], subject: {…} }`);
  }
  const raw = evidence.requests ?? [];
  const list = Array.isArray(raw) ? raw : [raw];
  const requests = list.map((ref) => {
    // A script may cite either the response object it holds or its bare ref.
    const value = ref && typeof ref === "object" ? ref.ref : ref;
    if (!Number.isInteger(value) || value < 0) {
      throw new TypeError(`${where}: evidence.requests entries are client response refs (got ${JSON.stringify(ref ?? null)})`);
    }
    return value as number;
  });
  const out: CheckEvidence = { requests };
  if (evidence.subject !== undefined) out.subject = evidence.subject;
  return out;
}

/**
 * @param {{ onRecord?: (record: object) => void }} [options]
 * @returns {{ check: Function, records: object[], drain: () => object[], all: () => object[] }}
 */
export function createCheckChannel({ onRecord = null }: { onRecord?: ((record: CheckRecord) => void) | null } = {}) {
  const records: CheckRecord[] = [];
  let cursor = 0;

  const push = <T extends CheckRecord>(record: Omit<T, "seq">): T => {
    const entry = { seq: records.length + 1, ...record } as T; // SAFETY: seq completes the record the caller just built
    records.push(entry);
    onRecord?.(entry);
    return entry;
  };

  function check(record: DynamicValue): CheckVerdictRecord {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new TypeError("check() takes a record object: { id, obligation, title, pass, expected, observed, evidence }");
    }
    const id = requireString(record.id, "id", "check()");
    const obligation = requireString(record.obligation, "obligation id", `check(${JSON.stringify(id)})`);
    if (typeof record.pass !== "boolean") {
      throw new TypeError(`check(${JSON.stringify(id)}) needs pass: true|false (got ${JSON.stringify(record.pass ?? null)})`);
    }
    return push<CheckVerdictRecord>({
      kind: "check",
      id,
      obligation,
      title: record.title === undefined ? id : requireString(record.title, "title", `check(${JSON.stringify(id)})`),
      pass: record.pass,
      exercised: record.exercised === undefined ? true : Boolean(record.exercised),
      expected: text(record.expected),
      observed: text(record.observed),
      note: text(record.note),
      evidence: normalizeEvidence(record.evidence, `check(${JSON.stringify(id)})`),
    });
  }

  check.skip = (record: DynamicValue): CheckSkipRecord =>
    push<CheckSkipRecord>({
      kind: "skip",
      obligation: requireString(record?.obligation, "obligation id", "check.skip()"),
      reason: requireString(record?.reason, "reason", "check.skip()"),
      ...(record?.id ? { id: requireString(record.id, "id", "check.skip()") } : {}),
    });

  check.unsupported = (record: DynamicValue): CheckUnsupportedRecord =>
    push<CheckUnsupportedRecord>({
      kind: "unsupported",
      obligation: requireString(record?.obligation, "obligation id", "check.unsupported()"),
      reason: requireString(record?.reason, "reason", "check.unsupported()"),
    });

  check.defect = (record: DynamicValue): CheckDefectRecord =>
    push<CheckDefectRecord>({
      kind: "defect",
      message: requireString(record?.message, "message", "check.defect()"),
      detail: text(record?.detail),
      ...(record?.obligation ? { obligation: String(record.obligation) } : {}),
      evidence: normalizeEvidence(record?.evidence, "check.defect()"),
    });

  check.advisory = (record: DynamicValue): CheckAdvisoryRecord =>
    push<CheckAdvisoryRecord>({
      kind: "advisory",
      title: requireString(record?.title, "title", "check.advisory()"),
      detail: text(record?.detail),
      evidence: normalizeEvidence(record?.evidence, "check.advisory()"),
    });

  return {
    check,
    records,
    /** Records not yet streamed to the parent. */
    drain(): CheckRecord[] {
      const slice = records.slice(cursor);
      cursor = records.length;
      return slice;
    },
    all(): CheckRecord[] {
      return records.slice();
    },
  };
}
