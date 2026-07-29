/**
 * @param {{ prefix?: string, rename?: boolean, entryStatus?: number, notices?: number }} options
 *   prefix      distinguishes one instance's ids from another's (default "A")
 *   rename      GET /accounts/{id} answers `available_balance` instead of `balance`
 *   entryStatus the status POST /entries answers (201 by default)
 *   notices     how many volatile notice objects an account carries
 * @returns {Promise<{ url, requests, close }>}
 */
export declare function startReplayApi({ prefix, rename, entryStatus, notices }?: LegacyTestValue): Promise<{
    url: string;
    requests: any;
    close: () => Promise<void>;
}>;
