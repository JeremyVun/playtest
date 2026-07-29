// A case child that completes normally: it echoes the payload it was handed
// back as the case result, plus one progress event. The happy path of the
// protocol, with no engine and no browser.
const chunks: Buffer[] = [];
process.stdin.on("data", (c: Buffer) => chunks.push(c));
process.stdin.on("end", () => {
  const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  process.stdout.write(JSON.stringify({ event: { type: "step_start", step: 1 } }) + "\n");
  // Stray non-frame output, as a dependency writing to stdout would produce.
  process.stdout.write("a library printed this\n");
  process.stdout.write(
    JSON.stringify({
      result: {
        status: "pass",
        runDir: payload.opts.runsRoot,
        runId: payload.opts.runId,
        echoed: payload.rc,
        env: {
          secret: process.env.PLAYTEST_FIXTURE_SECRET ?? null,
          inherited: process.env.PLAYTEST_FIXTURE_INHERITED ?? null,
        },
        argv: process.argv,
      },
    }) + "\n",
    () => process.exit(0),
  );
});
