// Idempotency — one Idempotency-Key plus one body means one transfer and one
// ledger effect. The oracle is the vendored bench oracle `idempotency`; see
// ../../lib/oracle-gate.js and docs/contracts/engine.md.
import { oracleAssertion } from "../../lib/oracle-gate.js";

export default oracleAssertion([
  {
    key: "ledger_idempotency",
    oracle: "idempotency",
    invariant:
      "Two POST /transfers with the same Idempotency-Key and the same body produce exactly one transfer and exactly one set of ledger effects.",
    needs:
      "at least one POST /transfers carrying an Idempotency-Key header — and, for the phantom-effect half of the rule, a successful POST /admin/reset earlier in the same trace to anchor what 'created by this run' means.",
  },
]);
