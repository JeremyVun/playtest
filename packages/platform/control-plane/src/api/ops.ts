// GET /projects/:p/ops: the project ops
// dashboard — dispatch depth vs. the concurrency cap, GHA queue-wait, dispatch
// reconciler liveness, and LLM spend. Developer role, same bar as the
// dispatches admin page it sits beside.
import { guard, getProjectByKey } from "./util.ts";
import { opsOverview } from "../ops.ts";

export async function projectOps(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "developer");
  return await opsOverview(ctx, project.id);
}
