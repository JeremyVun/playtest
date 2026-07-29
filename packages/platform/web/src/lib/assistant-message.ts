export type AssistantMessageBlock =
  | { kind: "paragraph"; text: string }
  | { kind: "unordered-list"; items: string[] }
  | { kind: "ordered-list"; items: string[]; start: number };

/**
 * Turn the assistant's small Markdown-like replies into safe display blocks.
 * Text stays text; only paragraph boundaries and list markers gain structure.
 */
export function assistantMessageBlocks(content: unknown): AssistantMessageBlock[] {
  const lines = String(content ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: AssistantMessageBlock[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };

  for (const line of lines) {
    const unordered = line.match(/^\s*[-*+]\s+(.+?)\s*$/);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+?)\s*$/);

    if (unordered) {
      flushParagraph();
      const item = unordered[1];
      if (!item) continue;
      const last = blocks.at(-1);
      if (last?.kind === "unordered-list") last.items.push(item);
      else blocks.push({ kind: "unordered-list", items: [item] });
      continue;
    }
    if (ordered) {
      flushParagraph();
      const marker = ordered[1];
      const item = ordered[2];
      if (!marker || !item) continue;
      const position = Number(marker);
      const last = blocks.at(-1);
      if (last?.kind === "ordered-list" && last.start + last.items.length === position) {
        last.items.push(item);
      } else {
        blocks.push({ kind: "ordered-list", start: position, items: [item] });
      }
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}
