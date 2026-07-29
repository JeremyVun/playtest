interface JsonRequest {
    method?: string;
    url?: string;
    body: LegacyTestValue;
}
export declare function startJsonServer(respond: (body: unknown, requestNumber: number) => unknown | Promise<unknown>): Promise<{
    url: string;
    requests: () => JsonRequest[];
    close: () => Promise<void>;
}>;
export declare function textCompletion(content?: string): {
    choices: {
        index: number;
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
    }[];
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
    };
};
export declare function toolCompletion(name: string, args: unknown): {
    choices: {
        index: number;
        message: {
            role: string;
            content: null;
            tool_calls: {
                id: string;
                type: string;
                function: {
                    name: string;
                    arguments: string;
                };
            }[];
        };
        finish_reason: string;
    }[];
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
    };
};
export {};
