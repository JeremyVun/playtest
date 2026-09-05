import { ServerConfigError } from "./config.ts";
import { hashToken, tokenHashMatches } from "./auth/tokens.ts";
import { ensureSiteRunner } from "./api/site-runners.ts";
import type { AppContext } from "./types.ts";

export async function ensureConfiguredRunner(ctx: AppContext): Promise<void> {
  const configured = ctx.config.siteRunner;
  if (!configured) return;
  const { rows } = await ctx.db.query("SELECT * FROM runners WHERE project_id IS NULL AND name = $1 ORDER BY created_at DESC", [configured.name]);
  if (rows.length) {
    const runner = rows[0]!;
    if (runner.revoked_at || runner.expires_at || !tokenHashMatches(configured.credential, runner.credential_hash)) {
      throw new ServerConfigError("Configured site runner is revoked, expired, or has a different credential; reconcile its registration before restarting");
    }
    return;
  }
  const created = await ensureSiteRunner(ctx, { name: configured.name, hash: hashToken(configured.credential), labels: [], actor: { system: "bootstrap" } });
  if (!created) throw new ServerConfigError("Configured site runner could not be registered");
}
