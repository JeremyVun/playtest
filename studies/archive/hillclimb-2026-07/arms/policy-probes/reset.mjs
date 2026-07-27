// Reset the app under test to its seed before each case.
const res = await fetch(`${process.env.BASE_URL}/api/reset`, { method: "POST" });
if (!res.ok) {
  console.error(`reset failed: ${res.status}`);
  process.exit(1);
}
