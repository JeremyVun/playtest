interface ScriptedScreen {
    text: string;
    elements?: string[];
}
interface ScriptedWorld {
    start: string;
    screens: Record<string, ScriptedScreen>;
    transitions: Record<string, string>;
    failOnce?: string[];
}
interface ScriptedAction {
    type?: string;
    ref?: string;
}
interface ScriptedStep {
    agent?: {
        action?: ScriptedAction;
    };
    action?: ScriptedAction;
}
export declare class ScriptedWebDriver {
    #private;
    id: string;
    state: string;
    screens: Record<string, ScriptedScreen>;
    transitions: Record<string, string>;
    failOnce: Set<string>;
    tick: number;
    constructor({ start, screens, transitions, failOnce }: ScriptedWorld);
    start(): Promise<{
        ok: boolean;
    }>;
    close(): Promise<void>;
    location(): string;
    effectToken(): Promise<string>;
    consoleErrors(): Promise<number>;
    consoleErrorLog(): never[];
    normalizeSnapshot(text: string | null | undefined): string;
    captureSnapshot(): Promise<{
        text: string;
        url: string;
        screenshot: null;
    }>;
    finalPageCheck(query: string): Promise<boolean>;
    execute(action: ScriptedAction): Promise<{
        settle_ms: number;
        perf: {
            input_to_paint_ms: null;
            long_tasks_ms: number;
            requests: number;
            js_errors: number;
            nav: null;
        };
        network: {
            requests: never[];
        };
        har_entries: never[];
        url: string;
        ok: boolean;
        error: string;
    } | {
        settle_ms: number;
        perf: {
            input_to_paint_ms: null;
            long_tasks_ms: number;
            requests: number;
            js_errors: number;
            nav: null;
        };
        network: {
            requests: never[];
        };
        har_entries: never[];
        url: string;
        ok: boolean;
        error: string;
        resolution: {
            locator: string;
        };
    } | {
        settle_ms: number;
        perf: {
            input_to_paint_ms: null;
            long_tasks_ms: number;
            requests: number;
            js_errors: number;
            nav: null;
        };
        network: {
            requests: never[];
        };
        har_entries: never[];
        ok: boolean;
        error: null;
        resolution: {
            locator: string;
        };
        url: string;
    }>;
    executeLocator(baseStep: ScriptedStep): Promise<{
        settle_ms: number;
        perf: {
            input_to_paint_ms: null;
            long_tasks_ms: number;
            requests: number;
            js_errors: number;
            nav: null;
        };
        network: {
            requests: never[];
        };
        har_entries: never[];
        url: string;
        ok: boolean;
        error: string;
    } | {
        settle_ms: number;
        perf: {
            input_to_paint_ms: null;
            long_tasks_ms: number;
            requests: number;
            js_errors: number;
            nav: null;
        };
        network: {
            requests: never[];
        };
        har_entries: never[];
        url: string;
        ok: boolean;
        error: string;
        resolution: {
            locator: string;
        };
    } | {
        settle_ms: number;
        perf: {
            input_to_paint_ms: null;
            long_tasks_ms: number;
            requests: number;
            js_errors: number;
            nav: null;
        };
        network: {
            requests: never[];
        };
        har_entries: never[];
        ok: boolean;
        error: null;
        resolution: {
            locator: string;
        };
        url: string;
    }>;
}
export {};
