// Harness-owned isolation (DESIGN §3). Runs before every case, whatever the
// previous run did or how it ended: a probe stops the moment it reproduces a
// violation, so it never tears anything down, and the state it leaves behind
// must not reach the next run.
//
// A seeded reset is the fixture's own mechanism for this — identifiers are a
// pure function of the seed, so the same request sequence after the same reset
// produces byte-identical resources, which is what makes a reproduced
// counterexample re-verifiable.
//
// Deliberately not fault-aware: this script never reads or sets any fault
// configuration. Which build it resets is decided by the process serving the
// fixture, not by anything in this suite.
const base = process.env.BASE_URL;
const token = process.env.LEDGER_ADMIN_TOKEN ?? "admin-token-dev";
const seed = process.env.LEDGER_SEED ?? "ledger-dev-seed";

if (!base) {
  console.error("BASE_URL is not set (the harness passes it; run this through playtest, not by hand)");
  process.exit(1);
}

let res;
try {
  res = await fetch(new URL("/admin/reset", base), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ seed }),
  });
} catch (e) {
  console.error(`could not reach the ledger fixture at ${base}: ${e.message}`);
  console.error("start it first — see studies/api-probe/README.md");
  process.exit(1);
}

if (!res.ok) {
  console.error(`POST /admin/reset answered ${res.status}: ${(await res.text()).slice(0, 400)}`);
  console.error("the admin token must match the fixture's (LEDGER_ADMIN_TOKEN)");
  process.exit(1);
}
