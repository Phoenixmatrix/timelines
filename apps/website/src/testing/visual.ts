// Pictures of the app for the step view (CORE-383). A browser test calls
// visual("Name") once the page shows something representative; with
// GITMATRIX_VISUALS_DIR set (CI's test job) the page is saved there as
// <Name>.png and tools/visuals/upload.ts attaches it to the commit. Otherwise
// it does nothing.

import { browserCommands } from "./server.ts";

/** Save the settled page as `name` (letters, digits, spaces, . _ -); false when not capturing. */
export async function visual(name: string): Promise<boolean> {
  await document.fonts.ready;
  // Two frames, so layout and paint from the last render have landed.
  for (let i = 0; i < 2; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
  return browserCommands.captureVisual(name);
}
