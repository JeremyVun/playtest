// Error-shape consistency, plus the protocol check that lives on the same
// surface. The oracles are the vendored bench oracles `error_shape` and
// `protocol`; see ../../lib/oracle-gate.js and docs/contracts/engine.md.
//
// Two keys, one module, on purpose: both rules are read off the response
// surface a single story explores, and the fixture's two schema-reachable
// faults split across them — a refusal dressed as 200 is error_shape, an
// undocumented throw at a boundary amount is protocol. Registering them
// together means the error-shape story gathers once and reports both.
import { oracleAssertion } from "../../lib/oracle-gate.js";

export default oracleAssertion([
  {
    key: "ledger_error_shape",
    oracle: "error_shape",
    invariant:
      'Every 4xx/5xx body is {"error":{"code","message","details"?}} with string code and message, and a refused request is always a 4xx — never a 2xx carrying a failure.',
    needs:
      "at least one response the service refused: any 4xx/5xx, or a POST /transfers that came back 2xx. A trace of nothing but successes cannot test this rule.",
  },
  {
    key: "ledger_no_server_error",
    oracle: "protocol",
    invariant: "No operation answers 5xx.",
    needs: "at least one request that completed with a status at all.",
  },
]);
