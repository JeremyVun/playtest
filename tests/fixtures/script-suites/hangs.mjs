// Never returns: the runner's timeout is what ends this execution. The wait is a
// real timer, so the child stays alive and the parent has something to kill.
import { setTimeout as sleep } from "node:timers/promises";

export default async function ({ client, check }) {
  const health = await client.get("/health");
  check({
    id: "health-ok",
    obligation: "rule:health",
    title: "GET /health answers { ok: true }",
    pass: health.json?.ok === true,
    evidence: { requests: [health.ref] },
  });
  await sleep(60_000);
}
