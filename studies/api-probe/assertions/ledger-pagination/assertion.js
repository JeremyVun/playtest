// Pagination identity — no entry id is returned twice within one cursor
// enumeration. The oracle is the vendored bench oracle `pagination`; see
// ../../lib/oracle-gate.js and docs/contracts/engine.md.
import { oracleAssertion } from "../../lib/oracle-gate.js";

export default oracleAssertion([
  {
    key: "ledger_pagination_identity",
    oracle: "pagination",
    invariant:
      "Within one cursor enumeration of GET /accounts/{id}/entries, no ledger entry id is ever returned twice, and following next_cursor terminates.",
    needs:
      "an enumeration the oracle can anchor: a GET /accounts/{id}/entries with NO cursor parameter, followed by requests that pass back exactly the next_cursor the previous page returned. A page fetched with an invented or resumed cursor is tracked but not scored.",
  },
]);
