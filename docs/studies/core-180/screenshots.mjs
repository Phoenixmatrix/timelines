// Screenshots of a study condition's starting screens, in a fresh browser
// context signed in as the repository owner (cookies are host-scoped, not
// port-scoped, so every run gets its own context).
//
//   node screenshots.mjs <worktree> <origin> <condition> <out-dir> <owner/name> <timeline-slug>
//
// Uses the condition worktree's own Playwright (installed by `vp run agent setup`).
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const [worktree, origin, condition, out, repo, timeline] = process.argv.slice(2);
if (!timeline)
  throw new Error(
    "usage: screenshots.mjs <worktree> <origin> <condition> <out> <repo> <timeline-slug>",
  );
const { chromium } = createRequire(join(worktree, "tools/agent/package.json"))("@playwright/test");
const [owner] = repo.split("/");

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto("/signin");
  await page.getByRole("button", { name: new RegExp(`Continue as ${owner}`, "i") }).click();
  await page.waitForURL((url) => url.pathname !== "/signin");
  const shots = [
    ["start", `/${repo}/knowledge`],
    ["timeline", `/${repo}/knowledge?tl=${encodeURIComponent(timeline)}`],
  ];
  for (const [name, path] of shots) {
    await page.goto(path);
    // Live build status may keep a request open: idle is best effort.
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    // Let the canvas settle its first frame.
    await page.waitForTimeout(3_000);
    const file = join(out, `${condition}-${name}.jpg`);
    await page.screenshot({ path: file, type: "jpeg", quality: 80 });
    console.log(JSON.stringify({ condition, name, url: `${origin}${path}`, file }));
  }
  await context.close();
} finally {
  await browser.close();
}
