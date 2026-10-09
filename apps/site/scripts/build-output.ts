// Turns Astro's static build into Cloudflare's Build Output Specification
// (.cloudflare/output), an assets-only Worker described by cloudflare.config.ts,
// for `cf deploy --prebuilt`. `cf build` would delegate to `astro build` and
// then expect this tree, which only Astro's server adapter writes (CORE-115).

import { resolve } from "node:path";
import {
  cleanBuildOutputDir,
  writeAssets,
  writeRootConfig,
  writeWorkerConfig,
} from "@cloudflare/build-output-utils";
import { loadAndParseConfig } from "@cloudflare/config";

const root = resolve(import.meta.dirname, "..");
const context = { isPreview: false, mode: process.env.CF_MODE ?? "production" };
const { result } = await loadAndParseConfig(resolve(root, "cloudflare.config.ts"), context);
if (!result.success) throw new Error(`cloudflare.config.ts: ${result.error.message}`);
const { worker, containers: _containers, ...settings } = result.data;
if (!worker) throw new Error("cloudflare.config.ts defines no worker.");

await cleanBuildOutputDir(root);
await writeAssets({ root, sourceDirectory: resolve(root, "dist") });
await writeWorkerConfig({ root, config: worker });
await writeRootConfig(root, settings, context);
console.log(`Build output written for ${worker.name}.`);
