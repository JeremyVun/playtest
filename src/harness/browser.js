// The Playwright session moved to drivers/web.js (the `web` Driver) when the
// transport seam was extracted; see docs/CONTRACTS.md §16. This thin
// re-export keeps `import { Session } from "./browser.js"` and the pngDimensions
// self-test import resolving against the old path. New code imports the driver
// via createDriver (driver.js) or WebDriver/pngDimensions from drivers/web.js.
export { WebDriver, WebDriver as Session, pngDimensions } from "./drivers/web.js";
