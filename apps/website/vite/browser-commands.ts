// Server-side commands for the browser-mode tests (src/**/*.browser.test.tsx,
// "Testing" in README.md). They run in Vitest's Node process, so a test in
// Chromium can reach what a page can't do by itself: the in-memory API
// (worker/testing/browser-api.ts, real Worker routes over node:sqlite),
// media emulation, and touch.

import { mkdir, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import type { BrowserCommand } from "vite-plus/test/node";
import { STEP_ARTIFACT_LIMITS } from "../shared/steps.ts";

/** What the in-memory API module exports; loaded by Node itself, not bundled into the config. */
interface BrowserApiModule {
  world(action: string, input: unknown): Promise<unknown>;
  serve(request: unknown): Promise<unknown>;
}

let loaded: Promise<BrowserApiModule> | undefined;

/**
 * Load the in-memory API with Node's own loader (it strips TypeScript types),
 * so the Worker's routes don't pass through this config's bundler. The few
 * modules that import Workers runtime classes get inert stand-ins.
 */
function browserApi(): Promise<BrowserApiModule> {
  if (!loaded) {
    const stub = [
      "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
      "export class WorkflowEntrypoint {}",
      "export class WorkerEntrypoint {}",
      "export class RpcTarget {}",
      "export class EmailMessage {}",
      "export const env = {};",
    ].join("\n");
    registerHooks({
      resolve(specifier, context, next) {
        if (specifier.startsWith("cloudflare:"))
          return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true };
        return next(specifier, context);
      },
    });
    const url = new URL("../worker/testing/browser-api.ts", import.meta.url).href;
    loaded = import(/* @vite-ignore */ url) as Promise<BrowserApiModule>;
  }
  return loaded;
}

const gmWorld: BrowserCommand<[action: string, input: unknown]> = async (_, action, input) =>
  (await browserApi()).world(action, input);

const gmServe: BrowserCommand<[request: unknown]> = async (_, request) =>
  (await browserApi()).serve(request);

/** prefers-reduced-motion and prefers-color-scheme, as a person's settings would set them. */
const emulateMedia: BrowserCommand<
  [media: { reducedMotion?: "reduce" | "no-preference"; colorScheme?: "light" | "dark" }]
> = async (ctx, media) => {
  if (!("page" in ctx)) throw new Error("emulateMedia needs the Playwright provider");
  await ctx.page.emulateMedia(media);
};

/** A real touch tap (the context has touch), on what `selector` finds in the test's frame. */
const tap: BrowserCommand<[selector: string]> = async (ctx, selector) => {
  if (!("frame" in ctx)) throw new Error("tap needs the Playwright provider");
  await (await ctx.frame()).locator(selector).tap();
};

/**
 * A picture of the rendered test page (CORE-383), written to
 * $GITMATRIX_VISUALS_DIR/<name>.png for CI to attach to the commit's step.
 * Returns false, doing nothing, when that directory isn't set. The name obeys
 * the step artifact rules, so a bad one fails the test that wrote it, but a
 * screenshot that can't be taken never does.
 */
const captureVisual: BrowserCommand<[name: string]> = async (ctx, name) => {
  if (!STEP_ARTIFACT_LIMITS.name.test(name))
    throw new Error(`visual("${name}"): a name is letters, digits, spaces, . _ - (80 at most)`);
  const dir = process.env.GITMATRIX_VISUALS_DIR;
  if (!dir) return false;
  if (!("iframe" in ctx)) throw new Error("captureVisual needs the Playwright provider");
  try {
    // The test page is an iframe at the configured viewport; shoot just that.
    // Times ("3 minutes ago") are masked: they differ between runs of the same UI.
    const frame = await ctx.frame();
    const png = await ctx.iframe
      .owner()
      .screenshot({ animations: "disabled", caret: "hide", mask: [frame.locator("time")] });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.png`), png);
    return true;
  } catch (error) {
    console.warn(`visual("${name}") was not captured: ${String(error)}`);
    return false;
  }
};

export const browserCommands = { gmWorld, gmServe, emulateMedia, tap, captureVisual };
