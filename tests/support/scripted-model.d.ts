interface AuthoringTurn {
    script: string;
    notes?: string;
    revisions?: object[];
}
interface ModelMessage {
    content: unknown;
}
interface ModelCall {
    messages?: ModelMessage[];
}
interface AgentStep {
    thought: string;
    action: Record<string, unknown>;
    expectation: string;
}
/**
 * A scripted gateway for the authoring loop (docs/contracts/scripts.md).
 *
 * The loop reaches a model exactly once per turn, through the same
 * `POST /v1/chat/completions`, and expects prose with two fenced blocks rather
 * than a tool call — so a turn list of `{ script, notes, revisions }` makes the
 * whole loop hermetic: real handout, real runner, real fixture, real report,
 * with the only nondeterministic participant replaced by a list.
 *
 */
export declare function startScriptedAuthoringModel(turns: Array<AuthoringTurn | string>): Promise<{
    baseUrl: string;
    calls: (ModelCall | {
        unparseable: string;
    })[];
    prompts: string[];
    close: () => Promise<void>;
}>;
/**
 * Agent steps carry `{ thought, action, expectation }`.
 *
 * A run that also grades (hosted always does) reaches the same gateway with the
 * `grade` tool offered instead of `step`; answering it here is what lets a whole
 * hosted run group finish offline. `grade` replaces the canned verdict.
 */
export declare function startScriptedModel(steps: AgentStep[], { grade, delayMs }?: {
    grade?: object;
    delayMs?: number;
}): Promise<{
    baseUrl: string;
    calls: unknown[];
    close: () => Promise<void>;
}>;
export {};
