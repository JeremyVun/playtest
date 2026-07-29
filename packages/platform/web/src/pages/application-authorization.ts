import { api } from "../lib/api.js";
import { h, mount } from "../lib/dom.js";
import {
  confirmModal,
  emptyState,
  errorState,
  formField,
  formModal,
  toast,
  toastError,
} from "../lib/ui.js";

export async function authProvidersPanel(projectKey: WebDynamic, applications: WebDynamic, slot: WebDynamic) {
  let items: WebDynamic = [];
  try {
    ({ items } = await api.cached(`/projects/${projectKey}/auth-providers`));
  } catch (err: WebDynamic) {
    return mount(slot, errorState(err, () => authProvidersPanel(projectKey, applications, slot)));
  }
  const refresh = () => authProvidersPanel(projectKey, applications, slot);
  const ringName = new Map<string, string>();
  for (const application of applications) {
    for (const ring of application.rings || []) ringName.set(ring.id, `${application.key}/${ring.key}`);
  }
  const add = h("button.btn.primary", {
    onclick: () => authProviderModal(projectKey, applications, null, refresh),
  }, "+ New provider");
  const body = items.length
    ? h("div", { style: "display:flex;flex-direction:column;gap:12px" },
        ...items.map((provider: WebDynamic) => h("div.card.pad", {},
          h("div", { style: "display:flex;align-items:center;gap:10px;flex-wrap:wrap" },
            h("span.id", {}, provider.name),
            h("span.chip", {}, provider.kind.replace(/_/g, " ")),
            h("span.chip", {}, provider.ring_id ? ringName.get(provider.ring_id) || "one ring" : "project-wide"),
            provider.enabled ? null : h("span.chip", {}, "disabled"),
            h("div", { style: "flex:1" }),
            h("button.btn.btn-sm", { "aria-label": `Mint a session for ${provider.name}`, onclick: () => mintProvider(provider, refresh) }, "Mint"),
            h("button.btn.btn-sm", { "aria-label": `Sessions minted by ${provider.name}`, onclick: () => sessionsModal(provider) }, "Sessions"),
            h("button.btn.btn-sm", { "aria-label": `Edit auth provider ${provider.name}`, onclick: () => authProviderModal(projectKey, applications, provider, refresh) }, "Edit"),
            h("button.btn.btn-sm.danger", { "aria-label": `Delete auth provider ${provider.name}`, onclick: () => deleteProvider(provider, refresh) }, "Delete"),
          ),
          h("div.dim", { style: "margin-top:6px;font-size:12px" },
            `identities: ${Object.keys(provider.identities || {}).join(", ") || "—"} · sessions last ${provider.ttl_minutes}m`),
          h("details.advanced", { style: "margin-top:8px" },
            h("summary", {}, "Configuration, as stored"),
            h("pre.mono", { style: "margin-top:8px;background:var(--bg2);padding:10px;border-radius:6px;overflow:auto;font-size:12px" },
              JSON.stringify(provider.config, null, 2))),
        )))
    : emptyState("No providers", "A provider mints short-lived sign-in states for the identities a ring names.");
  mount(slot, h("div", {}, h("div.section-actions", {}, add), body));
}

function authProviderModal(projectKey: WebDynamic, applications: WebDynamic, existing: WebDynamic, refresh: WebDynamic) {
  return formModal(existing ? `Edit ${existing.name}` : "New auth provider", () => {
    const name = h("input", { type: "text", value: existing?.name || "", placeholder: "sso" });
    const kind = h("select", {},
      ...["token_endpoint", "storage_state_secret", "script"].map((value) =>
        h("option", { value, selected: existing?.kind === value }, value.replace(/_/g, " "))));
    const ring = h("select", { "aria-label": "Ring" },
      h("option", { value: "" }, "Project-wide — every ring may use it"),
      ...applications.flatMap((application: WebDynamic) => (application.rings || []).map((item: WebDynamic) =>
        h("option", { value: item.id, selected: existing?.ring_id === item.id || undefined }, `${application.key}/${item.key}`))));
    const config = h("textarea.code", { style: "min-height:120px" },
      JSON.stringify(existing?.config || { url: "http://127.0.0.1:0/session" }, null, 2));
    const identities = h("textarea.code", { style: "min-height:110px" },
      JSON.stringify(existing?.identities || { member: {} }, null, 2));
    const ttl = h("input", { type: "number", min: "1", max: "1440", value: existing?.ttl_minutes || 60 });
    const enabled = h("input", { type: "checkbox", checked: existing?.enabled !== false });
    return h("form", { onsubmit: submit },
      formField("Name", name, "How a ring's identities refer to it: provider/identity."),
      formField("Kind", kind),
      formField("Ring", ring, "Bound: reachable only from that ring, and its mints carry the ring's routing labels. Project-wide: any ring may name it."),
      formField("Config JSON", config),
      formField("Identities JSON", identities),
      formField("TTL minutes", ttl, "How long a minted session is reused before it is minted again."),
      h("label.check", { style: "margin:6px 0 12px" }, enabled, "Enabled"),
      h("div.modal-actions", {},
        h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"),
        h("button.btn.primary", { type: "submit" }, "Save")),
    );

    async function submit(event: WebDynamic) {
      event.preventDefault();
      let parsedConfig;
      let parsedIdentities;
      try {
        parsedConfig = JSON.parse(config.value || "{}");
        parsedIdentities = JSON.parse(identities.value || "{}");
      } catch {
        return toast("JSON isn't valid", "", "err");
      }
      const payload = {
        name: name.value.trim(),
        kind: kind.value,
        config: parsedConfig,
        identities: parsedIdentities,
        ttl_minutes: Number(ttl.value),
        enabled: enabled.checked,
        ring_id: ring.value || null,
      };
      try {
        if (existing) await api.put(`/auth-providers/${existing.id}`, payload);
        else await api.post(`/projects/${projectKey}/auth-providers`, payload);
        close();
        toast("Auth provider saved", payload.name, "ok");
        refresh();
      } catch (err: WebDynamic) {
        toastError(err);
      }
    }
  });
}

async function mintProvider(provider: WebDynamic, refresh: WebDynamic) {
  try {
    const out = await api.post(`/auth-providers/${provider.id}/mint`, {});
    if (out.mint) toast("Mint dispatched", "a runner is minting this session — check Sessions shortly", "ok");
    else toast("Session minted", `${out.session.identity} until ${new Date(out.session.expires_at).toLocaleTimeString()}`, "ok");
    refresh();
  } catch (err: WebDynamic) {
    toastError(err);
  }
}

async function sessionsModal(provider: WebDynamic) {
  const close = formModal(`${provider.name} sessions`, () => h("div.dim", {}, "Loading…"));
  const root = document.querySelector("#modal-root .modal");
  if (!root) return close();
  try {
    const { items } = await api.get(`/auth-providers/${provider.id}/sessions`);
    mount(root,
      h("h3", {}, `${provider.name} sessions`),
      items.length
        ? h("table.rows", {},
            h("thead", {}, h("tr", {}, h("th", {}, "Identity"), h("th", {}, "Expires"), h("th", {}, "Minted by"))),
            h("tbody", {}, ...items.map((session: WebDynamic) => h("tr", {},
              h("td", {}, session.identity),
              h("td.dim", {}, new Date(session.expires_at).toLocaleString()),
              h("td", {}, session.minted_by_job || "—")))))
        : emptyState("No sessions", "No derived sessions have been minted yet."),
      h("div.modal-actions", {}, h("button.btn.primary", { onclick: () => close() }, "Close")));
  } catch (err: WebDynamic) {
    toastError(err);
    close();
  }
}

async function deleteProvider(provider: WebDynamic, refresh: WebDynamic) {
  const confirmed = await confirmModal({
    title: `Delete ${provider.name}?`,
    body: "Cached sessions for this provider will be removed.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.del(`/auth-providers/${provider.id}`);
    toast("Deleted", provider.name, "ok");
    refresh();
  } catch (err: WebDynamic) {
    toastError(err);
  }
}

export async function secretsPanel(projectKey: WebDynamic, slot: WebDynamic) {
  let items: WebDynamic = [];
  try {
    ({ items } = await api.cached(`/projects/${projectKey}/secrets`));
  } catch (err: WebDynamic) {
    return mount(slot, errorState(err, () => secretsPanel(projectKey, slot)));
  }
  const refresh = () => secretsPanel(projectKey, slot);
  const add = h("button.btn.primary", { onclick: () => secretModal(projectKey, refresh) }, "+ Add secret");
  const body = h("div", {},
    h("div.card.pad", { style: "margin-bottom:12px;color:var(--dim);font-size:12.5px" },
      "⚠ Secrets are write-only. Values are encrypted at rest and never shown again after you save them."),
    items.length
      ? h("div.card", {}, h("table.rows", {},
          h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Updated"), h("th", {}))),
          h("tbody", {}, ...items.map((secret: WebDynamic) => h("tr", {},
            h("td.mono", {}, secret.name),
            h("td.dim", {}, new Date(secret.updated_at).toLocaleDateString()),
            h("td", { style: "text-align:right" },
              h("button.btn.btn-sm", { style: "margin-right:6px", "aria-label": `Rotate secret ${secret.name}`, onclick: () => secretModal(projectKey, refresh, secret.name) }, "Rotate"),
              h("button.btn.btn-sm.danger", { "aria-label": `Delete secret ${secret.name}`, onclick: () => deleteSecret(projectKey, secret, refresh) }, "Delete")))))))
      : emptyState("No secrets", "Add API tokens, storage-state blobs, or cookie values here."));
  mount(slot, h("div", {}, h("div.section-actions", {}, add), body));
}

function secretModal(projectKey: WebDynamic, refresh: WebDynamic, rotateName: WebDynamic = null) {
  return formModal(rotateName ? `Rotate ${rotateName}` : "Add secret", () => {
    const name = h("input", { type: "text", value: rotateName || "", placeholder: "staging-seed-token" });
    if (rotateName) name.disabled = true;
    const value = h("textarea", {
      placeholder: rotateName ? "the new value (the old one is replaced on save)" : "the secret value",
      style: "min-height:80px",
    });
    return h("form", { onsubmit: submit },
      formField("Name", name, "letters, digits and _ . -"),
      formField("Value", value),
      h("div.modal-actions", {},
        h("button.btn.ghost", { type: "button", onclick: () => close() }, "Cancel"),
        h("button.btn.primary", { type: "submit" }, rotateName ? "Rotate" : "Save")));

    async function submit(event: WebDynamic) {
      event.preventDefault();
      try {
        await api.post(`/projects/${projectKey}/secrets`, { name: name.value.trim(), value: value.value });
        close();
        toast("Secret saved", name.value.trim(), "ok");
        refresh();
      } catch (err: WebDynamic) {
        toastError(err);
      }
    }
  });
}

async function deleteSecret(projectKey: WebDynamic, secret: WebDynamic, refresh: WebDynamic) {
  const confirmed = await confirmModal({
    title: `Delete secret ${secret.name}?`,
    body: "Rings and providers referencing it will fail until it is replaced.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.del(`/projects/${projectKey}/secrets/${encodeURIComponent(secret.name)}`);
    toast("Deleted", secret.name, "ok");
    refresh();
  } catch (err: WebDynamic) {
    toastError(err);
  }
}
