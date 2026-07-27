// Retention is a deployment-wide policy configured only through operator env
// (see src/config.ts and src/retention/worker.ts). Projects no longer configure
// retention and legal holds are removed. storageUsage() is a read-only summary
// consumed by projects.js health and the retention worker — there is no longer
// a dedicated storage route.
export async function storageUsage(ctx: HostedDynamic, projectId: HostedDynamic) {
  const { rows } = await ctx.db.query(
    `SELECT a.tier, a.kind, COUNT(*) AS n, CAST(COALESCE(SUM(a.size), 0) AS INTEGER) AS bytes
       FROM artifacts a
       JOIN runs r ON r.id = a.run_id
       JOIN run_groups g ON g.id = r.run_group_id
      WHERE g.project_id = $1
      GROUP BY a.tier, a.kind`,
    [projectId],
  );
  const byTier: HostedDynamic = {};
  const byKind: HostedDynamic = {};
  let total = 0;
  let count = 0;
  for (const r of rows) {
    total += Number(r.bytes || 0);
    count += Number(r.n || 0);
    byTier[r.tier] = (byTier[r.tier] || 0) + Number(r.bytes || 0);
    byKind[r.kind] = (byKind[r.kind] || 0) + Number(r.bytes || 0);
  }
  return { total_bytes: total, artifact_count: count, by_tier: byTier, by_kind: byKind };
}
