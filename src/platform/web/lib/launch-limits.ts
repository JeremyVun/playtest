/**
 * Compact effective-limit labels for the launch form's empty override fields.
 * A suite can contain story-specific limits, so a multi-story launch may need
 * to show a range rather than pretend there is one inherited value.
 */
export function launchLimitPlaceholders(cases: WebDynamic = []) {
  return {
    maxSteps: range(cases.map((c: WebDynamic) => c.limits?.max_steps)),
    timeoutSeconds: range(cases.map((c: WebDynamic) => {
      const ms = c.limits?.timeout_ms;
      return Number.isFinite(ms) ? ms / 1000 : null;
    })),
  };
}

function range(values: WebDynamic) {
  const unique: WebDynamic = [...new Set(values.filter(Number.isFinite))].sort((a: WebDynamic, b: WebDynamic) => a - b);
  if (!unique.length) return "Default";
  if (unique.length === 1) return String(unique[0]);
  return `${unique[0]}–${unique.at(-1)}`;
}
