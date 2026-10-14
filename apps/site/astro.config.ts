import { defineConfig } from "astro/config";
import { appUrlIntegration, hosts } from "./src/hosts.ts";

// Production's hosts come from the deploy's environment, placeholders otherwise (src/hosts.ts).
const { site, app } = hosts(process.env);

// The public site (CORE-115): static pages, served as assets by their own
// Worker (cloudflare.config.ts; scripts/build-output.ts writes its build output).
export default defineConfig({
  site: `https://${site}`,
  output: "static",
  trailingSlash: "ignore",
  // Code takes its colours from the design tokens (site.css), in both themes.
  markdown: { shikiConfig: { theme: "css-variables" } },
  // The docs link the web app at a placeholder address; this points them at the real one.
  integrations: [appUrlIntegration(app)],
  // src/site.ts APP_URL.
  vite: { define: { __TIMELINES_APP_URL__: JSON.stringify(`https://${app}`) } },
});
