// Deterministic oracles over a normalized trace.
//
// These are the same rules a Playtest custom assertion would evaluate in the
// gate (DESIGN §4: "all arms' traces are scored by the same deterministic
// oracles"), implemented once here so the probe, Schemathesis, and an
// agent-authored suite are judged identically. There is no model call, no
// network, and no clock: `scoreTrace(trace)` is a pure function of the trace.
//
// Every oracle carries an explicit applicability rule. A trace that never
// reaches the state a rule talks about is reported as *not applicable* — never
// as a pass and never as a violation — because a vacuous pass would flatter
// whichever arm explored least.

import { route, isOk, isMutation } from "./trace.js";

/** The invariants of DESIGN §6.2, one oracle each. */
export const ORACLES = Object.freeze([
  { id: "protocol", invariant: "no unexpected server error" },
  { id: "error_shape", invariant: "error-shape consistency" },
  { id: "conservation", invariant: "settled transfer entries sum to zero" },
  { id: "idempotency", invariant: "one key, one ledger effect" },
  { id: "lifecycle", invariant: "lifecycle legality" },
  { id: "pagination", invariant: "pagination identity" },
  { id: "balance_agreement", invariant: "derived balance equals stored balance" },
]);

export const ORACLE_IDS = ORACLES.map((oracle) => oracle.id);

const cite = (exchange, note) => ({
  index: exchange.index,
  method: exchange.method,
  path: exchange.path,
  status: exchange.status,
  ...(note ? { note } : {}),
});

function violation({ oracle, code, message, exchange, supporting = [], subject = {} }) {
  return {
    oracle,
    code,
    message,
    evidence: { request: cite(exchange), supporting, subject },
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const looksTruncated = (text) => typeof text === "string" && text.includes("[truncated]");

/**
 * One ordered pass over the trace, building the model the oracles need and
 * emitting the order-sensitive violations (lifecycle, idempotency divergence,
 * pagination identity) as it goes.
 */
function analyze(exchanges) {
  const facts = {
    resetIndices: [],
    accounts: new Map(), // id -> { status, index }
    transfers: new Map(), // id -> { status, index, source, destination }
    createdTransferIds: new Set(),
    entries: new Map(), // entryId -> { entry, index }
    idempotency: new Map(), // key -> [{ index, fingerprint, transferId }]
    enumerations: [],
    balanceReads: [],
    mutationIndices: [],
    transferCreateSeen: false,
    cancelSeen: false,
    closeSeen: false,
    violations: [],
  };
  const openEnumerations = new Map(); // accountId -> enumeration

  const noteAccount = (id, status, index) => {
    if (typeof id === "string" && typeof status === "string") facts.accounts.set(id, { status, index });
  };
  const noteTransfer = (transfer, index) => {
    if (!transfer || typeof transfer.id !== "string") return;
    facts.transfers.set(transfer.id, {
      status: transfer.status,
      index,
      source: transfer.source_account_id,
      destination: transfer.destination_account_id,
      amount: transfer.amount,
      fee: transfer.fee,
    });
  };

  for (const exchange of exchanges) {
    const target = route(exchange);
    const body = exchange.responseJson;

    if (isOk(exchange) && isMutation(exchange)) facts.mutationIndices.push(exchange.index);

    switch (target.kind) {
      case "admin_reset": {
        if (!isOk(exchange)) break;
        // A reset wipes the world, so every model fact before it is void.
        facts.resetIndices.push(exchange.index);
        facts.accounts.clear();
        facts.transfers.clear();
        facts.createdTransferIds.clear();
        facts.entries.clear();
        facts.idempotency.clear();
        openEnumerations.clear();
        break;
      }
      case "admin_tick": {
        if (!isOk(exchange) || !body) break;
        for (const id of body.settled ?? []) {
          const known = facts.transfers.get(id) ?? {};
          facts.transfers.set(id, { ...known, status: "settled", index: exchange.index });
        }
        for (const id of body.failed ?? []) {
          const known = facts.transfers.get(id) ?? {};
          facts.transfers.set(id, { ...known, status: "failed", index: exchange.index });
        }
        break;
      }
      case "accounts_create": {
        if (isOk(exchange) && body?.id) noteAccount(body.id, body.status, exchange.index);
        break;
      }
      case "accounts_list": {
        if (isOk(exchange) && Array.isArray(body?.items)) {
          for (const account of body.items) noteAccount(account?.id, account?.status, exchange.index);
        }
        break;
      }
      case "account_get": {
        if (isOk(exchange) && body?.id) {
          noteAccount(body.id, body.status, exchange.index);
          if (Number.isFinite(body.balance)) {
            facts.balanceReads.push({ accountId: body.id, index: exchange.index, balance: body.balance, exchange });
          }
        } else if (exchange.status === 410 && target.accountId) {
          noteAccount(target.accountId, "closed", exchange.index);
        }
        break;
      }
      case "account_activate": {
        if (isOk(exchange) && body?.id) noteAccount(body.id, body.status, exchange.index);
        break;
      }
      case "account_close": {
        facts.closeSeen = true;
        if (isOk(exchange)) {
          const pending = [...facts.transfers.entries()].filter(
            ([, transfer]) =>
              transfer.status === "pending" &&
              (transfer.source === target.accountId || transfer.destination === target.accountId),
          );
          if (pending.length) {
            facts.violations.push(
              violation({
                oracle: "lifecycle",
                code: "close_with_pending_transfers",
                message: `account ${target.accountId} was closed while transfer ${pending[0][0]} was still pending`,
                exchange,
                supporting: pending.slice(0, 3).map(([id, transfer]) => ({
                  index: transfer.index,
                  note: `transfer ${id} last observed pending here`,
                })),
                subject: { account_id: target.accountId, transfer_ids: pending.map(([id]) => id) },
              }),
            );
          }
          noteAccount(target.accountId, "closed", exchange.index);
        }
        break;
      }
      case "account_entries": {
        if (!isOk(exchange) || !Array.isArray(body?.items)) break;
        const accountId = target.accountId;
        const cursor = exchange.query.get("cursor");
        let enumeration = openEnumerations.get(accountId);
        if (!cursor) {
          enumeration = {
            accountId,
            startIndex: exchange.index,
            endIndex: exchange.index,
            anchored: true,
            complete: false,
            nextCursor: null,
            seen: new Map(), // entryId -> page index
            items: new Map(), // entryId -> entry
          };
          facts.enumerations.push(enumeration);
          openEnumerations.set(accountId, enumeration);
        } else if (!enumeration || enumeration.nextCursor !== cursor) {
          // A cursor we did not hand out (a resumed or fabricated enumeration):
          // tracked, but not scored for pagination identity.
          enumeration = {
            accountId,
            startIndex: exchange.index,
            endIndex: exchange.index,
            anchored: false,
            complete: false,
            nextCursor: null,
            seen: new Map(),
            items: new Map(),
          };
          facts.enumerations.push(enumeration);
          openEnumerations.set(accountId, enumeration);
        }

        for (const entry of body.items) {
          if (!entry || typeof entry.id !== "string") continue;
          if (!facts.entries.has(entry.id)) {
            facts.entries.set(entry.id, {
              entry,
              index: exchange.index,
              cite: cite(exchange, "entry observed in this response"),
            });
          }
          if (enumeration.anchored && enumeration.seen.has(entry.id)) {
            facts.violations.push(
              violation({
                oracle: "pagination",
                code: "duplicate_entry_in_enumeration",
                message: `entry ${entry.id} was returned twice while enumerating ${accountId}`,
                exchange,
                supporting: [
                  { index: enumeration.seen.get(entry.id), note: `first returned on this page` },
                  { index: enumeration.startIndex, note: "enumeration started here" },
                ],
                subject: { account_id: accountId, entry_id: entry.id },
              }),
            );
          }
          enumeration.seen.set(entry.id, exchange.index);
          enumeration.items.set(entry.id, entry);
        }
        enumeration.endIndex = exchange.index;
        enumeration.nextCursor = body.next_cursor ?? null;
        if (!enumeration.nextCursor) {
          enumeration.complete = true;
          openEnumerations.delete(accountId);
        }
        break;
      }
      case "transfers_create": {
        facts.transferCreateSeen = true;
        const request = exchange.requestJson ?? {};
        const key = exchange.requestHeaders["idempotency-key"];
        if (isOk(exchange)) {
          for (const role of ["source_account_id", "destination_account_id"]) {
            const accountId = request[role] ?? body?.[role];
            const known = accountId ? facts.accounts.get(accountId) : null;
            if (!known) continue;
            if (known.status === "closed") {
              facts.violations.push(
                violation({
                  oracle: "lifecycle",
                  code: "transfer_on_closed_account",
                  message: `transfer accepted against closed account ${accountId}`,
                  exchange,
                  supporting: [{ index: known.index, note: `account ${accountId} observed closed here` }],
                  subject: { account_id: accountId, role, transfer_id: body?.id ?? null },
                }),
              );
            } else if (known.status === "pending") {
              facts.violations.push(
                violation({
                  oracle: "lifecycle",
                  code: "transfer_on_inactive_account",
                  message: `transfer accepted against never-activated account ${accountId}`,
                  exchange,
                  supporting: [{ index: known.index, note: `account ${accountId} observed pending here` }],
                  subject: { account_id: accountId, role, transfer_id: body?.id ?? null },
                }),
              );
            }
          }
          if (body?.id) {
            facts.createdTransferIds.add(body.id);
            noteTransfer({ ...body, ...request }, exchange.index);
          }
        }
        if (key) {
          const fingerprint = canonical(exchange.requestJson);
          // The invariant is scoped "per authenticated principal", and the
          // service scopes its own idempotency records the same way. Two
          // principals may therefore use the same key for different transfers
          // without violating anything — so the oracle keys on the credential
          // as well. Keying on the bare header value keeps this opaque and
          // general: same credential, same principal, no token semantics.
          const principal = exchange.requestHeaders["authorization"] ?? "(anonymous)";
          const scoped = `${principal} ${key}`;
          const history = facts.idempotency.get(scoped) ?? [];
          const twin = history.find((record) => record.fingerprint === fingerprint && record.transferId);
          if (twin && isOk(exchange) && body?.id && body.id !== twin.transferId) {
            facts.violations.push(
              violation({
                oracle: "idempotency",
                code: "idempotency_key_diverged",
                message: `Idempotency-Key "${key}" with an identical body produced a second transfer`,
                exchange,
                supporting: [{ index: twin.index, note: `first use returned ${twin.transferId}` }],
                subject: { idempotency_key: key, transfer_ids: [twin.transferId, body.id] },
              }),
            );
          }
          history.push({ index: exchange.index, fingerprint, transferId: isOk(exchange) ? (body?.id ?? null) : null });
          facts.idempotency.set(scoped, history);
        }
        break;
      }
      case "transfer_get": {
        if (isOk(exchange) && body?.id) noteTransfer(body, exchange.index);
        break;
      }
      case "transfers_list": {
        if (isOk(exchange) && Array.isArray(body?.items)) {
          for (const transfer of body.items) noteTransfer(transfer, exchange.index);
        }
        break;
      }
      case "transfer_cancel": {
        facts.cancelSeen = true;
        const known = facts.transfers.get(target.transferId);
        if (isOk(exchange) && known && (known.status === "settled" || known.status === "failed")) {
          facts.violations.push(
            violation({
              oracle: "lifecycle",
              code: "cancel_after_settlement",
              message: `transfer ${target.transferId} was canceled after it had already ${known.status}`,
              exchange,
              supporting: [{ index: known.index, note: `observed ${known.status} here` }],
              subject: { transfer_id: target.transferId, prior_status: known.status },
            }),
          );
        }
        if (isOk(exchange) && body?.id) noteTransfer(body, exchange.index);
        break;
      }
      default:
        break;
    }
  }

  return facts;
}

/** No 5xx anywhere. Applicable to any trace with a completed response. */
function protocolOracle(exchanges) {
  const violations = [];
  for (const exchange of exchanges) {
    if (exchange.status >= 500) {
      violations.push(
        violation({
          oracle: "protocol",
          code: "unexpected_server_error",
          message: `${exchange.method} ${exchange.path} answered ${exchange.status}`,
          exchange,
          subject: { status: exchange.status, body: exchange.responseBody?.slice(0, 200) ?? null },
        }),
      );
    }
  }
  const applicable = exchanges.some((exchange) => exchange.status > 0);
  return { violations, applicable };
}

/**
 * Every 4xx/5xx body is the declared envelope, and a refusal is never dressed
 * up as a 2xx.
 */
function errorShapeOracle(exchanges) {
  const violations = [];
  let applicable = false;
  for (const exchange of exchanges) {
    if (exchange.status >= 400) {
      applicable = true;
      const body = exchange.responseJson;
      if (body === null) {
        if (!exchange.responseBody || looksTruncated(exchange.responseBody)) continue; // no evidence to judge
        violations.push(
          violation({
            oracle: "error_shape",
            code: "error_envelope_violation",
            message: `${exchange.status} response body is not JSON`,
            exchange,
            subject: { body: exchange.responseBody.slice(0, 200) },
          }),
        );
        continue;
      }
      const error = body.error;
      const keys = Object.keys(body);
      const shaped =
        keys.length === 1 &&
        keys[0] === "error" &&
        error &&
        typeof error === "object" &&
        typeof error.code === "string" &&
        typeof error.message === "string" &&
        Object.keys(error).every((key) => ["code", "message", "details"].includes(key));
      if (!shaped) {
        violations.push(
          violation({
            oracle: "error_shape",
            code: "error_envelope_violation",
            message: `${exchange.status} response does not match {error:{code,message,details?}}`,
            exchange,
            subject: { body: exchange.responseBody?.slice(0, 200) ?? null },
          }),
        );
      }
      continue;
    }

    const target = route(exchange);
    if (target.kind === "transfers_create" && isOk(exchange)) {
      applicable = true;
      const body = exchange.responseJson;
      if (body && body.status === "failed") {
        violations.push(
          violation({
            oracle: "error_shape",
            code: "failure_masked_as_2xx",
            message: `POST /transfers refused the request but answered ${exchange.status} with status "failed"`,
            exchange,
            subject: {
              transfer_id: body.id ?? null,
              failure_reason: body.failure_reason ?? null,
              status: exchange.status,
            },
          }),
        );
      }
    }
  }
  return { violations, applicable };
}

/** Settled transfer entries — debit, credit, fee — sum to zero. */
function conservationOracle(facts) {
  const groups = new Map();
  for (const sighting of facts.entries.values()) {
    const { entry } = sighting;
    if (!entry.transfer_id) continue; // deposits are the declared exception
    if (!groups.has(entry.transfer_id)) groups.set(entry.transfer_id, []);
    groups.get(entry.transfer_id).push(sighting);
  }
  const violations = [];
  let applicable = false;
  for (const [transferId, rows] of groups) {
    const kinds = new Set(rows.map(({ entry }) => entry.kind));
    // Applicability: only a fully observed settlement can be judged.
    if (!(kinds.has("transfer_debit") && kinds.has("transfer_credit") && kinds.has("fee"))) continue;
    applicable = true;
    const sum = rows.reduce((total, { entry }) => total + entry.amount, 0);
    if (sum !== 0) {
      const first = rows[0];
      violations.push({
        oracle: "conservation",
        code: "transfer_entries_nonzero",
        message: `the ledger entries for transfer ${transferId} sum to ${sum}, not 0`,
        evidence: {
          request: first.cite,
          supporting: rows.map(({ entry, index }) => ({
            index,
            note: `${entry.id} ${entry.kind} ${entry.amount} on ${entry.account_id}`,
          })),
          subject: { transfer_id: transferId, sum, entry_ids: rows.map(({ entry }) => entry.id) },
        },
      });
    }
  }
  return { violations, applicable };
}

/**
 * One key, one effect. Divergent replays are caught in the walk; here we catch
 * the harder case — a ledger effect belonging to a transfer the client never
 * created.
 */
function idempotencyOracle(facts) {
  const violations = [];
  const anchored = facts.resetIndices.length > 0;
  const transferEntries = [...facts.entries.values()].filter((sighting) => sighting.entry.transfer_id);
  const applicable =
    facts.idempotency.size > 0 || (anchored && transferEntries.length > 0 && facts.transferCreateSeen);
  if (anchored) {
    const reported = new Set();
    for (const sighting of transferEntries) {
      const { entry } = sighting;
      if (facts.createdTransferIds.has(entry.transfer_id)) continue;
      if (reported.has(entry.transfer_id)) continue;
      reported.add(entry.transfer_id);
      violations.push({
        oracle: "idempotency",
        code: "phantom_ledger_effect",
        message: `ledger entry ${entry.id} belongs to transfer ${entry.transfer_id}, which this trace never created`,
        evidence: {
          request: sighting.cite,
          supporting: [{ index: facts.resetIndices[facts.resetIndices.length - 1], note: "state reset here" }],
          subject: {
            transfer_id: entry.transfer_id,
            entry_id: entry.id,
            account_id: entry.account_id,
            amount: entry.amount,
          },
        },
      });
    }
  }
  return { violations: [...violations], applicable };
}

/** Stored balance equals the sum of a completely enumerated account's entries. */
function balanceOracle(facts) {
  const violations = [];
  let applicable = false;
  const seen = new Set();
  for (const enumeration of facts.enumerations) {
    if (!enumeration.anchored || !enumeration.complete) continue;
    for (const read of facts.balanceReads) {
      if (read.accountId !== enumeration.accountId) continue;
      const lo = Math.min(enumeration.startIndex, read.index);
      const hi = Math.max(enumeration.endIndex, read.index);
      // Applicability: the two observations must describe the same state.
      if (facts.mutationIndices.some((index) => index >= lo && index <= hi)) continue;
      const key = `${enumeration.accountId}:${enumeration.startIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      applicable = true;
      const derived = [...enumeration.items.values()].reduce((total, entry) => total + entry.amount, 0);
      if (derived !== read.balance) {
        violations.push({
          oracle: "balance_agreement",
          code: "stored_balance_diverged",
          message: `account ${read.accountId} reports balance ${read.balance} but its ${enumeration.items.size} entries sum to ${derived}`,
          evidence: {
            request: cite(read.exchange, "balance read here"),
            supporting: [
              { index: enumeration.startIndex, note: "entry enumeration started here" },
              { index: enumeration.endIndex, note: "entry enumeration completed here" },
            ],
            subject: {
              account_id: read.accountId,
              stored: read.balance,
              derived,
              entry_ids: [...enumeration.items.keys()],
            },
          },
        });
      }
    }
  }
  return { violations, applicable };
}

/**
 * Score one trace. Returns violations grouped with per-oracle applicability so
 * a caller can tell "held" from "never exercised".
 */
export function scoreTrace(trace) {
  const facts = analyze(trace.exchanges);
  const results = {
    protocol: protocolOracle(trace.exchanges),
    error_shape: errorShapeOracle(trace.exchanges),
    conservation: conservationOracle(facts),
    idempotency: idempotencyOracle(facts),
    lifecycle: {
      violations: [],
      applicable: facts.transferCreateSeen || facts.cancelSeen || facts.closeSeen,
    },
    pagination: {
      violations: [],
      applicable: facts.enumerations.some((enumeration) => enumeration.anchored && enumeration.seen.size > 0),
    },
    balance_agreement: balanceOracle(facts),
  };

  // Order-sensitive violations were collected during the walk; route them to
  // their oracle so applicability and violations stay consistent.
  for (const found of facts.violations) {
    results[found.oracle].violations.push(found);
    results[found.oracle].applicable = true;
  }

  const violations = ORACLE_IDS.flatMap((id) => results[id].violations).sort(
    (a, b) => (a.evidence.request.index ?? 0) - (b.evidence.request.index ?? 0),
  );
  const applicability = Object.fromEntries(ORACLE_IDS.map((id) => [id, results[id].applicable === true]));

  return { violations, applicability, facts };
}
