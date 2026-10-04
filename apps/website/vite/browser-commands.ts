// Server-side commands for the browser-mode tests (src/**/*.browser.test.tsx,
// "Testing" in README.md). They run in Vitest's Node process, so a test in
// Chromium can reach what a page can't do by itself: the in-memory API
// (worker/testing/browser-api.ts, real Worker routes over node:sqlite),
// media emulation, and touch.

import { registerHooks } from "node:module";
import type { BrowserCommand } from "vite-plus/test/node";

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
      "export class DurableObject {}",
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

export const browserCommands = { gmWorld, gmServe, emulateMedia, tap };
