// Inline stateless story drafting (docs/contracts/hosted.md#authoring). ONE
// editor-authorized endpoint drafts (or improves) a single Playtest story and
// returns it as an unsaved draft for the story form to fill. There is no
// session, no persisted transcript, and no commit path here: this handler READS
// suite state and calls the model, but writes NOTHING durable (no authoring row,
// platform event, suite snapshot, audit write, or file). The only durable write
// remains the ordinary human Save (POST /suites/:s/commit).
import { readJsonBody } from "../http.ts";
import { requireAuth, guard, getSuite, stringField } from "./util.ts";
import { badRequest } from "../errors.ts";
import { draftStory, requireAssistantConfigured } from "../authoring/assistant.ts";

// A clarification exchange stays short (the interview lost the plot beyond this,
// and the prompt would just keep growing); the browser holds it and resends it.
const MAX_TRANSCRIPT_ENTRIES = 40;
const MAX_MESSAGE_CHARS = 8000;
const MAX_EXISTING_YAML = 40_000;

/**
 * POST /suites/:s/story-draft [editor] — draft one story, or a small set when
 * the goal asks for one. Body:
 *   { goal, transcript?, existing_path?, existing_yaml?, hint? }
 * Responds with either { reply, needs_input: true, usage } (a clarifying
 * question) or { reply, draft, drafts, usage } where each draft is
 * { path, yaml, validation, lint }; `drafts` is the full proposed set
 * (usually one) and `draft` its final entry.
 */
export async function storyDraft(ctx: HostedDynamic) {
  requireAuth(ctx);
  const suite = await getSuite(ctx, ctx.params.s);
  guard(ctx, suite.project_id, "editor");
  requireAssistantConfigured();

  const body = await readJsonBody(ctx.req);
  const goal = stringField(body, "goal", { required: true, max: 4000 });
  const transcript = parseTranscript(body.transcript);
  const hint = stringField(body, "hint", { max: 200 }) || null;

  let existing: HostedDynamic = null;
  const existingPath = stringField(body, "existing_path", { max: 400 });
  if (existingPath) {
    const yaml = typeof body.existing_yaml === "string" ? body.existing_yaml : "";
    if (yaml.length > MAX_EXISTING_YAML) throw badRequest(`existing_yaml is too large (max ${MAX_EXISTING_YAML} chars)`);
    existing = { path: existingPath, yaml };
  }

  const result = await draftStory(ctx, {
    suite,
    project: { id: suite.project_id },
    goal,
    transcript,
    existing,
    hint,
  });
  return result;
}

/** Validate and bound the browser-held clarification transcript. */
function parseTranscript(raw: HostedDynamic) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw badRequest("transcript must be an array of { role, content } turns");
  if (raw.length > MAX_TRANSCRIPT_ENTRIES) {
    throw badRequest(`this conversation has grown too long (max ${MAX_TRANSCRIPT_ENTRIES} turns) — start a fresh draft`);
  }
  return raw.map((m, i) => {
    if (!m || typeof m !== "object") throw badRequest(`transcript[${i}] must be an object`);
    if (m.role !== "user" && m.role !== "assistant") throw badRequest(`transcript[${i}].role must be "user" or "assistant"`);
    if (typeof m.content !== "string") throw badRequest(`transcript[${i}].content must be a string`);
    if (m.content.length > MAX_MESSAGE_CHARS) throw badRequest(`transcript[${i}].content is too long (max ${MAX_MESSAGE_CHARS} chars)`);
    return { role: m.role, content: m.content };
  });
}
