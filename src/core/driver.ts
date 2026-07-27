// The transport seam (docs/contracts/engine.md#driver-contract).
// `runner.ts` depends only on this
// factory and the Driver interface it returns — it never imports a concrete
// driver and never reaches into a transport client. One defaulted config key,
// `app.driver` (web | mobile | api; absent => web), selects the implementation;
// this switch is the entire dispatch — no registry, no driver discovery.
//
// A Driver implements: start(), captureSnapshot(stepNum), execute(action),
// executeLocator(actedStep), finalPageCheck(query), location(), effectToken(),
// consoleErrors(), close(), normalizeSnapshot(text), the OPTIONAL
// consoleErrorLog() (the captured error messages behind consoleErrors()'s count;
// web returns {type,text}[], mobile/api return []), the OPTIONAL
// stopRecording() (web only — freezes final state before the gate), and the
// OPTIONAL persistence hooks snapshotProjection(text) / redactAction(action)
// (api only — the committed trajectory carries a normalized response projection
// and a redacted request program instead of raw bodies and injected credentials;
// docs/contracts/engine.md#secrets-and-redaction);
// exposes id, settle, overlay. ExecResult/Snapshot
// shapes per docs/contracts/artifacts.md#step-envelope (the envelope field
// stays named `url`; it holds a screen/route
// id under the mobile driver). resolution.locator is an opaque durable handle
// (Playwright selector / Appium accessibility-id / "METHOD /path"); the viewer's
// action-track diff and act mode treat it as a string.
//
// normalizeSnapshot(text) is the per-driver drift comparison surface
// (docs/contracts/engine.md#act-and-heal): the
// act loop captures the replay step's raw snapshot and compares its normalized
// form against the normalized baseline snapshot_text — any divergence triggers a
// heal (the app changed under a clean replay). Each driver owns its own
// normalization (strip volatile-but-not-behavioral noise: ref renumbering,
// response headers) so the comparison sees only behavioral change. Same
// driver-owned shape as the `snapshotFormat`/`settle` pins. Pure (no I/O); kept
// as an exported helper per driver for unit test.
import { DummyConfigError } from "./config.ts";
import { WebDriver } from "./drivers/web.ts";
import type { StepAction, StepEnvelope } from "./trajectory.ts";
import type { DriverId, ResolvedCase, ResolvedEnvironment } from "./types.ts";

export interface DriverResolution {
  locator: string | null;
  bbox?: { x: number; y: number; width?: number; height?: number; w?: number; h?: number } | null;
  [key: string]: unknown;
}

export interface DriverNetworkRequest {
  method?: string;
  url?: string;
  path?: string;
  status?: number;
  mime_type?: string;
  failed?: boolean;
  [key: string]: unknown;
}

export interface DriverResult {
  ok: boolean;
  error: string | null;
  resolution: DriverResolution | null;
  settle_ms: number;
  url: string | null;
  perf: Record<string, unknown> | null;
  network: { requests: DriverNetworkRequest[] };
  har_entries: number[];
  expect?: { status: number };
  [key: string]: unknown;
}

export interface DriverSnapshot {
  text: string;
  url: string | null;
  title: string;
  refCount: number;
  truncated: boolean;
  screenshot: Buffer | null;
  screenshotHash: string | null;
  nativeText?: string | null;
}

export interface DriverContext {
  step?: number;
  bindings?: DriverBinding[];
}

export interface DriverBinding {
  name: string;
  from_step: number;
  from: string;
  into: string[];
}

export interface Driver {
  readonly id: DriverId;
  readonly settle: {
    name: string;
    dom_quiet_ms?: number;
    net_quiet_ms?: number;
    source_quiet_ms?: number;
    max_ms: number;
    initial_quiet_ms?: number;
  };
  readonly overlay: Record<string, unknown>;
  readonly snapshotFormat: string;
  readonly viewport?: { width: number; height: number | null } | null;

  start(): Promise<DriverResult>;
  captureSnapshot(stepNum: number): Promise<DriverSnapshot>;
  execute(action: StepAction, ctx?: DriverContext): Promise<DriverResult>;
  executeLocator(actedStep: StepEnvelope, ctx?: DriverContext): Promise<DriverResult>;
  finalPageCheck(query: string): Promise<boolean>;
  location(): string | null;
  effectToken(): Promise<string | null>;
  consoleErrors(): number;
  consoleErrorLog?(): Array<{ type: string; text: string }>;
  captureAxe?(): Promise<unknown>;
  normalizeSnapshot(text: string, base?: string | null): string;
  snapshotProjection?(text: string): string;
  redactAction?(action: StepAction): StepAction;
  parameterizeAction?(action: StepAction): { action: StepAction; bindings: DriverBinding[] };
  stopRecording?(): Promise<{ text: string; url: string | null } | null>;
  close(): Promise<void>;
}

interface PreparedEnvironment {
  baseUrl: string;
  managed: boolean;
}

interface CreateDriverOptions {
  runDir: string;
  headed?: boolean;
}

export async function createDriver(
  rc: ResolvedCase,
  env: PreparedEnvironment,
  { runDir, headed = false }: CreateDriverOptions = {} as CreateDriverOptions // TODO(ts): preserves the legacy optional argument while callers supply runDir
): Promise<Driver> {
  const driver = rc.env?.driver ?? "web";
  switch (driver) {
    case "web":
      return WebDriver.launch({
        baseUrl: env.baseUrl,
        runDir,
        storageState: rc.env.storage_state,
        headed,
        settle: rc.env.settle,
        viewport: rc.env.viewport,
        deviceScaleFactor: rc.env.device_scale_factor,
        cookies: rc.env.cookies,
        // Gate-only on web (docs/contracts/engine.md#invariant-policies): the
        // enriched spec the Tier-1 invariant policies judge the page's own
        // requests against. case_file names the file if the spec won't load.
        openapi: rc.env.openapi ?? null,
        caseFile: rc.file,
      });
    case "mobile": {
      // Dynamic import keeps the Appium/webdriverio module graph out of web/api
      // runs; webdriverio itself is an optionalDependency, lazy-imported deeper.
      const { MobileDriver } = await import("./drivers/mobile.ts");
      return MobileDriver.launch({
        env: rc.env as Extract<ResolvedEnvironment, { driver: "mobile" }>,
        runDir
      });
    }
    case "api": {
      const { ApiDriver } = await import("./drivers/api.ts");
      // base_url is the prepareEnv-resolved origin (compose port rewrite et al.);
      // openapi + the rest ride on rc.env. case_file names the file in a secret
      // resolution error; redact and match are case-level keys, not app.* ones.
      return ApiDriver.launch({
        env: { ...rc.env, base_url: env.baseUrl, case_file: rc.file, redact: rc.redact ?? null, match: rc.match ?? null, bind: rc.bind ?? null },
        runDir,
      });
    }
    default:
      throw new DummyConfigError(`unknown app.driver "${driver}" (expected web | mobile | api)`);
  }
}
