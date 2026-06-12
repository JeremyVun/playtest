// Empty the todo store before each case. Node, not shell: runInit execs
// *.mjs via process.execPath, so the demo also works on Windows.
const res = await fetch(`${process.env.BASE_URL}/api/reset`, { method: "POST" });
if (!res.ok) {
  console.error(`reset failed: HTTP ${res.status}`);
  process.exit(1);
}
