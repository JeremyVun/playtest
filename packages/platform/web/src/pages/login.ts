// Login screen — shown to an unauthenticated visitor (OIDC mode). "Sign in" starts
// the code flow at /auth/login, which returns to the deep link the user came for.
import { h, mount } from "../lib/dom.js";

export function loginScreen() {
  const returnTo = location.pathname === "/login" ? "/" : location.pathname + location.search;
  const app = document.getElementById("app");
  app.removeAttribute("aria-busy");
  mount(app,
    h("div.login-wrap", {},
      h("div.login-card", {},
        h("span.brand", {}, h("svg", { viewBox: "0 0 16 16", width: 18, height: 18, html: '<path fill="var(--accent)" d="M4 3l9 5-9 5z"/>' }), "Playtest"),
        h("p", {}, "User-journey regression testing for your team's apps."),
        h("a.btn.primary", { href: `/auth/login?returnTo=${encodeURIComponent(returnTo)}`, style: "width:100%;justify-content:center" }, "Sign in with SSO"),
      ),
    ),
  );
}
