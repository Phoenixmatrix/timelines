// Where the public site and the web app answer (CORE-115). The production
// hosts are the deploy's to supply (the deploy job's CI secrets,
// tools/agent/deploy.ts), never the repository's: without them, builds use
// placeholders, and a production deploy (GITMATRIX_DEPLOY=production) refuses.

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Environment = Record<string, string | undefined>;

export const SITE_HOST_VARIABLE = "GITMATRIX_SITE_HOST";
/** The web app's host: production's, as apps/website/vite/instance.ts reads it. */
export const APP_HOST_VARIABLE = "GITMATRIX_PRODUCTION_HOST";
export const SITE_HOST_PLACEHOLDER = "site.example.com";
/**
 * The web app's placeholder (apps/website/vite/instance.ts
 * PRODUCTION_PLACEHOLDERS.host). The docs link the web app with it, and the
 * build swaps in the real host.
 */
export const APP_HOST_PLACEHOLDER = "timelines.example.com";

const HOST = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;

/** The site's and the web app's hosts for a build or deploy in `env`. */
export function hosts(env: Environment): { site: string; app: string } {
  if (env.GITMATRIX_DEPLOY?.trim() === "production") {
    const missing = [SITE_HOST_VARIABLE, APP_HOST_VARIABLE].filter((name) => !env[name]?.trim());
    if (missing.length)
      throw new Error(
        `A production deploy of the site needs ${missing.join(", ")}. CI supplies them as ` +
          "the deploy job's secrets; deploying by hand, export them first.",
      );
  }
  const host = (name: string, placeholder: string) => {
    const given = env[name]?.trim();
    if (!given) return placeholder;
    if (!HOST.test(given)) throw new Error(`${name} must be a lowercase hostname, not ${given}`);
    return given;
  };
  return {
    site: host(SITE_HOST_VARIABLE, SITE_HOST_PLACEHOLDER),
    app: host(APP_HOST_VARIABLE, APP_HOST_PLACEHOLDER),
  };
}

/** The web app's address as the docs write it: the build swaps in the real one. */
export const APP_URL_PLACEHOLDER = `https://${APP_HOST_PLACEHOLDER}`;

/**
 * Point a built page's web-app links, text and code at the real app. The
 * Markdown docs name the placeholder address, so they read sensibly unbuilt,
 * and each build links the app of its own environment. Only the full address
 * is swapped: a bare example hostname (gm's own help uses one) stays.
 */
export function withAppUrl(html: string, app: string): string {
  return html.replaceAll(APP_URL_PLACEHOLDER, `https://${app}`);
}

/** An Astro integration applying {@link withAppUrl} to every built HTML page. */
export function appUrlIntegration(app: string) {
  return {
    name: "timelines-app-url",
    hooks: {
      "astro:build:done": async ({ dir }: { dir: URL }) => {
        if (app === APP_HOST_PLACEHOLDER) return;
        const root = fileURLToPath(dir);
        for (const entry of await readdir(root, { recursive: true })) {
          if (!entry.endsWith(".html")) continue;
          const path = join(root, entry);
          const html = await readFile(path, "utf8");
          const swapped = withAppUrl(html, app);
          if (swapped !== html) await writeFile(path, swapped);
        }
      },
    },
  };
}
