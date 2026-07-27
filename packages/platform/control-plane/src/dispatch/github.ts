// GitHub Actions placement adapter. The control plane uses a
// GitHub App installation token to dispatch one workflow per run group and polls
// workflow-run status during reconciliation. Tests inject a mock with the same
// methods so no network or real runner is required.
import crypto from "node:crypto";
import { AppError } from "../errors.ts";
import type { ControlPlaneConfig } from "../config.ts";
import type { DynamicJson } from "../types.ts";

type GitHubConfig = ControlPlaneConfig["dispatch"]["github"] & {
  appId: string;
  privateKey: string;
  installationId: string;
  repository: string;
};
interface RequestOptions {
  method?: string;
  token?: string | null;
  tokenType?: string;
  body?: unknown;
  expect?: number[];
}

export class GitHubDispatchClient {
  declare readonly cfg: GitHubConfig;
  declare readonly fetch: typeof fetch;

  constructor(config: ControlPlaneConfig, { fetchImpl = globalThis.fetch }: { fetchImpl?: typeof fetch } = {}) {
    this.cfg = config.dispatch.github as GitHubConfig; // SAFETY: #requireConfigured guards every operation that consumes required GitHub credentials.
    this.fetch = fetchImpl;
  }

  get enabled() {
    return this.cfg.enabled;
  }

  async dispatchWorkflow({
    dispatchId,
    kind,
    refId,
    labels = [],
    attempt
  }: {
    dispatchId: string;
    kind: string;
    refId: string;
    labels?: string[];
    attempt: number;
  }) {
    this.#requireConfigured();
    const [owner, repo] = this.#repo();
    const token = await this.#installationToken();
    const url =
      `${this.cfg.apiUrl}/repos/${owner}/${repo}/actions/workflows/` +
      `${encodeURIComponent(this.cfg.workflowId)}/dispatches`;
    await this.#request(url, {
      method: "POST",
      token,
      body: {
        ref: this.cfg.ref,
        inputs: {
          kind,
          id: refId,
          dispatch_id: dispatchId,
          attempt: String(attempt),
          labels: JSON.stringify(labels.length ? labels : ["self-hosted", "playtest"]),
        },
      },
      expect: [204],
    });
    return { workflow_run_id: null, workflow_run_url: null };
  }

  /**
   * Deterministic correlation for GitHub's 204 dispatch response: the workflow's
   * `run-name` embeds the dispatch id (infra/gha/playtest-runner.yml), so the
   * newest workflow_dispatch runs since `since` are scanned for a name carrying
   * it. Returns { id, status, conclusion, url } or null when no run matches yet.
   */
  async findDispatchRun(dispatchId: string, { since = null }: { since?: Date | string | null } = {}) {
    this.#requireConfigured();
    const [owner, repo] = this.#repo();
    const token = await this.#installationToken();
    const params = new URLSearchParams({ event: "workflow_dispatch", per_page: "50" });
    if (since) params.set("created", `>=${new Date(since).toISOString()}`);
    const data = await this.#request(
      `${this.cfg.apiUrl}/repos/${owner}/${repo}/actions/workflows/` +
        `${encodeURIComponent(this.cfg.workflowId)}/runs?${params}`,
      { token },
    );
    const hit = (data.workflow_runs || []).find((r: DynamicJson) => typeof r.name === "string" && r.name.includes(dispatchId));
    if (!hit) return null;
    return {
      id: String(hit.id),
      status: hit.status ?? null,
      conclusion: hit.conclusion ?? null,
      url: hit.html_url ?? null,
    };
  }

  async getRunStatus(workflowRunId: string) {
    this.#requireConfigured();
    if (!workflowRunId) return null;
    const [owner, repo] = this.#repo();
    const token = await this.#installationToken();
    const data = await this.#request(
      `${this.cfg.apiUrl}/repos/${owner}/${repo}/actions/runs/${encodeURIComponent(workflowRunId)}`,
      { token },
    );
    return {
      id: String(data.id ?? workflowRunId),
      status: data.status ?? null,
      conclusion: data.conclusion ?? null,
      url: data.html_url ?? data.url ?? null,
    };
  }

  async cancelRun(workflowRunId: string) {
    this.#requireConfigured();
    if (!workflowRunId) return null;
    const [owner, repo] = this.#repo();
    const token = await this.#installationToken();
    await this.#request(
      `${this.cfg.apiUrl}/repos/${owner}/${repo}/actions/runs/${encodeURIComponent(workflowRunId)}/cancel`,
      { method: "POST", token, expect: [202, 409] },
    );
    return { ok: true };
  }

  #requireConfigured(): void {
    if (!this.cfg.enabled) {
      throw new AppError(
        "config_error",
        "GitHub dispatch is not configured; set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, " +
          "GITHUB_APP_INSTALLATION_ID, GITHUB_REPOSITORY, and GITHUB_WORKFLOW_ID",
      );
    }
  }

  #repo(): [string, string] {
    const parts = String(this.cfg.repository || "").split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new AppError("config_error", `GITHUB_REPOSITORY must be "owner/repo"`);
    }
    return parts as [string, string];
  }

  async #installationToken(): Promise<string> {
    const jwt = appJwt(this.cfg.appId, this.cfg.privateKey);
    const data = await this.#request(
      `${this.cfg.apiUrl}/app/installations/${encodeURIComponent(this.cfg.installationId)}/access_tokens`,
      { method: "POST", token: jwt, tokenType: "Bearer" },
    );
    if (!data?.token) throw new AppError("storage_error", "GitHub App token response did not include a token");
    return data.token;
  }

  async #request(
    url: string,
    { method = "GET", token = null, tokenType = "token", body = undefined, expect = [200, 201] }: RequestOptions = {}
  ): Promise<DynamicJson> {
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": "playtest-hosted",
      "x-github-api-version": "2022-11-28",
    };
    if (token) headers.authorization = `${tokenType} ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e: any /* SAFETY: Network failures expose Error.message at this boundary. */) {
      throw new AppError("storage_error", `GitHub API request failed: ${e.message}`, { cause: e });
    }
    if (!expect.includes(res.status)) {
      const text = await res.text().catch(() => "");
      throw new AppError("storage_error", `GitHub API ${method} ${url} returned ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
    }
    if (res.status === 204 || res.status === 202) return {};
    return await res.json() as DynamicJson;
  }
}

export function appJwt(
  appId: string | null,
  privateKey: string | null,
  now = Math.floor(Date.now() / 1000)
): string {
  if (!appId) throw new AppError("config_error", "GITHUB_APP_ID is required for GitHub dispatch");
  if (!privateKey) throw new AppError("config_error", "GITHUB_APP_PRIVATE_KEY is required for GitHub dispatch");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 9 * 60, iss: String(appId) }));
  const sig = crypto.createSign("RSA-SHA256").update(`${header}.${payload}`).sign(privateKey);
  return `${header}.${payload}.${b64url(sig)}`;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}
