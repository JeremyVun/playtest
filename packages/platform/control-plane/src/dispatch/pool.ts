// The claim board, from the control plane's side. Placement is pull-based and
// there is nothing else: the control plane never starts or contacts an
// executor. A self-hosted runner authenticates OUTBOUND, long-polls the board
// (`api/pool.ts`), and claims work it is eligible for. No inbound connection to
// a runner is opened anywhere in this codebase.
//
// This module is the small surface the rest of the server places through:
//
//   postDispatch     no network call. The `requested` dispatch row plus its
//                    labels and target snapshots IS the board entry; this only
//                    says so in the log.
//   dispatchStatus   derives status from claim + heartbeat freshness, which is
//                    what lets the existing reconciler treat a dead self-hosted
//                    runner exactly like any vanished executor.
//   cancelDispatch   marks the claim canceled; the runner sees it at its next
//                    heartbeat and runs the same teardown a SIGTERM triggers.
import { labelsMatch } from "../auth/runner-credentials.ts";
import type { ControlPlaneConfig } from "../config.ts";
import type { Db, DbRow } from "../db.ts";
import type { DynamicJson, Logger } from "../types.ts";

/**
 * How long since a runner's last check-in still counts as present.
 *
 * A runner checks in two ways and never more slowly than these: an idle one
 * long-polls the board (25 s), and a busy one heartbeats its claim (a quarter
 * of the heartbeat timeout). The window is the heartbeat timeout — the same
 * silence at which this module itself stops believing in a claim — floored so
 * that an idle runner may miss two polls to a slow network before a console
 * calls it offline. One number, derived once, so the server and the console
 * cannot disagree about what "online" means.
 */
export function checkInWindowMs(pool: { heartbeatTimeoutMs: number }): number {
  return Math.max(3 * 25_000, pool.heartbeatTimeoutMs);
}

/**
 * What the reconciler is told about a board entry. `reason` and `redispatch`
 * carry the loss shape a pull-based board has and a pushed job does not —
 * nothing ever picked the work up — because re-posting that job to the same
 * empty board would only fail again.
 */
export interface BoardStatus extends DynamicJson {
  id: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  reason?: string;
  redispatch?: boolean;
}

export class ClaimBoard {
  declare readonly db: Db;
  declare readonly log: Logger | null;
  declare readonly claimTimeoutMs: number;
  declare readonly heartbeatTimeoutMs: number;

  constructor(config: ControlPlaneConfig, { db, log = null }: { db: Db; log?: Logger | null }) {
    this.db = db;
    this.log = log;
    this.claimTimeoutMs = config.dispatch.pool.claimTimeoutMs;
    this.heartbeatTimeoutMs = config.dispatch.pool.heartbeatTimeoutMs;
  }

  /**
   * Post to the board. The ledger row was already written (with its labels and
   * target snapshots) by the caller's transaction, so there is nothing to send
   * and nothing to wait for: the row stays `requested`, and the winning CLAIM
   * is what moves it to `scheduled` and emits the provisioning event.
   */
  async postDispatch({ dispatchId, kind, refId, labels = [] }: DynamicJson): Promise<void> {
    this.log?.info?.({ msg: "dispatch posted to the runner claim board", dispatch_id: dispatchId, kind, ref_id: refId, labels });
  }

  async dispatchStatus(dispatchId: string): Promise<BoardStatus | null> {
    if (!dispatchId) return null;
    const { rows } = await this.db.query(
      `SELECT d.*, r.name AS runner_name FROM dispatches d
         LEFT JOIN runners r ON r.id = d.runner_id
        WHERE d.id = $1`,
      [dispatchId],
    );
    const row = rows[0];
    if (!row) return null;
    const id = dispatchId;
    const now = Date.now();

    if (row.canceled_at) {
      return { id, status: "completed", conclusion: "canceled", reason: "the run was canceled", redispatch: false };
    }
    if (!row.claimed_at) {
      const waiting = now - new Date(row.requested_at).getTime();
      if (waiting < this.claimTimeoutMs) return { id, status: "queued", conclusion: null };
      return {
        id,
        status: "completed",
        conclusion: "unclaimed",
        reason: await this.#unclaimedReason(row, waiting),
        // Re-posting to a board no runner is watching fails identically; say so
        // once, actionably, instead of burning the group's second attempt on it.
        redispatch: false,
      };
    }
    const lastSeen = new Date(row.heartbeat_at ?? row.claimed_at).getTime();
    const silentMs = now - lastSeen;
    if (silentMs < this.heartbeatTimeoutMs) return { id, status: "in_progress", conclusion: null };
    return {
      id,
      status: "completed",
      conclusion: "runner_lost",
      reason:
        `runner "${row.runner_name || row.runner_id}" claimed this run and stopped checking in ` +
        `${Math.round(silentMs / 1000)}s ago (expected a heartbeat at least every ` +
        `${Math.round(this.heartbeatTimeoutMs / 1000)}s) — is the runner process still alive?`,
      redispatch: true,
    };
  }

  /** Mark the claim canceled. The runner observes it at its next heartbeat. */
  async cancelDispatch(dispatchId: string) {
    if (!dispatchId) return null;
    await this.db.query(`UPDATE dispatches SET canceled_at = now() WHERE id = $1 AND canceled_at IS NULL`, [dispatchId]);
    return { ok: true };
  }

  /**
   * Why nothing picked this job up, named so a person can act: which labels no
   * live runner advertises, or that the project has no runner at all. This is
   * the message the group fails with, so it has to carry the remedy.
   */
  async #unclaimedReason(row: DbRow, waitingMs: number): Promise<string> {
    const minutes = Math.max(1, Math.round(waitingMs / 60_000));
    // Only runners a person could actually act on. An expired ephemeral
    // registration is invisible in Settings and cannot be restarted, so naming
    // one here would send a reader after a machine that no longer exists — the
    // same standing `isExpired` gives poll, claim and exchange.
    const { rows: runners } = await this.db.query(
      `SELECT name, labels FROM runners
        WHERE project_id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
      [row.project_id, new Date()],
    );
    const wanted: string[] = row.labels || [];
    if (!runners.length) {
      return (
        `no runner has checked in for ${minutes} minute${minutes === 1 ? "" : "s"} — runs are placed on ` +
        `self-hosted runners, and this project has none registered. Register one under Settings → Runners ` +
        `and start it on the machine that can reach the target.`
      );
    }
    const eligible = runners.filter((r: DbRow) => labelsMatch(wanted, r.labels));
    if (!eligible.length) {
      const missing = wanted.filter((label) => !runners.some((r: DbRow) => (r.labels || []).includes(label)));
      const named = (missing.length ? missing : wanted).map((l) => `"${l}"`).join(", ");
      return (
        `no runner with ${missing.length === 1 ? "the label" : "the labels"} ${named} has checked in for ` +
        `${minutes} minute${minutes === 1 ? "" : "s"} — ${runners.length} runner${runners.length === 1 ? " is" : "s are"} ` +
        `registered in this project (${runners.map((r: DbRow) => `"${r.name}": ${(r.labels || []).join(", ") || "no labels"}`).join("; ")}). ` +
        `Give this ring's runner labels to a running runner, or start one advertising them.`
      );
    }
    return (
      `no runner claimed this run for ${minutes} minute${minutes === 1 ? "" : "s"} — ` +
      `${eligible.length} eligible runner${eligible.length === 1 ? " is" : "s are"} registered ` +
      `(${eligible.map((r: DbRow) => `"${r.name}"`).join(", ")}) but ${eligible.length === 1 ? "it is" : "none are"} ` +
      `polling. Is the runner process running?`
    );
  }
}
