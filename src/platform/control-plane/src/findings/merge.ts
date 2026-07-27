// The one merge implementation. A reviewer merge, a suggestion confirmation, and
// an applied consolidation group are the same operation: the source finding's
// evidence moves onto the survivor, the source becomes a tombstone, and the
// change is audited (docs/contracts/hosted.md, "Consolidation").
//
// Runs inside an open `withTx` (BEGIN IMMEDIATE). Every mutating statement
// carries `merged_into IS NULL`, so a merge that lost a race fails as a conflict
// rather than writing against a tombstone.
import { audit } from "../audit.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { liveFinding } from "./intake.ts";

/**
 * Merge `sourceId` into `targetId`, in the caller's transaction.
 *
 * @param {{query: Function}} tx
 * @param {object} args
 * @param {string} args.sourceId
 * @param {string} args.targetId merge tombstones are followed to the live head.
 * @param {object} args.actor audit actor
 * @param {string|null} [args.title] retitle the survivor (a consolidation group
 *   proposed as new takes its proposed title).
 * @param {object} [args.detail] extra audit detail.
 * @returns {Promise<object>} the surviving finding row
 */
export async function mergeFindings(tx: HostedDynamic, { sourceId, targetId, actor, title = null, detail = {} }: HostedDynamic) {
  const target = await liveFinding(tx, targetId);
  if (!target) throw notFound(`no target finding "${targetId}"`);
  const src = (await tx.query(`SELECT * FROM findings WHERE id = $1`, [sourceId])).rows[0];
  if (!src) throw notFound(`no finding "${sourceId}"`);
  if (src.merged_into) throw conflict(`finding "${src.id}" was merged into "${src.merged_into}"`);
  if (src.project_id !== target.project_id) {
    throw notFound(`no target finding "${targetId}" in this project`);
  }
  if (src.id === target.id) throw badRequest(`a finding cannot be merged into itself`);

  // Evidence is append-only and keyed on (finding, run, step): drop the source
  // rows the target already carries rather than moving a duplicate onto it.
  await tx.query(
    `DELETE FROM finding_evidence
      WHERE finding_id = $1
        AND EXISTS (SELECT 1 FROM finding_evidence t
                     WHERE t.finding_id = $2 AND t.run_id = finding_evidence.run_id
                       AND COALESCE(t.step_from, -1) = COALESCE(finding_evidence.step_from, -1))`,
    [src.id, target.id],
  );
  await tx.query(`UPDATE finding_evidence SET finding_id = $2 WHERE finding_id = $1`, [src.id, target.id]);

  // SQLite's UPDATE takes no alias, so the correlated subqueries name the table
  // itself; `merged_into IS NULL` re-asserts that neither side of the merge was
  // merged elsewhere between the read and this write.
  const bumped = await tx.query(
    `UPDATE findings
        SET title = COALESCE($3, findings.title),
            evidence_count = (SELECT COUNT(*) FROM finding_evidence WHERE finding_id = findings.id),
            last_seen = MAX(findings.last_seen, COALESCE((SELECT MAX(created_at) FROM finding_evidence WHERE finding_id = findings.id), findings.last_seen)),
            first_seen = MIN(findings.first_seen, COALESCE((SELECT MIN(created_at) FROM finding_evidence WHERE finding_id = findings.id), findings.first_seen)),
            external_ref = COALESCE(findings.external_ref, $2),
            recurrence_count = findings.recurrence_count + $4,
            updated_at = now()
      WHERE findings.id = $1 AND findings.merged_into IS NULL`,
    [target.id, src.external_ref, title, src.recurrence_count || 0],
  );
  if (bumped.rowCount === 0) throw conflict(`finding "${target.id}" changed while it was being merged into`);

  const merged = await tx.query(
    `UPDATE findings
        SET merged_into = $2, suggested_finding_id = NULL, suggestion_kind = NULL, updated_at = now()
      WHERE id = $1 AND merged_into IS NULL`,
    [src.id, target.id],
  );
  if (merged.rowCount === 0) throw conflict(`finding "${src.id}" changed while it was being merged`);

  // A suggestion pointing at the tombstone now points at the survivor.
  await tx.query(
    `UPDATE findings SET suggested_finding_id = $2, updated_at = now()
      WHERE suggested_finding_id = $1 AND merged_into IS NULL`,
    [src.id, target.id],
  );

  await audit(tx, {
    actor,
    action: "finding.merged",
    entityType: "finding",
    entityId: src.id,
    projectId: src.project_id,
    detail: { into: target.id, ...detail },
  });
  return (await tx.query(`SELECT * FROM findings WHERE id = $1`, [target.id])).rows[0];
}
