// The runner's OWN types for the executor protocol and the executors' options —
// the shapes this agent relies on, not a generated mirror of the control
// plane's. The wire still tolerates more than these say (protocol compatibility
// includes historical payload shapes, validated at their consumers), so fields
// this code does not read are absent here, and fields an older control plane
// may omit are optional. The contractual record of the protocol itself is
// docs/contracts/hosted.md.
import type { AppiumBackends } from "./appium.ts";
import type { RunnerConfig } from "./runner-config.ts";

/** What `POST /runner/exchange` answers: the bearer scoped to one claim. */
export interface ExchangeAnswer {
  token: string;
}

/** The per-case launch options a run group carries for one case. */
export interface GroupCaseOptions {
  mode?: string;
  refresh?: boolean;
  grade?: boolean;
  /** Ephemeral limit overrides, merged over the resolved case's own. */
  limits?: RunnerDynamic;
}

/** One case of a group spec: the authored id, and the run rows it reports to. */
export interface GroupCase {
  case_id: string;
  run_id: string;
  db_id: string;
  options?: GroupCaseOptions;
}

/** What `GET /runner/groups/:id` answers (hosted.md "The group spec"). */
export interface GroupSpec {
  run_group_id: string;
  project?: { key?: string | null } | null;
  application?: { key?: string | null; driver?: string | null; platform?: string | null } | null;
  ring: {
    key: string;
    base_url?: string | null;
    runner_labels?: string[] | null;
    config?: RunnerDynamic;
  };
  cases: GroupCase[];
  sessions?: { needed?: string[] } | null;
  parallel?: RunnerDynamic;
  uploads?: { live?: LiveCaps | null } | null;
}

/**
 * One case's report, as this executor posts it. `status` is the normalized
 * vocabulary (`pass`/`fail`/`infra`/`explored`/`canceled`/`lost`); everything
 * else rides only when the case produced it.
 */
export interface CaseReport {
  status: string;
  error?: string | null;
  manifest?: RunnerDynamic;
  score?: RunnerDynamic;
  bundle?: RunnerDynamic;
  baseline_written?: RunnerDynamic;
  candidate_written?: RunnerDynamic;
}

/** A `script` auth provider's mint grant, as the claim or mint route hands it over. */
export interface MintGrant {
  claim_id: string;
  provider?: string;
  identity?: string;
  identity_config?: RunnerDynamic;
  /** The grant's resolved root secrets — every value feeds the redactor. */
  env?: Record<string, string>;
  code?: string;
  timeout_s?: number;
}

/**
 * The live-staging caps and URL templates a group spec advertises under
 * `uploads.live`, so a runner sizes its batches from the deployment rather
 * than from constants compiled in beside the server's.
 */
export interface LiveCaps {
  open_url_template?: string;
  trajectory_url_template?: string;
  entry_url_template?: string;
  max_manifest_bytes?: number;
  max_entry_bytes?: number;
  max_body_bytes?: number;
  max_line_bytes?: number;
  max_batch_lines?: number;
}

/**
 * A live-staging route's acknowledgement. Acceptance is explicit; a refusal
 * carries its reason from the fixed vocabulary (hosted.md "Live staging
 * routes"), and the trajectory route's answered `lines` count is the
 * authoritative position to advance or rewind to.
 */
export interface LiveAck {
  accepted?: boolean;
  reason?: string;
  lines?: number;
}

/** What the pool loop hands `execGroup` after winning a claim. */
export interface GroupExecutorOptions {
  server: string;
  group: string;
  dispatchId: string;
  isolation: string;
  workDir: string;
  credential?: string | null;
  /** The pool's cancel channel; a heartbeat `canceled` answer aborts it. */
  signal?: AbortSignal | null;
  /** This machine's own validated config; null for web/API-only runners. */
  config?: RunnerConfig | null;
  backends?: AppiumBackends;
  log?: (line: string) => void;
  /** The mint-delivery retry's wait — a seam so tests never sleep through it. */
  sleep?: (ms: number) => Promise<void>;
}

/** What the pool loop hands `execMint` after winning a mint claim. */
export interface MintExecutorOptions {
  server: string;
  claim: string;
  dispatchId: string;
  isolation: string;
  workDir: string;
  credential?: string | null;
}
