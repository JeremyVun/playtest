/**
 * @param {{ token?: string, prefix?: string }} [options] `token` is the bearer
 *   value `/whoami` accepts.
 * @returns {Promise<{ url, origin, requests, close }>}
 */
export declare function startScriptApi({ token, prefix, resetFails }?: LegacyTestValue): Promise<{
    url: string;
    origin: string;
    token: any;
    requests: any;
    close: () => Promise<unknown>;
}>;
