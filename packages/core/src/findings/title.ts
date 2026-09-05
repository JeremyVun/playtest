export const GENERATED_FINDING_TITLE_MAX = 100;
export const STORED_FINDING_TITLE_MAX = 180;

export function normalizeFindingTitle(
  value: unknown,
  { maxLength = STORED_FINDING_TITLE_MAX, fallback = "" }: { maxLength?: number; fallback?: string } = {},
): string {
  const line = String(value ?? "").split("\n").find((part) => part.trim())?.replace(/\s+/g, " ").trim() || fallback;
  const characters = [...line];
  if (characters.length <= maxLength) return line;

  const clipped = characters.slice(0, Math.max(1, maxLength - 1)).join("");
  const boundary = clipped.lastIndexOf(" ");
  const stem = boundary >= Math.floor(maxLength * 0.6) ? clipped.slice(0, boundary) : clipped;
  return `${stem.replace(/[\s,;:/\-–—]+$/u, "")}…`;
}
