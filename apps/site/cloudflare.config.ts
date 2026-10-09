import { defineConfig } from "cf/config";

// The public site (CORE-115): Astro's static build, served as assets by a
// Worker of its own on timelines.fward.dev. No entrypoint: nothing runs but
// the asset server.
export const PRODUCTION_HOST = "timelines.fward.dev";

export default defineConfig(({ mode }) => ({
  worker: {
    name: "gitmatrix-site",
    compatibilityDate: "2026-09-30",
    assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page" },
    ...(mode === "development" ? {} : { domains: [PRODUCTION_HOST], workersDev: false }),
  },
}));
