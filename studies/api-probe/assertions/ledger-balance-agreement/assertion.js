// Derived-vs-stored balance agreement — an account's stored balance equals the
// sum of its ledger entries. The oracle is the vendored bench oracle
// `balance_agreement`; see ../../lib/oracle-gate.js and
// docs/contracts/engine.md.
import { oracleAssertion } from "../../lib/oracle-gate.js";

export default oracleAssertion([
  {
    key: "ledger_balance_agreement",
    oracle: "balance_agreement",
    invariant: "An account's stored balance equals the sum of the amounts of all its ledger entries.",
    needs:
      "the two sides read consistently: a GET /accounts/{id} balance read and a COMPLETE cursor enumeration of that account's entries (first page cursorless, following next_cursor until it is null), with no write of any kind between them.",
  },
]);
