/**
 * Boot one todo-app instance. State (todos, ids) is per-instance: two
 * concurrent starts never share anything.
 *
 * `apiFault` seeds an API-layer defect that the UI cannot show you — the whole
 * point of passive cross-layer assertions
 * (docs/contracts/engine.md#invariant-policies). Default null: the app is
 * correct, and every existing caller is unaffected.
 *
 *   "created-status"  POST /api/todos answers 200 instead of the declared 201.
 *                     The page's fetch helper only checks `res.ok`, so the todo
 *                     is added and rendered exactly as always: the element
 *                     check passes, api_called passes, the screenshot is
 *                     identical. Only the OpenAPI document knows better.
 *
 * @param {{ port?: number, variant?: string|null, apiFault?: string|null }} [opts]
 *   port 0 = ephemeral
 * @returns {Promise<{ url: string, port: number, close: () => Promise<void> }>}
 */
export declare function start({ port, variant, apiFault }?: LegacyTestValue): Promise<{
    url: string;
    port: number;
    close: () => Promise<void>;
}>;
