// Minibank ledger — script suite for the eight adjudicated invariant cards
// in handout/INVARIANTS.md, plus the default policy set.
//
// Shape: one deterministic pass. Phase A resets the world and builds real
// ledger state (accounts, activation, funding, transfers, ticks, closure),
// checking the rules that are only legible while state is being built. Phase B
// then reads the settled world with no intervening write: ownership reach,
// balance/entry agreement and fee routing, and a quiescent pagination walk.

import { makeHarness } from "./lib.mjs";
import phaseA from "./phase-a.mjs";
import phaseB from "./phase-b.mjs";

export default async function suite({ client, check }) {
  const H = makeHarness({ client, check });

  const S = {
    created: {},
    acct: {},
    activated: {},
    deposits: [],
    tx: {},
    ticks: [],
    allEntries: [],
    transfers: [],
    principalA: null,
    principalB: null,
  };

  try {
    await phaseA(H, S);
  } catch (e) {
    check.advisory({
      title: "phase A aborted",
      detail: String((e && e.stack) || e).slice(0, 1500),
    });
  }

  try {
    await phaseB(H, S);
  } catch (e) {
    check.advisory({
      title: "phase B aborted",
      detail: String((e && e.stack) || e).slice(0, 1500),
    });
  }

  if (H.thrown.length > 0) {
    check.advisory({
      title: "client refusals seen while running",
      detail: JSON.stringify(H.thrown.slice(0, 20)),
    });
  }
  check.advisory({
    title: "request budget at the end of the run",
    detail: JSON.stringify(client.budget),
  });
}
