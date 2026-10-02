import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { ciRunners } from "./vite/ci-runners.ts";
import { developmentEnvironment } from "./vite/environment.ts";

const local = developmentEnvironment(process.env);

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
  server: { host: local.host, port: local.port, strictPort: true },
  test: {
    maxWorkers: 2,
    include: [
      "worker/**/*.test.ts",
      "registry/**/*.test.ts",
      "src/**/*.test.ts",
      "shared/**/*.test.ts",
    ],
  },
});
