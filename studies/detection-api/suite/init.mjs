// Restore the desk's seeded data before every case, so no story depends on
// what an earlier story did. Exits 0 only when the reset answered HTTP 200.
const base = (process.env.BASE_URL ?? "").replace(/\/+$/, "");

if (!base) {
  console.error("init: BASE_URL is not set");
  process.exit(1);
}

try {
  const response = await fetch(`${base}/__reset`, { method: "POST" });
  if (response.status !== 200) {
    console.error(`init: POST ${base}/__reset answered ${response.status}`);
    process.exit(1);
  }
} catch (error) {
  console.error(`init: POST ${base}/__reset failed — ${error.message}`);
  process.exit(1);
}
