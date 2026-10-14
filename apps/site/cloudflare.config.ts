import { defineConfig } from "cf/config";
import { hosts } from "./src/hosts.ts";

// The public site (CORE-115): Astro's static build, served as assets by a
// Worker of its own on its production host (GITMATRIX_SITE_HOST, a deploy
// secret; src/hosts.ts). No entrypoint: nothing runs but the asset server.

export default defineConfig(({ mode }) => {
  // cf evaluates this in Node.
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process
    ?.env;
  return {
    worker: {
      name: "gitmatrix-site",
      compatibilityDate: "2026-09-30",
      assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page" },
      ...(mode === "development" ? {} : { domains: [hosts(env ?? {}).site], workersDev: false }),
    },
  };
});
