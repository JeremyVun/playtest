export function makeRedactor(values: unknown[] = []): (input: unknown) => string {
  const needles = [...new Set(values.filter((v): v is string => typeof v === "string" && v.length >= 4))].sort((a, b) => b.length - a.length);
  return (input: unknown) => {
    let out = String(input ?? "");
    for (const n of needles) out = out.split(n).join("[redacted]");
    return out;
  };
}

export function collectSecretValues(spec: RunnerDynamic, sessions: Record<string, RunnerDynamic> = {}): unknown[] {
  const vals: unknown[] = Object.values(spec.environment?.resolved_secrets || {});
  for (const s of Object.values(sessions)) vals.push(JSON.stringify(s.storage_state || {}));
  return vals;
}
