/**
 * @param {object} options
 *   prefix              per-instance id prefix (default "A")
 *   pageSize            entries per page of GET /entries (default 2)
 *   closeGhost          a CLOSED account still accepts entries (semantic regression)
 *   softDelete          DELETE marks the account deleted; GET answers 200 with status "deleted"
 *   deleteGhost         DELETE reports success but the account is untouched
 *   paginationDup       page 2 repeats the boundary entry
 *   idempotencyDouble   a replayed Idempotency-Key mints a NEW entry
 *   errorShapeDrift     422 answers a bare { message } instead of the error envelope
 *   ownerDrift          GET /accounts/{id} answers a mangled owner (round-trip violation)
 *   serverError         GET /accounts/{id} answers 500
 *   undocumentedStatus  POST /accounts answers 202, which the spec does not declare
 *   textResponse        GET /accounts/{id} answers text/plain
 *   rename              GET /accounts/{id} answers `available_balance` instead of `balance`
 *   renameTimestamp     the ACCOUNT view answers `opened_at` instead of `created_at` —
 *                       a real surface change that breaks no declared expectation,
 *                       which is what an ACCEPTABLE contract drift looks like
 * @returns {Promise<{ url, requests, close }>}
 */
export declare function startInvariantApi(options?: LegacyTestValue): Promise<{
    url: string;
    requests: any;
    close: () => Promise<void>;
}>;
