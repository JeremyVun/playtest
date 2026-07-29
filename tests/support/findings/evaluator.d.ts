export declare function runEvaluation(): {
    thresholds: Readonly<{
        k: 5;
        floor: 0.25;
        auto_suggest: 0.6;
    }>;
    metrics: {
        candidate_recall: number;
        seeded_defects: number;
        precision_after_review: number;
        accepted: number;
        rejected: number;
        unresolved: number;
        exact_match_rate: number;
        exact_recurrence_pairs: number;
        shortlist_recall: number;
        shortlist_pairs: number;
        evidence_rows_retained: number;
    };
    cluster: {
        model_calls: number;
        candidates_per_call: number[];
        avg_candidates_per_call: number;
        input_tokens: number;
        clusters: {
            candidate_ids: string[];
            size: number;
            input_tokens: number;
        }[];
        per_candidate_calls_avoided: number;
    };
    discrepancies: string[];
};
/** The list of mismatches between computed behavior and recorded expectations. */
export declare function checkExpectations(): string[];
