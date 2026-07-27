// Lifecycle legality — only active accounts transact, no close with pending
// transfers, no cancel after settlement. The oracle is the vendored bench oracle
// `lifecycle`; see ../../lib/oracle-gate.js and docs/contracts/engine.md.
import { oracleAssertion } from "../../lib/oracle-gate.js";

export default oracleAssertion([
  {
    key: "ledger_lifecycle_legality",
    oracle: "lifecycle",
    invariant:
      "Only active accounts transact; an account with pending transfers cannot be closed; a settled or failed transfer cannot be canceled.",
    needs:
      "at least one POST /transfers, POST /accounts/{id}/close, or POST /transfers/{id}/cancel in the trace, with the account and transfer states it depends on observed first (create / activate / close reads, or a tick result).",
  },
]);
