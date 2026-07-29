import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantMessageBlocks } from "../src/lib/assistant-message.js";

test("assistant messages preserve paragraphs and turn bullet points into list items", () => {
  assert.deepEqual(
    assistantMessageBlocks(
      "I need one choice before I draft.\n\n" +
      "Story type:\n" +
      "- **Regression journey** — a pass/fail check\n" +
      "- **Discovery story** — an open-ended study\n\n" +
      "Which should I use?",
    ),
    [
      { kind: "paragraph", text: "I need one choice before I draft." },
      { kind: "paragraph", text: "Story type:" },
      {
        kind: "unordered-list",
        items: [
          "**Regression journey** — a pass/fail check",
          "**Discovery story** — an open-ended study",
        ],
      },
      { kind: "paragraph", text: "Which should I use?" },
    ],
  );
});

test("assistant messages support numbered points and normalize line endings", () => {
  assert.deepEqual(
    assistantMessageBlocks("2) Second point\r\n3. Third point\r\n\r\nFinal paragraph."),
    [
      { kind: "ordered-list", start: 2, items: ["Second point", "Third point"] },
      { kind: "paragraph", text: "Final paragraph." },
    ],
  );
});

test("assistant messages keep unmarked hard line breaks inside a paragraph", () => {
  assert.deepEqual(
    assistantMessageBlocks("First line\nSecond line"),
    [{ kind: "paragraph", text: "First line\nSecond line" }],
  );
});
