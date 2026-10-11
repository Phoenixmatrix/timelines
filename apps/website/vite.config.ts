import { cloudflare } from "@cloudflare/vite-plugin";
import { readFileSync, watchFile, unwatchFile } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import type { Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import { defineConfig, normalizePath } from "vite-plus";
import { browserCommands } from "./vite/browser-commands.ts";
import { ciRunners } from "./vite/ci-runners.ts";
import { DEV_AI_OPT_IN, developmentEnvironment } from "./vite/environment.ts";

const local = developmentEnvironment(process.env);
const credentialChannel =
  process.env.GITMATRIX_REMOTE_HOSTED === "1"
    ? process.env.GITMATRIX_REMOTE_CREDENTIALS_FILE
    : undefined;
function refreshHostedCredentials(): void {
  if (!credentialChannel) return;
  const { env } = JSON.parse(readFileSync(credentialChannel, "utf8")) as {
    env: { CLOUDFLARE_API_TOKEN: string; CLOUDFLARE_ACCOUNT_ID: string };
  };
  if (
    typeof env?.CLOUDFLARE_API_TOKEN !== "string" ||
    !env.CLOUDFLARE_API_TOKEN ||
    env.CLOUDFLARE_ACCOUNT_ID !== process.env.CLOUDFLARE_ACCOUNT_ID
  )
    throw new Error("Hosted Cloudflare credential channel is invalid or changed accounts.");
  process.env.CLOUDFLARE_API_TOKEN = env.CLOUDFLARE_API_TOKEN;
}
refreshHostedCredentials();
// Only Vitest needs the browser provider: dev and build don't load Playwright.
const browserProvider = process.env.VITEST
  ? (await import("vite-plus/test/browser-playwright")).playwright
  : undefined;

// Browser-mode tests share one Chromium. When the host is short of memory
// (other agents' runs, CORE-306), one page at a time keeps the kernel from
// killing its renderer; tools/agent/website-tests.ts handles a crash anyway.
const LOW_MEMORY = 4 * 2 ** 30;
function availableMemory(): number {
  try {
    const kib = /^MemAvailable:\s+(\d+) kB$/m.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];
    return kib ? Number(kib) * 1024 : Infinity;
  } catch {
    return Infinity;
  }
}

// Remote bindings authenticate through the plugin's bundled wrangler unless this
// is set; with it, they reuse the `cf auth login` session instead.
process.env.CLOUDFLARE_CF_AUTH ??= "1";

export default defineConfig({
  // The Cloudflare plugin owns the dev server, which clashes with Vitest's own;
  // the unit tests are plain functions and don't need workerd.
  plugins: [
    react(),
    tailwindcss(),
    !!credentialChannel &&
      ({
        name: "gitmatrix-hosted-credentials",
        apply: "serve",
        configureServer(server) {
          // cf's remote-binding auth hook reads process.env for each renewal.
          const refresh = () => {
            try {
              refreshHostedCredentials();
            } catch {
              server.config.logger.error(
                "Hosted Cloudflare credential refresh failed; stopping the app.",
              );
              void server.close();
            }
          };
          watchFile(credentialChannel, { interval: 1_000, persistent: false }, refresh);
          server.httpServer?.once("close", () => unwatchFile(credentialChannel, refresh));
        },
      } satisfies Plugin),
    // Before the Cloudflare plugin, so its dispatch path never reaches the Worker.
    !process.env.VITEST && ciRunners(),
    !process.env.VITEST &&
      cloudflare({
        persistState: { path: local.stateDir },
        inspectorPort: local.hosted ? 9229 : false,
      }),
    // Say whether the dev server spends on AI: it's opt-in (CORE-284).
    !process.env.VITEST &&
      ({
        name: "gitmatrix-ai-notice",
        apply: "serve",
        configureServer(server) {
          server.config.logger.info(
            local.ai
              ? "  AI is on: Workers AI, AI Gateway, Vectorize and AI Search are bound, and Knowledge builds of pushed repositories spend money."
              : `  AI is off: no Workers AI, AI Gateway, Vectorize or AI Search; Knowledge, wiki, search, the assistant, release notes, avatars and Atlas descriptions show their AI-off states. Opt in with ${local.agent ? "vp run agent setup --ai" : DEV_AI_OPT_IN}.`,
          );
        },
      } satisfies Plugin),
  ],
  // The dev server's own port, strictly. Not under Vitest: the browser project
  // (`extends: true`) would inherit `strictPort` onto its browser server, which
  // starts at 63315 (`test.api`), so a second run elsewhere on this machine
  // failed to start instead of taking the next free port.
  server: process.env.VITEST
    ? {}
    : {
        host: local.hosted ? "0.0.0.0" : local.host,
        port: local.port,
        strictPort: true,
        ...(local.hosted
          ? {
              allowedHosts: [new URL(local.publicUrl).hostname],
              hmr: { protocol: "wss", host: new URL(local.publicUrl).hostname, clientPort: 443 },
              fs: {
                // deny replaces Vite's defaults: retain its env, key, package-auth and git
                // rules before excluding capabilities from static, /@fs and raw imports.
                deny: [
                  ".env",
                  ".env.*",
                  "*.{crt,pem,key,p12,pfx,cer,der}",
                  ".npmrc",
                  ".yarnrc.yml",
                  "**/.git/**",
                  "**/.gitmatrix-agent/**",
                  ...(credentialChannel
                    ? [normalizePath(resolve(credentialChannel)).replace(/[?*[\]{}()!+@]/g, "\\$&")]
                    : []),
                ],
              },
            }
          : {}),
      },
  // Source highlighting and audit diffs load late; discover their dependencies
  // before navigation rather than restarting the page when the optimizer finds them.
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
      "diff",
      "docx",
      "yaml",
    ],
  },
  // Two projects (see "Testing" in README.md): Node unit tests of pure logic,
  // and browser-mode tests that render the app in headless Chromium against
  // mocked and in-memory APIs.
  test: {
    maxWorkers: process.env.VITEST && availableMemory() < LOW_MEMORY ? 1 : 2,
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
        server: { strictPort: false },
        test: {
          name: "browser",
          // Concurrent source worktrees must not contend for Vitest's default API port.
          api: { host: "127.0.0.1", strictPort: false },
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
