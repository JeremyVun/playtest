import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import { formField, toast, toastError } from "../lib/ui.js";

/** Project-wide worker pool inherited by suites without their own override. */
export function runsSettingsTab(projectKey: WebDynamic, project: WebDynamic, slot: WebDynamic) {
  const current = project.parallel || { total: 1, record: 1 };
  const total = h("input", { type: "number", min: "1", step: "1", value: current.total });
  const record = h("input", { type: "number", min: "1", step: "1", value: current.record });
  const saveBtn = h("button.btn.primary", { onclick: save }, "Save");
  mount(slot, h("section", {},
    h("h3.section-title", { style: "margin-top:0" }, "Run concurrency"),
    h("p.dim.section-caption", {},
      "The worker budget every suite inherits. A suite can replace it from Suite settings when its target or model limits need a different pool."),
    h("div.card.pad", {},
      h("div.run-limits-fields", {},
        formField("Concurrent stories", total,
          "Maximum stories in flight across model-driven recordings and baseline checks."),
        formField("Concurrent recordings", record,
          "Maximum model-driven stories in flight. Baseline checks can use the remaining workers.")),
      h("div.form-actions", {}, saveBtn))));

  async function save() {
    const parallel = { total: Number(total.value), record: Number(record.value) };
    if (!Number.isSafeInteger(parallel.total) || parallel.total < 1 ||
        !Number.isSafeInteger(parallel.record) || parallel.record < 1) {
      return toast("Use positive whole numbers", "Both concurrency values must be at least 1.", "err");
    }
    if (parallel.record > parallel.total) {
      return toast("Recording cap is too high", "Concurrent recordings cannot exceed concurrent stories.", "err");
    }
    saveBtn.disabled = true;
    try {
      const updated = await api.put(`/projects/${projectKey}/parallel`, parallel);
      project.parallel = updated.parallel;
      toast("Run concurrency saved", `${parallel.total} concurrent · ${parallel.record} recording`, "ok");
    } catch (err: WebDynamic) {
      toastError(err);
    } finally {
      saveBtn.disabled = false;
    }
  }
}
