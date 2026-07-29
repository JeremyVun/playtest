/**
 * @param {{ token: string }} options the bearer token every authenticated route
 *   demands. Throwaway, supplied per test — never a real credential.
 * @returns {Promise<{ url: string, close: () => Promise<void>, requests: object[] }>}
 */
export declare function startAuthApi({ token }: LegacyTestValue): Promise<{
    url: string;
    requests: any;
    close: () => Promise<void>;
}>;
