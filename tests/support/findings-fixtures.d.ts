type Defect = "http_500" | "http_500_other_route" | "console";
interface Candidate {
    kind: string;
    severity: string;
    title: string;
    expected: string;
    observed: string;
    evidence_steps: number[];
    signals: string[];
}
interface MakeRunOptions {
    runId: string;
    caseId?: string;
    defect?: Defect;
    startedAt?: string;
    candidates?: Candidate[] | null;
}
/** A suite root with a playtest.yaml, plus an empty runs root beside it. */
export declare function makeSuite(root: string): {
    suite: string;
    runs: string;
};
/**
 * One recorded run whose grade carries `bug_candidates`.
 *
 * `candidates` overrides the recorded candidates.
 */
export declare function makeRun(runsRoot: string, { runId, caseId, defect, startedAt, candidates, }: MakeRunOptions): string;
/** A stable snapshot of every file under a directory: path → sha-free content length + mtime-free bytes. */
export declare function snapshotTree(root: string): Map<string, string>;
export {};
