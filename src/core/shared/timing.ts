// The slideshow pace: how long one step holds on screen when the run is
// replayed as stills rather than a real screencast. Shared by the viewer
// autoplay (src/run-viewer/web/app.js, served at /shared/) and `playtest clip`'s
// no-video slideshow fallback (src/core/clip.ts) so both step at the same
// speed. Pure browser-safe ESM — a single product constant, no deps.
export const AUTOPLAY_MS = 600;
