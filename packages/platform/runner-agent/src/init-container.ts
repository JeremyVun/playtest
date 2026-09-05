import fs from "node:fs/promises";
import path from "node:path";

const work = process.env.PLAYTEST_RUNNER_WORKDIR;
const credential = process.env.PLAYTEST_RUNNER_CREDENTIAL;
const uid = Number(process.env.PLAYTEST_JOB_UID || 1000), gid = Number(process.env.PLAYTEST_JOB_GID || 1000);
if (!work || !path.isAbsolute(work) || !credential?.match(/^ptr_[A-Za-z0-9_-]{32,128}$/) || !Number.isSafeInteger(uid) || uid <= 0 || !Number.isSafeInteger(gid) || gid < 0) throw new Error("Runner initialization requires a host workspace, stable credential and non-root UID/GID");
for (const dir of [work, "/credentials"]) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chown(dir, uid, gid);
  await fs.chmod(dir, 0o700);
}
const file = "/credentials/runner";
try {
  if ((await fs.readFile(file, "utf8")).trim() !== credential) throw new Error("Stored runner credential differs; reconcile the registration before changing it");
} catch (error: any) {
  if (error.code !== "ENOENT") throw error;
  await fs.writeFile(file, credential + "\n", { mode: 0o600, flag: "wx" });
}
await fs.chown(file, uid, gid);
await fs.chmod(file, 0o600);
