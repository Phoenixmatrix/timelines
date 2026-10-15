import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { verifiedBaseline } from "./ci-baseline.ts";
import { readinessPlan } from "./ready-plan.ts";

export async function ciBuildPlan(root: string, env: NodeJS.ProcessEnv = process.env) {
  const verified = await verifiedBaseline(root, env);
  if ("reason" in verified)
    return { build: true, baseline: null, changed: [], reasons: [verified.reason] };
  const { baseline } = verified;
  const selected = await readinessPlan(root, { all: false, dryRun: true, base: baseline.commit });
  return {
    build: selected.gates.some((gate) => gate.name === "build" || gate.name.endsWith("-build")),
    baseline,
    changed: selected.changed,
    reasons: selected.reasons,
  };
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "../..");
  const plan = await ciBuildPlan(root);
  console.log(JSON.stringify({ event: "ci.build.plan", ...plan }));
  if (!process.argv.includes("--plan") && plan.build) {
    execFileSync(
      "vp",
      ["run", "--filter", "!cli", "--concurrency-limit", "1", "--no-cache", "build"],
      {
        cwd: root,
        stdio: "inherit",
      },
    );
  }
}
