// The entry for ONE case, in its own process. stdin carries one JSON payload
// { rc, opts }; stdout is NDJSON: one {"event": …} line per engine progress
// event, then exactly one {"result": …} line. Only the result line is
// load-bearing — the parent tails the event lines for live progress and loses
// nothing if they stop (docs/contracts/hosted.md#runner-protocol).
//
// One entry, two arrivals: `docker run … node /opt/playtest/…/case-runner-child.ts`
// inside the pinned job image, and this machine's own `node` beside the
// repository checkout under process isolation. Neither is a second protocol,
// and nothing here knows which one it is.
import { runCase } from "@playtest/core/run";

const input = await new Promise<string>((resolve, reject) => {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (c: RunnerDynamic) => chunks.push(c));
  process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  process.stdin.on("error", reject);
});

// Each frame is one line: an event's free text (actor step summaries) can hold
// anything, so the whole frame is JSON-encoded and newline-terminated. A frame
// that fails to serialize is dropped — events are telemetry, never the result.
const emit = (frame: RunnerDynamic) => {
  try {
    process.stdout.write(JSON.stringify(frame) + "\n");
  } catch {}
};

const { rc, opts } = JSON.parse(input);
const result = await runCase(rc, {
  runsRoot: opts.runsRoot,
  runId: opts.runId,
  mode: opts.mode,
  refresh: opts.refresh,
  grade: opts.grade,
  onEvent: (event: RunnerDynamic) => emit({ event }),
});
// The result line is the whole contract, so it is flushed before this process
// leaves — and then this process DOES leave. A driver's keep-alive socket or a
// hook's stray timer must not keep a finished case alive, and the parent is
// waiting on `close`.
process.stdout.write(JSON.stringify({ result }) + "\n", () => process.exit(0));
