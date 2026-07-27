// A scripted in-memory "web" driver for hermetic act/heal engine tests.
//
// The runner reaches a transport only through the Driver seam
// (src/core/driver.ts), so an object implementing that surface over a tiny
// named state machine runs record/act/heal — including heal re-anchoring
// (docs/contracts/engine.md#act-and-heal) — with the real runner, writer, and
// artifacts, but no browser. Screens are static snapshot texts keyed by state;
// transitions are keyed "<state> <ref>"; a `failOnce` entry makes the first
// execution of its transition fail so a replay escalates to heal. Injected via
// runCase's `driverFactory` test seam.
//
// Deterministic on purpose: normalizeSnapshot is identity, so two states are
// drift-equal exactly when their screen texts are byte-equal — the anchor
// oracle reduces to the fixture author's screen texts.

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
  agent?: { action?: ScriptedAction };
  action?: ScriptedAction;
}

export class ScriptedWebDriver {
  id = "web";
  declare state: string;
  declare screens: Record<string, ScriptedScreen>;
  declare transitions: Record<string, string>;
  declare failOnce: Set<string>;
  declare tick: number;

  constructor({ start, screens, transitions, failOnce = [] }: ScriptedWorld) {
    this.state = start;
    this.screens = screens;
    this.transitions = transitions;
    this.failOnce = new Set(failOnce);
    this.tick = 0; // effectToken component: bumps on every successful transition
  }

  async start() {
    return { ok: true };
  }

  async close() {}

  location() {
    return `app://${this.state}`;
  }

  async effectToken() {
    return `${this.state}:${this.tick}`;
  }

  async consoleErrors() {
    return 0;
  }

  consoleErrorLog() {
    return [];
  }

  normalizeSnapshot(text: string | null | undefined) {
    return text ?? "";
  }

  async captureSnapshot() {
    return { text: this.#screen().text, url: this.location(), screenshot: null };
  }

  async finalPageCheck(query: string) {
    return (this.#screen().elements ?? []).includes(query);
  }

  async execute(action: ScriptedAction) {
    return this.#run(action);
  }

  async executeLocator(baseStep: ScriptedStep) {
    return this.#run(baseStep.agent?.action ?? baseStep.action);
  }

  #screen() {
    const s = this.screens[this.state];
    if (!s) throw new Error(`scripted driver: unknown state "${this.state}"`);
    return s;
  }

  #run(action: ScriptedAction | undefined) {
    const base = {
      settle_ms: 1,
      perf: { input_to_paint_ms: null, long_tasks_ms: 0, requests: 0, js_errors: 0, nav: null },
      network: { requests: [] },
      har_entries: [],
      url: this.location(),
    };
    if (action?.type !== "click") {
      return { ok: false, error: `scripted driver: unsupported action "${action?.type}"`, ...base };
    }
    const key = `${this.state} ${action.ref}`;
    const resolution = { locator: `ref=${action.ref}` };
    if (this.failOnce.has(key)) {
      this.failOnce.delete(key);
      return { ok: false, error: `click on ${action.ref} failed: element is not interactable`, resolution, ...base };
    }
    const next = this.transitions[key];
    if (!next) {
      return { ok: false, error: `nothing at ${action.ref} on screen "${this.state}"`, resolution, ...base };
    }
    this.state = next;
    this.tick += 1;
    return { ok: true, error: null, resolution, ...base, url: this.location() };
  }
}
