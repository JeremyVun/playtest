// Audit browser. Every mutation lands in audit_log; this is the
// admin's filterable read view (actor/action/entity/time), rows carrying the detail
// JSON document (snapshot ids, changed paths, hash transitions). Admin role.
import { guard, getProjectByKey, parsePagination } from "./util.ts";
import { badRequest } from "../errors.ts";

/** GET /projects/:p/audit?entity=&actor=&action=&since=&limit=&cursor= */
export async function listAudit(ctx: HostedDynamic) {
  const project = await getProjectByKey(ctx, ctx.params.p);
  guard(ctx, project.id, "admin");
  const { limit, cursor } = parsePagination(ctx.query);

  const where = ["project_id = $1"];
  const args = [project.id];
  const add = (sql: HostedDynamic, val: HostedDynamic) => {
    args.push(val);
    where.push(sql.replace("$?", `$${args.length}`));
  };
  const entityType = ctx.query.get("entity");
  if (entityType) add("entity_type = $?", entityType);
  const action = ctx.query.get("action");
  if (action) add("action = $?", action);
  const actorUser = ctx.query.get("actor");
  if (actorUser) add("json_extract(actor, '$.user_id') = $?", actorUser);
  const since = ctx.query.get("since");
  if (since) {
    // Validate before binding, or garbage reaches the query as a raw 500 instead
    // of a friendly 400. Bind a Date, never the raw string: `ts` is epoch-ms
    // INTEGER, and SQLite compares an integer against non-numeric text by type
    // rank — an ISO string would silently match nothing.
    if (Number.isNaN(Date.parse(since))) {
      throw badRequest(`"since" must be a parseable date/time (e.g. an ISO 8601 string)`);
    }
    add("ts >= $?", new Date(since));
  }
  // Keyset pagination on the ULID id (time-ordered), descending.
  if (cursor) add("id < $?", cursor);

  args.push(limit + 1);
  const { rows } = await ctx.db.query(
    `SELECT id, ts, actor, action, entity_type, entity_id, detail
       FROM audit_log WHERE ${where.join(" AND ")}
      ORDER BY id DESC LIMIT $${args.length}`,
    args,
  );
  const items = rows.slice(0, limit);
  const next_cursor = rows.length > limit ? items[items.length - 1].id : null;
  return { items, next_cursor };
}
