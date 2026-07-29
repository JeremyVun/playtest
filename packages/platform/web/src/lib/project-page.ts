import { h, mount } from "./dom.js";
import { renderFrame, page } from "./shell.js";
import { state } from "./state.js";
import { emptyState } from "./ui.js";

interface ProjectPageOptions {
  nav: string;
  title: string;
  loading?: string | Node | false;
  missingTitle?: string;
  missingBody?: string;
  missingAction?: Node | null;
}

/** Resolve a project and paint the shared missing/loading page states. */
export function projectPage(projectKey: string, options: ProjectPageOptions) {
  const main = renderFrame({ projectKey, nav: options.nav });
  const project = state.projectByKey.get(projectKey);
  if (!project) {
    mount(main, page({
      title: options.title,
      body: emptyState(
        options.missingTitle ?? "Not found",
        options.missingBody ?? "No such project.",
        options.missingAction ?? null,
      ),
    }));
    return null;
  }
  const loading = options.loading === undefined ? "Loading…" : options.loading;
  if (loading !== false) {
    mount(main, page({
      title: options.title,
      body: typeof loading === "string" ? h("div.dim", {}, loading) : loading,
    }));
  }
  return { main, project };
}
