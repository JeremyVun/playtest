// The slideshow pace: how long one step holds on screen when the run is
// replayed as stills rather than a real screencast. Shared by the viewer
// autoplay (bundled from packages/run-viewer/src/web/app.ts) and `playtest clip`'s
// no-video slideshow fallback (packages/core/src/clip.ts) so both step at the same
// speed. Pure browser-safe ESM — a single product constant, no deps.
export const AUTOPLAY_MS = 600;
