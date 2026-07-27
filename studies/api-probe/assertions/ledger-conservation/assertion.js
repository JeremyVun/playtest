// Conservation — a settled transfer's ledger entries sum to zero.
// The oracle is the vendored bench oracle `conservation`; see
// ../../lib/oracle-gate.js and docs/contracts/engine.md.
import { oracleAssertion } from "../../lib/oracle-gate.js";

export default oracleAssertion([
  {
    key: "ledger_conservation",
    oracle: "conservation",
    invariant:
      "For a settled transfer, the entries carrying its transfer id — source debit, destination credit, fee credit — sum to exactly zero.",
    needs:
      "at least one transfer settled by POST /admin/tick, then GET /accounts/{id}/entries reads that show all three legs (payer, payee, and the acc_fee_<currency> account).",
  },
]);
