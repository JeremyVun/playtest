export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export type FetchLike = typeof globalThis.fetch;

export type DriverId = "web" | "mobile" | "api";
export type CaseMode = "journey" | "discovery";
export type PersonaReference = string;

export interface Persona {
  name: string;
  description: string;
}

export interface CustomPersona extends Persona {
  slug: string;
  file: string;
}

export type DurationInput = string | number;
export type ParallelConfig =
  | number
  | true
  | {
      total?: number | true;
      record?: number;
    };

export interface LimitsConfig {
  max_steps?: number;
  timeout?: DurationInput;
}

export interface PerfConfig {
  lcp_ms?: string | number;
  input_to_paint_ms?: string | number;
}

export interface MatchConfig {
  exclude?: string[];
  compare?: string[];
  normalize?: Array<{
    path: string;
    rule: "sorted" | "length";
  }>;
  status_equivalent?: Array<string | Array<string | number>>;
}

export interface ResolvedMatch {
  exclude?: string[];
  compare?: string[];
  normalize?: Array<{
    path: string;
    rule: "sorted" | "length";
  }>;
  status_equivalent?: Array<string | string[]>;
}

export interface RedactConfig {
  request?: Array<{
    path: string;
    secret: string;
  }>;
  projection?: string[];
}

export interface ResolvedRedact {
  request: Array<{
    path: string;
    secret: string;
  }>;
  projection: string[];
}

export interface SecretReference {
  $secret: string;
}

export type SecretHeader = string | SecretReference;

export interface SettleConfig {
  dom_quiet_ms?: number;
  net_quiet_ms?: number;
  source_quiet_ms?: number;
  max_ms?: number;
  initial_quiet_ms?: number;
}

export interface ViewportConfig {
  width?: number;
  height?: number | null;
}

export interface ResolvedViewport {
  width: number;
  height: number | null;
}

export interface EnvironmentOverlay {
  base_url?: string;
  cookies?: Record<string, string>;
  storage_state?: string;
  init?: string;
  auth?: string;
  auth_states?: Record<string, string>;
}

export interface AppConfig {
  driver?: DriverId;
  base_url?: string;
  compose?: string | null;
  init?: string;
  storage_state?: string | null;
  auth?: string;
  auth_states?: Record<string, string>;
  platform?: "ios" | "android";
  app?: string;
  device?: string;
  appium_url?: string;
  preserve_session?: boolean;
  openapi?: string;
  allowed_origins?: string[];
  headers?: Record<string, SecretHeader>;
  settle?: SettleConfig;
  viewport?: ViewportConfig;
  device_scale_factor?: number;
  cookies?: Record<string, string>;
  envs?: Record<string, EnvironmentOverlay>;
}

export interface DefaultsConfig {
  persona?: PersonaReference;
  mode?: CaseMode;
  vision?: boolean;
  visual_regression?: boolean;
  visual_regression_drift?: number;
  perf?: PerfConfig;
  max_steps?: number;
  timeout?: DurationInput;
  limits?: LimitsConfig;
  parallel?: ParallelConfig;
  actor_model?: string;
  grader_model?: string;
  bind?: string | string[];
  match?: MatchConfig;
  redact?: RedactConfig;
  app?: AppConfig;
}

export type InvariantPolicyName =
  | "no_server_error"
  | "documented_status"
  | "response_schema"
  | "content_type"
  | "round_trip"
  | "idempotency"
  | "lifecycle"
  | "pagination"
  | "error_shape";

interface PolicyBase<P extends InvariantPolicyName> {
  policy: P;
}

export type InvariantPolicy =
  | (PolicyBase<"no_server_error" | "documented_status" | "response_schema" | "content_type"> & {
      scope?: string;
    })
  | (PolicyBase<"round_trip"> & {
      create: string;
      read: string;
      fields: string | string[];
      read_from?: Record<string, string>;
      observe?: boolean;
    })
  | (PolicyBase<"idempotency"> & {
      op: string;
      key_header?: string;
      compare?: "status" | "body" | Array<"status" | "body">;
      ignore?: string | string[];
    })
  | (PolicyBase<"lifecycle"> & {
      delete: string;
      read: string;
      after?: Array<string | number>;
      state?: string;
    })
  | (PolicyBase<"pagination"> & {
      op: string;
      identity: string;
      cursor?: string;
      consistency?: "snapshot" | "eventual";
    })
  | (PolicyBase<"error_shape"> & {
      scope?: string;
      require: string | string[];
      exclude_status?: Array<string | number>;
    });

export type Occurrence = "all" | "any" | "first" | "last";

export interface ResponseStatusSelector {
  op: string;
  status: string | number;
  occurrence?: Occurrence;
}

export interface ResponseMatchSelector {
  op: string;
  match: string;
  occurrence?: Occurrence;
}

type NamedCriterion<K extends string, V> = { label?: string } & { [P in K]: V };

export type WebSuccessCriterion =
  | NamedCriterion<"url_matches", string>
  | NamedCriterion<"element_exists", string>
  | NamedCriterion<"api_called", string>
  | NamedCriterion<"console_errors", number>
  | NamedCriterion<"accessibility_violations", number>
  | NamedCriterion<"invariant", InvariantPolicy>
  | NamedCriterion<"assert", string>;

export type MobileSuccessCriterion =
  | NamedCriterion<"screen_shows", string>
  | NamedCriterion<"assert", string>;

export type ApiSuccessCriterion =
  | NamedCriterion<"url_matches", string>
  | NamedCriterion<"api_called", string>
  | NamedCriterion<"response_status", string | ResponseStatusSelector>
  | NamedCriterion<"response_matches", string | ResponseMatchSelector>
  | NamedCriterion<"invariant", InvariantPolicy>
  | NamedCriterion<"assert", string>;

export type CustomSuccessCriterion<K extends string> =
  [K] extends [never] ? never : NamedCriterion<K, string | number | boolean>;

export type SuccessCriterion<D extends DriverId, K extends string = never> =
  | (D extends "web"
      ? WebSuccessCriterion
      : D extends "mobile"
        ? MobileSuccessCriterion
        : ApiSuccessCriterion)
  | CustomSuccessCriterion<K>;

export type AdvisoryCriterion = NamedCriterion<"invariant", InvariantPolicy>;

export interface AuthoredCaseConfig extends Omit<DefaultsConfig, "persona"> {
  story: string;
  description?: string;
  tags?: string[];
  persona?: PersonaReference | PersonaReference[];
  success?: Array<WebSuccessCriterion | MobileSuccessCriterion | ApiSuccessCriterion>;
  observe?: AdvisoryCriterion[];
  report?: string[];
}

export interface AssertionModule {
  keys(): unknown;
  gather(...args: unknown[]): unknown;
  verdict(...args: unknown[]): unknown;
  inheritable?: boolean;
}

export interface AssertionOwner {
  name: string;
  assertion: AssertionModule;
}

export interface RegisteredAssertion extends AssertionOwner {
  keys: string[];
}

export interface AssertionRegistry {
  routing: Map<string, AssertionOwner>;
  assertions: RegisteredAssertion[];
}

interface ResolvedEnvironmentBase<D extends DriverId> {
  driver: D;
  env_name: string | null;
  base_url: string | null;
  compose: string | null;
  init: string | null;
  storage_state: string | null;
  auth: string | null;
  auth_unresolved?: true;
  platform: "ios" | "android" | null;
  app: string | null;
  device: string | null;
  appium_url: string | null;
  preserve_session: boolean | null;
  openapi: string | null;
  allowed_origins: string[] | null;
  headers: Record<string, SecretHeader> | null;
  settle: SettleConfig | null;
  viewport: ResolvedViewport | null;
  device_scale_factor: number | null;
  cookies: Record<string, string> | null;
}

export type ResolvedEnvironment =
  | (ResolvedEnvironmentBase<"web"> & {
      base_url: string;
      viewport: ResolvedViewport;
    })
  | (ResolvedEnvironmentBase<"mobile"> & {
      app: string;
    })
  | (ResolvedEnvironmentBase<"api"> & {
      base_url: string;
    });

interface ResolvedCaseBase<D extends DriverId, K extends string> {
  id: string;
  storyId: string;
  file: string;
  name: string;
  _assertions: AssertionRegistry;
  story: string;
  description: string | null;
  mode: CaseMode;
  persona: PersonaReference;
  tags: string[];
  success: SuccessCriterion<D, K>[];
  observe: AdvisoryCriterion[];
  perf: PerfConfig;
  report: string[];
  redact: ResolvedRedact | null;
  match: ResolvedMatch | null;
  bind: string[] | null;
  vision: boolean;
  visual_regression: boolean;
  visual_regression_drift: number;
  limits: {
    max_steps: number;
    timeout_ms: number;
  };
  parallel: ParallelConfig | null;
  actor_model: string;
  grader_model: string;
  env: Extract<ResolvedEnvironment, { driver: D }>;
}

export type ResolvedCase<K extends string = never> =
  | ResolvedCaseBase<"web", K>
  | ResolvedCaseBase<"mobile", K>
  | ResolvedCaseBase<"api", K>;

export interface DiscoverCasesOptions {
  tags?: string[];
  ids?: string[];
  baseUrl?: string | null;
  env?: string | null;
}
