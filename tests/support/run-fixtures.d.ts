/**
 * Build recorded, healed, and explored runs without launching a target app or
 * model. `healedSameTrack` adds a fourth run (mode "act") that healed but
 * re-took exactly the baseline actions — a transient replay failure where the
 * diff has zero changes. Opt-in: the server suite asserts exact run counts.
 */
export declare function makeRunsFixture(root: string, { healedSameTrack }?: {
    healedSameTrack?: boolean;
}): {
    runsRoot: string;
    recordDir: string;
    healDir: string;
    exploreDir: string;
    caseFile: string;
};
