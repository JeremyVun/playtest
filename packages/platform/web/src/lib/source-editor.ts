import { h, clear } from "./dom.js";
import { confirmModal, saveBar } from "./ui.js";

interface SourceState {
  raw: string;
  savedRaw: string;
  view: "form" | "yaml";
}

interface SourceEditorOptions<T> {
  state: SourceState;
  parse: (raw: string) => T;
  renderForm: (parsed: T, changed: () => void) => Node;
  rerender: () => void;
  save: () => void | Promise<void>;
  check: () => Promise<boolean | undefined>;
  discardBody: string;
  yamlLabel?: string;
  onChange?: () => void;
  onDiscard?: () => void;
}

/**
 * Shared controller for editors whose Form and YAML views edit one canonical
 * source string. Domain forms, validation requests, and persistence stay with
 * their owning page.
 */
export function sourceEditor<T>(options: SourceEditorOptions<T>) {
  const { state: st } = options;
  const editorSlot = h("div.editor-slot");
  let checksOk = true;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  const bar = saveBar({ onSave: options.save, onDiscard: discard });
  const paintBar = () => bar.set({ dirty: st.raw !== st.savedRaw, invalid: !checksOk });
  const toggle = h("div.seg", {},
    h("button", { class: st.view === "form" ? "on" : "", onclick: () => switchView("form") }, "Form"),
    h("button", { class: st.view === "yaml" ? "on" : "", onclick: () => switchView("yaml") }, "YAML"),
  );

  function scheduleChecks() {
    options.onChange?.();
    paintBar();
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(runChecks, 350);
  }

  function switchView(view: "form" | "yaml") {
    if (view === st.view) return;
    st.view = view;
    options.rerender();
  }

  function paintEditor() {
    clear(editorSlot);
    if (st.view === "yaml") {
      editorSlot.append(h("textarea.code", {
        spellcheck: "false",
        value: st.raw,
        "aria-label": options.yamlLabel || "YAML source",
        oninput: (event: InputEvent) => {
          st.raw = (event.currentTarget as HTMLTextAreaElement).value;
          scheduleChecks();
        },
      }));
      return;
    }
    let parsed: T;
    try {
      parsed = options.parse(st.raw);
    } catch (error) {
      editorSlot.append(h("div.card.pad", {},
        h("div.status.fail", {}, h("span.glyph", {}, "✗"), "This file isn't valid YAML"),
        h("p.dim", { style: "margin-top:6px" }, error instanceof Error ? error.message : String(error)),
        h("button.btn", { style: "margin-top:10px", onclick: () => switchView("yaml") }, "Edit in YAML"),
      ));
      return;
    }
    editorSlot.append(options.renderForm(parsed, scheduleChecks));
  }

  async function runChecks() {
    const result = await options.check();
    if (typeof result === "boolean") checksOk = result;
    paintBar();
  }

  async function discard() {
    const ok = await confirmModal({
      title: "Discard your changes?",
      body: options.discardBody,
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      danger: true,
    });
    if (!ok) return;
    st.raw = st.savedRaw;
    options.onDiscard?.();
    paintEditor();
    scheduleChecks();
  }

  return {
    bar,
    editorSlot,
    toggle,
    paintBar,
    paintEditor,
    scheduleChecks,
    switchView,
    initialize() {
      options.onChange?.();
      paintEditor();
      paintBar();
      void runChecks();
    },
  };
}
