import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";
import { ciRunners } from "./vite/ci-runners.ts";

export default defineConfig({
  // The Cloudflare plugin owns the dev server, which clashes with Vitest's own;
  // the unit tests are plain functions and don't need workerd.
  plugins: [
    react(),
    tailwindcss(),
    // Before the Cloudflare plugin, so its dispatch path never reaches the Worker.
    !process.env.VITEST && ciRunners(),
    !process.env.VITEST && cloudflare({ persistState: { path: ".wrangler/state" } }),
  ],
  server: { port: 5180, strictPort: true },
  test: {
    include: [
      "worker/**/*.test.ts",
      "registry/**/*.test.ts",
      "src/**/*.test.ts",
      "shared/**/*.test.ts",
    ],
  },
});
