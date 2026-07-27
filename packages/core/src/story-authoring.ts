import fsp from "node:fs/promises";

const GUIDE_URL = new URL("./prompts/story-authoring.md", import.meta.url);
let cachedGuide: string | null = null;

/** Package-owned authoring guidance shared by local and hosted experiences. */
export async function storyAuthoringGuide() {
  if (cachedGuide === null) {
    const raw = await fsp.readFile(GUIDE_URL, "utf8");
    cachedGuide = raw.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  }
  return cachedGuide;
}
