// Secret masking for the Test targets form. The console never renders a stored
// literal secret value: a ring's `secret_env` literals show as a mask
// everywhere (list, edit form), while `{$secret}`/`{$session}` references are
// names, not values, so they stay readable. On save, an untouched mask means
// "keep the stored value" — the browser never round-trips the literal through an
// input. Kept DOM-free so the hermetic gate can assert masking without a browser.
export const MASK = "••••••";

/** A copy of `config` with literal secret_env values replaced by the mask. */
export function maskSecretEnv(config: WebDynamic) {
  if (!config?.secret_env) return config;
  const masked: WebDynamic = {};
  for (const [k, v] of Object.entries(config.secret_env)) {
    // Object values are `{$secret|$session}` references (names) — keep readable.
    masked[k] = typeof v === "object" && v !== null ? v : MASK;
  }
  return { ...config, secret_env: masked };
}

/** Literal (readable) secret_env entries in a parsed config — the ones to warn about. */
export function literalSecretKeys(cfg: WebDynamic) {
  return Object.entries(cfg?.secret_env || {})
    .filter(([, v]) => typeof v === "string" && v !== MASK)
    .map(([k]) => k);
}
