# Hosted UI refresh implementation

Scope: the owner's selected B polish plus the five-item review response in
[design.md](design.md). Replay behavior stays unchanged.

- [x] Protect unsaved story and suite-settings edits during navigation and exit.
- [x] Generate concise complete finding titles; retain full evidence and stable matching.
- [x] Add Findings text search and severity filtering, consistent downloads and counts.
- [x] Tidy copy and apply the selected compact rail/table/control polish.
- [x] Run typecheck, offline tests and focused browser checks in both themes.
- [x] Update contracts and record verification and remaining limitations.

Implementation ownership: router/editor protection, title pipeline, UI copy/polish,
and Findings controls are separate scopes. Integrate in the shared checkout;
do not modify stored project data or deploy as part of this change.

## Verification

- Root typecheck and production builds pass.
- All 1,040 offline tests pass, with zero skips.
- 31 Findings/auto-resolution/title integration tests and 9 suite integration
  tests pass against a disposable PostgreSQL 18 cluster.
- All 16 control-plane Chromium tests pass. They verify search, severity,
  downloads, stale-response handling and
  focus retention. Editor checks cover history, reload, Form/YAML, dirty Import,
  delayed saves and completion after leaving the editor.
- Runs, Findings and Story were inspected at 1440×900 and 1024×768 in both
  themes. The final 12 screenshots are in `/tmp/playtest-hosted-ui-final`.
  At narrower widths, existing finding metadata moves beneath the title.
- Search's regression test rejects an intentionally broken predicate. Cursor
  coverage changes the page boundary finding's `last_seen` between requests.
- Replay behavior and stored historical titles remain unchanged. New title
  prompts retain evidence detail separately and preserve legacy matching inputs.
- No deployment, live data changes, or `.env` reads were performed.
