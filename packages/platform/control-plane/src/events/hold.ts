// The held-read discipline, shared by every long-poll surface (the browser event
// feed and the runner claim board).
//
// Re-run `load` when the project's post-commit wake signal fires, with a 1 s scan
// as the fallback, until it produces rows or `waitSeconds` elapses. Returns
// whatever the last load produced (possibly []).
//
// The scan fallback is not a backstop for a rare miss — it is the correctness
// path. Rows committed between the caller's first `load()` and this loop's
// subscription wake nobody, so the signal is only ever an accelerator; the
// committed row decides what a client sees.
//
// The hold ends early when the client goes away (tab close, gateway kill):
// without that check every abandoned reconnect kept its loop and a DB connection
// busy for the full hold, and then queried a dead request's context. It also ends
// when the waker has been stopped, i.e. the server is shutting down — otherwise
// `wait()` resolves instantly and the loop spins against a closing database.
// `projectId` may be null: a site-scoped runner's board spans every project and
// wakes are keyed per project, so it holds on the scan alone. That is the same
// correctness path every other caller already depends on, one second slower.
export async function holdUntil<Row>(
  ctx: HostedDynamic,
  projectId: string | null,
  waitSeconds: number,
  load: () => Promise<Row[]>,
): Promise<Row[]> {
  const deadline = Date.now() + waitSeconds * 1000;
  let rows: Row[] = [];
  while (!rows.length) {
    if (ctx.req?.destroyed || ctx.res?.destroyed || ctx.res?.writableEnded) return [];
    if (ctx.feedWaker && !ctx.feedWaker.connected) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    if (ctx.feedWaker && projectId) await ctx.feedWaker.wait(projectId, Math.min(remaining, 1000));
    else await sleep(Math.min(remaining, 1000));
    if (ctx.req?.destroyed || ctx.res?.destroyed || ctx.res?.writableEnded) return [];
    rows = await load();
  }
  return rows;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
