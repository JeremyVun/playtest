// Subject server lifecycle for study rounds. Servers are detached (nohup
// semantics) so they survive the harness; stop verifies the process is gone
// before returning (one-process-at-a-time study rule).
//
// Usage:
//   node subject-ctl.mjs start --dir <build dir> --port 4620 [--label armP]
//   node subject-ctl.mjs stop --port 4620
//   node subject-ctl.mjs status --port 4620

import fs from "node:fs";
import path from "node:path";
import { spawn, execSync } from "node:child_process";
import { parseArgs } from "node:util";

const {
  values: args,
  positionals: [cmd],
} = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string" },
    port: { type: "string" },
    label: { type: "string", default: "subject" },
  },
});
const port = Number(args.port || 4620);
const pidFile = () => path.join(process.env.TMPDIR || "/tmp", `detection-web-subject-${port}.pid`);

async function alive() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

function pidsOnPort() {
  try {
    return execSync(`lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null`, { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

if (cmd === "start") {
  if (!args.dir) throw new Error("start needs --dir");
  if (pidsOnPort().length) throw new Error(`port ${port} already has a listener — stop it first`);
  const server = path.join(args.dir, "server.js");
  if (!fs.existsSync(server)) throw new Error(`no server.js under ${args.dir}`);
  const logPath = path.join(args.dir, `${args.label}-${port}.log`);
  const out = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [server], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, SUBJECT_PORT: String(port) },
  });
  child.unref();
  fs.writeFileSync(pidFile(), String(child.pid));
  for (let i = 0; i < 40; i++) {
    if (await alive()) {
      console.log(JSON.stringify({ started: true, pid: child.pid, port, log: logPath }));
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not answer on :${port} within 10s — see ${logPath}`);
} else if (cmd === "stop") {
  const pids = new Set(pidsOnPort());
  try {
    pids.add(Number(fs.readFileSync(pidFile(), "utf8").trim()));
  } catch {}
  for (const pid of pids) {
    if (!pid) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  const deadline = Date.now() + 10_000;
  while (pidsOnPort().length) {
    if (Date.now() > deadline) {
      for (const pid of pidsOnPort()) process.kill(pid, "SIGKILL");
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    fs.unlinkSync(pidFile());
  } catch {}
  console.log(JSON.stringify({ stopped: true, port }));
} else if (cmd === "status") {
  const listeners = pidsOnPort();
  let build = null;
  try {
    build = await fetch(`http://127.0.0.1:${port}/__build`, { signal: AbortSignal.timeout(2000) }).then((r) => (r.ok ? r.json() : null));
  } catch {}
  console.log(JSON.stringify({ port, listeners, answering: await alive(), build }));
} else {
  console.error("usage: subject-ctl.mjs start|stop|status --dir <dir> --port <n>");
  process.exit(2);
}
