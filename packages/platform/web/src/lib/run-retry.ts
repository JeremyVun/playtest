const RETRYABLE = new Set(["infra", "lost"]);

/** Only placement failures with no started_at are safe to retry in place. */
export function retryableStoryCount(group: WebDynamic): number {
  return (group?.runs || []).filter(
    (run: WebDynamic) => RETRYABLE.has(run.status) && !run.started_at,
  ).length;
}

export function canRetryRun(group: WebDynamic, _stats?: WebDynamic): boolean {
  return group?.status === "done" && retryableStoryCount(group) > 0;
}
