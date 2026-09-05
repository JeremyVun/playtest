import { test } from "node:test";
import assert from "node:assert/strict";

interface Entry {
  state: unknown;
  url: string;
}

class FakeHistory {
  private entries: Entry[] = [{ state: null, url: "/edit" }];
  private position = 0;
  private readonly surface: EventTarget;
  private readonly current: { pathname: string; search: string };

  constructor(surface: EventTarget, current: { pathname: string; search: string }) {
    this.surface = surface;
    this.current = current;
  }

  get state() {
    return this.entries[this.position]?.state ?? null;
  }

  pushState(state: unknown, _unused: string, url?: string | URL | null) {
    const next = this.resolve(url);
    this.entries.splice(this.position + 1, Infinity, { state, url: next });
    this.position += 1;
    this.apply(next);
  }

  replaceState(state: unknown, _unused: string, url?: string | URL | null) {
    const next = this.resolve(url);
    this.entries[this.position] = { state, url: next };
    this.apply(next);
  }

  go(delta = 0) {
    const destination = this.position + delta;
    if (destination < 0 || destination >= this.entries.length) return;
    queueMicrotask(() => {
      this.position = destination;
      const entry = this.entries[this.position];
      if (!entry) return;
      this.apply(entry.url);
      const event = new Event("popstate");
      Object.defineProperty(event, "state", { value: entry.state });
      this.surface.dispatchEvent(event);
    });
  }

  back() {
    this.go(-1);
  }

  forward() {
    this.go(1);
  }

  private resolve(url?: string | URL | null) {
    if (url == null) return this.entries[this.position]?.url ?? "/";
    const parsed = new URL(String(url), `https://playtest.test${this.current.pathname}${this.current.search}`);
    return parsed.pathname + parsed.search;
  }

  private apply(url: string) {
    const parsed = new URL(url, "https://playtest.test");
    this.current.pathname = parsed.pathname;
    this.current.search = parsed.search;
  }
}

const settleHistory = () => new Promise<void>((resolve) => setImmediate(resolve));

test("router protects dirty editors across navigation, history, and unload", async () => {
  const surface = new EventTarget();
  const current = { pathname: "/edit", search: "" };
  const fakeHistory = new FakeHistory(surface, current);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: surface },
    location: { configurable: true, value: current },
    history: { configurable: true, value: fakeHistory },
    document: { configurable: true, value: { getElementById: () => null } },
  });

  const { navigate, route, setNavigationBlocker, startRouter } = await import("../src/lib/router.js");
  const renders = new Map<string, number>();
  for (const path of ["/edit", "/list", "/edit-next", "/deleted", "/forced"]) {
    route(path, () => { renders.set(path, (renders.get(path) ?? 0) + 1); });
  }
  startRouter();

  let dirty = true;
  let firstPrompts = 0;
  let prompts = 0;
  const owner = {};
  setNavigationBlocker(owner, {
    shouldBlock: () => dirty,
    confirm: () => { firstPrompts += 1; return false; },
  });
  setNavigationBlocker(owner, {
    shouldBlock: () => dirty,
    confirm: () => { prompts += 1; return false; },
  });

  await navigate("/list");
  assert.equal(current.pathname, "/edit");
  assert.equal(renders.get("/edit"), 1);
  assert.equal(firstPrompts, 0, "rerenders replace the prior editor guard");
  assert.equal(prompts, 1);

  dirty = false;
  navigate("/list");
  assert.equal(current.pathname, "/list", "a saved editor leaves without another prompt");
  assert.equal(prompts, 1);
  navigate("/edit-next");

  let approveHistory = false;
  let historyPrompts = 0;
  dirty = true;
  setNavigationBlocker({}, {
    shouldBlock: () => dirty,
    confirm: () => { historyPrompts += 1; return approveHistory; },
  });
  fakeHistory.back();
  await settleHistory();
  assert.equal(current.pathname, "/edit-next", "cancelling Back restores the draft URL");
  assert.equal(renders.get("/list"), 1, "the destination is not rendered behind the prompt");
  assert.equal(historyPrompts, 1);

  approveHistory = true;
  fakeHistory.back();
  await settleHistory();
  assert.equal(current.pathname, "/list");
  assert.equal(renders.get("/list"), 2);

  fakeHistory.replaceState(fakeHistory.state, "", "/list?open=one");
  approveHistory = false;
  setNavigationBlocker({}, {
    shouldBlock: () => dirty,
    confirm: () => { historyPrompts += 1; return approveHistory; },
  });
  fakeHistory.forward();
  await settleHistory();
  assert.equal(current.pathname, "/list", "cancelling Forward restores the draft URL");
  assert.equal(current.search, "?open=one", "restoration keeps query-only UI state");

  const dirtyUnload = new Event("beforeunload", { cancelable: true });
  surface.dispatchEvent(dirtyUnload);
  assert.equal(dirtyUnload.defaultPrevented, true);
  dirty = false;
  const cleanUnload = new Event("beforeunload", { cancelable: true });
  surface.dispatchEvent(cleanUnload);
  assert.equal(cleanUnload.defaultPrevented, false);

  dirty = true;
  approveHistory = true;
  fakeHistory.forward();
  await settleHistory();
  assert.equal(current.pathname, "/edit-next");

  let rapidPrompts = 0;
  setNavigationBlocker({}, {
    shouldBlock: () => true,
    confirm: () => { rapidPrompts += 1; return false; },
  });
  fakeHistory.back();
  fakeHistory.back();
  await settleHistory();
  assert.equal(current.pathname, "/edit-next", "rapid Back events still restore the draft entry");
  assert.equal(rapidPrompts, 1, "rapid Back events share one decision");

  let resolveStale: (confirmed: boolean) => void = () => {};
  const staleAnswer = new Promise<boolean>((resolve) => { resolveStale = resolve; });
  setNavigationBlocker({}, { shouldBlock: () => true, confirm: () => staleAnswer });
  const staleNavigation = navigate("/deleted");
  setNavigationBlocker({}, { shouldBlock: () => true, confirm: () => false });
  resolveStale(true);
  await staleNavigation;
  assert.equal(current.pathname, "/edit-next", "approval from a replaced editor cannot discard the new draft");

  let resolveOverlap: (confirmed: boolean) => void = () => {};
  const overlapAnswer = new Promise<boolean>((resolve) => { resolveOverlap = resolve; });
  setNavigationBlocker({}, { shouldBlock: () => true, confirm: () => overlapAnswer });
  const overlappingNavigation = navigate("/deleted");
  fakeHistory.back();
  await Promise.resolve();
  resolveOverlap(true);
  await overlappingNavigation;
  await settleHistory();
  assert.equal(current.pathname, "/deleted", "internal navigation waits for an overlapping Back to be restored");

  let deletePrompts = 0;
  setNavigationBlocker({}, {
    shouldBlock: () => true,
    confirm: () => { deletePrompts += 1; return false; },
  });
  navigate("/forced", { guard: false });
  assert.equal(current.pathname, "/forced", "an already-confirmed destructive action can leave once");
  assert.equal(deletePrompts, 0);
});
