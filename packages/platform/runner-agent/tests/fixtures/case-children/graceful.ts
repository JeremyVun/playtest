// A case child that stops when it is asked to, the ordinary shape: it blocks,
// but a SIGTERM ends it. It exists to prove the graceful half of the
// cancellation contract — the force-kill is a backstop, not the mechanism.
const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  process.on("SIGTERM", () => process.exit(143));
  process.stdout.write(JSON.stringify({ event: { type: "fixture_ready", pid: process.pid } }) + "\n");
  setInterval(() => {}, 1000);
});
