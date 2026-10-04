import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { browserCommands } from "./vite/browser-commands.ts";
import { ciRunners } from "./vite/ci-runners.ts";
import { developmentEnvironment } from "./vite/environment.ts";

const local = developmentEnvironment(process.env);
// Only Vitest needs the browser provider: dev and build don't load Playwright.
const browserProvider = process.env.VITEST
  ? (await import("vite-plus/test/browser-playwright")).playwright
  : undefined;

// Remote bindings authenticate through the plugin's bundled wrangler unless this
// is set; with it, they reuse the `cf auth login` session instead.
process.env.CLOUDFLARE_CF_AUTH ??= "1";

export default defineConfig({
  // The Cloudflare plugin owns the dev server, which clashes with Vitest's own;
  // the unit tests are plain functions and don't need workerd.
  plugins: [
    react(),
    tailwindcss(),
    // Before the Cloudflare plugin, so its dispatch path never reaches the Worker.
    !process.env.VITEST && ciRunners(),
    !process.env.VITEST &&
      cloudflare({ persistState: { path: local.stateDir }, inspectorPort: false }),
  ],
  // The dev server's own port, strictly. Not under Vitest: the browser project
  // (`extends: true`) would inherit `strictPort` onto its browser server, which
  // starts at 63315 (`test.api`), so a second run elsewhere on this machine
  // failed to start instead of taking the next free port.
  server: process.env.VITEST ? {} : { host: local.host, port: local.port, strictPort: true },
  // Source highlighting loads late; discover its parsers before navigation,
  // rather than restarting the page when the dependency optimizer finds them.
  optimizeDeps: {
    include: [
      "@lezer/css",
      "@lezer/go",
      "@lezer/highlight",
      "@lezer/html",
      "@lezer/javascript",
      "@lezer/json",
      "@lezer/markdown",
      "@lezer/python",
      "@lezer/rust",
      "@lezer/xml",
      "@lezer/yaml",
      "yaml",
    ],
  },
  // Two projects (see "Testing" in README.md): Node unit tests of pure logic,
  // and browser-mode tests that render the app in headless Chromium against
  // mocked and in-memory APIs.
  test: {
    maxWorkers: 2,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "worker/**/*.test.ts",
            "registry/**/*.test.ts",
            "src/**/*.test.ts",
            "shared/**/*.test.ts",
            "vite/**/*.test.ts",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.tsx"],
          // Pages settle in well under a second; a missing element fails in 5s.
          expect: { poll: { timeout: 5_000 } },
          testTimeout: 30_000,
          browser: {
            enabled: true,
            // Chromium's headless shell, which `vp run agent setup` and CI install.
            headless: true,
            // Touch on, so tests can tap as well as click.
            provider: browserProvider?.({ contextOptions: { hasTouch: true } }),
            instances: [{ browser: "chromium" }],
            viewport: { width: 1280, height: 900 },
            screenshotFailures: false,
            commands: browserCommands,
          },
        },
      },
    ],
  },
});
