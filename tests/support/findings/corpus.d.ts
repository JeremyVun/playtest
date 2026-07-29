import type { FindingItem } from "./spec.ts";
declare const PROJECT = "proj_shop";
interface Raise {
    kind: string;
    note: string;
    severity: string;
}
interface Envelope {
    step: number;
    schema_version: number;
    ts: number;
    mode: string;
    result: {
        ok: boolean;
        error: string | null;
        settle_ms: number;
        url?: string;
    };
    agent?: {
        thought?: string;
        action?: {
            type: string;
            summary?: string;
            [key: string]: unknown;
        };
        expectation?: string;
        raises?: Raise[];
    };
    raises?: Raise[];
    resolution?: Record<string, unknown>;
    perf?: Record<string, unknown>;
    network?: {
        requests: Array<Record<string, unknown>>;
    };
    console_errors?: Array<Record<string, unknown>>;
    confusion?: Record<string, unknown>;
}
interface GradeFinding {
    severity: string;
    note: string;
    step: number;
}
interface Grade {
    score: number;
    completion: string;
    efficiency: {
        assessment: string;
        wasted_steps: number;
    };
    findings: GradeFinding[];
    summary: string;
    model: string;
    graded_at: string;
    tokens: {
        in: number;
        out: number;
        cache_read: number;
    };
    report?: unknown;
    [key: string]: unknown;
}
export interface CorpusCandidate extends FindingItem {
    run_id: string;
    persona: string;
    severity: string;
    evidence_steps: number[];
    signals: string[];
}
interface CandidateExpectation {
    classification: string;
    reviewer_label: string;
}
interface CorpusExpected {
    per_candidate: Record<string, CandidateExpectation>;
    exact_key: {
        incoming: string;
        existing: string;
        strict: boolean;
        loose: boolean;
    } | null;
    grouping: string[][];
    evidence_rows: number;
    routing: Record<string, string>;
    shortlist: Array<{
        of: string;
        must_include: string[];
        must_exclude: string[];
    }>;
    ux_only: CandidateExpectation;
    actor_claim_is_evidence: boolean;
    [key: string]: unknown;
}
export interface CorpusFixture {
    id: string;
    description: string;
    seeded: boolean;
    runs: Array<{
        run_id: string;
        project_id: string;
        story_id: string;
        case_id: string;
        persona: string;
        envelopes: Envelope[];
        grade: Grade;
    }>;
    candidates: CorpusCandidate[];
    expected: CorpusExpected;
}
export declare const FIXTURES: CorpusFixture[];
/** Flat list of every candidate across the corpus (for shortlist pooling). */
export declare function allCandidates(): CorpusCandidate[];
/** Index a candidate by id. */
export declare function candidateById(id: string): CorpusCandidate;
export { PROJECT };
