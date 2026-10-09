import { defineConfig } from "astro/config";

// The public site (CORE-115): static pages, served as assets by their own
// Worker (cloudflare.config.ts; scripts/build-output.ts writes its build output).
export default defineConfig({
  site: "https://timelines.fward.dev",
  output: "static",
  trailingSlash: "ignore",
  // Code takes its colours from the design tokens (site.css), in both themes.
  markdown: { shikiConfig: { theme: "css-variables" } },
});
