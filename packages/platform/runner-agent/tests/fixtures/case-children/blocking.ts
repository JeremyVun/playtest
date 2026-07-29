// A case child that will NEVER finish and never yields to a signal, standing in
// for the real thing: a driver call blocked on a device, a customer hook that
// installed its own SIGTERM handler, a browser that will not close. It speaks
// the real case protocol (`case-runner-child.ts`) — one JSON payload in on
// stdin, NDJSON frames out — so the parent under test is the production path.
//
// It also spawns a GRANDCHILD in its own (inherited) process group. Killing the
// child's pid alone leaves that grandchild running; killing the process group
// does not. That difference is the whole point of the test.
import { spawn } from "node:child_process";

const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  // Not detached: the grandchild joins THIS process group, exactly as a browser
  // or an ffmpeg started by the engine would.
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  // Refuse to die politely. Only the force-kill can end this.
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  process.stdout.write(
    JSON.stringify({
      event: {
        type: "fixture_ready",
        pid: process.pid,
        grandchild: grandchild.pid,
        run_id: payload?.opts?.runId ?? null,
        // Proof that nothing secret rides argv: the child reports its own.
        argv: process.argv,
        secret: process.env.PLAYTEST_FIXTURE_SECRET ?? null,
      },
    }) + "\n",
  );
  setInterval(() => {}, 1000);
});
