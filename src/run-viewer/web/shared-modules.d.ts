declare module "*shared/movement.js" {
  interface SharedMovementEntry {
    run_id?: string | null;
    started_at?: string | null;
    status?: string | null;
    healed?: boolean;
    duration_ms?: number | null;
    steps?: number | null;
    score?: number | null;
    lcp_ms?: number | null;
    pins?: Record<string, unknown>;
  }

  interface SharedMovementDelta {
    prev: number | null;
    med: number | null;
  }

  interface SharedMovement {
    prev: SharedMovementEntry;
    duration: SharedMovementDelta;
    steps: SharedMovementDelta;
    lcp: SharedMovementDelta;
    score: SharedMovementDelta;
    scoreVsLastGraded?: number | null;
    statusMove?: string | null;
    statusStreak?: string | null;
    badge?: "regression" | "improved" | null;
  }

  export function movement(
    history: SharedMovementEntry[] | null | undefined,
    current: SharedMovementEntry | null | undefined
  ): SharedMovement | null;
}

declare module "*shared/timing.js" {
  export const AUTOPLAY_MS: number;
}
