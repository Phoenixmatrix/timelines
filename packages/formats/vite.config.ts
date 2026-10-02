import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    maxWorkers: 2,
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
