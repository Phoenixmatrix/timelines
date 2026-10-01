import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // The Cloudflare plugin owns the dev server, which clashes with Vitest's own;
  // the unit tests are plain functions and don't need workerd.
  plugins: [react(), tailwindcss(), !process.env.VITEST && cloudflare()],
  server: { port: 5180, strictPort: true },
  test: {
    include: ["worker/**/*.test.ts", "src/**/*.test.ts", "shared/**/*.test.ts"],
  },
});
