// Reset the subject app to its exact seeded state before each case.
// Runs via the Node binary (no exec bit needed on hosted-materialized suites).
const res = await fetch(`${process.env.BASE_URL}/__reset`, { method: "POST" });
if (!res.ok) throw new Error(`subject reset failed: HTTP ${res.status}`);
