import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { readinessPlan } from "./ready-plan.ts";

const exec = promisify(execFile);

export async function ciBuildPlan(root: string, env: NodeJS.ProcessEnv = process.env) {
  const full = (reason: string) => ({
    build: true,
    baseline: null,
    changed: [],
    reasons: [reason],
  });
  let baseline: { commit: string; runNumber: number; jobId: string };
  try {
    baseline = JSON.parse(env.GITMATRIX_VERIFIED_BASE ?? "null");
    if (
      !baseline ||
      !/^[a-f0-9]{40}$/.test(baseline.commit) ||
      !Number.isSafeInteger(baseline.runNumber) ||
      baseline.runNumber < 1 ||
      typeof baseline.jobId !== "string" ||
      !baseline.jobId ||
      !/^[a-f0-9]{40}$/.test(env.GITMATRIX_COMMIT ?? "")
    )
      return full("No executed, runtime-equivalent verification baseline; build everything.");
    const git = async (args: string[]) =>
      (
        await exec("git", args, {
          cwd: root,
          encoding: "utf8",
          timeout: 60_000,
        })
      ).stdout.trim();
    if ((await git(["rev-parse", "HEAD"])) !== env.GITMATRIX_COMMIT)
      return full("Checkout does not match the CI commit; build everything.");
    // Never compare only HEAD~1: a multi-commit push may contain unverified code.
    await git(["merge-base", "--is-ancestor", baseline.commit, "HEAD"]);
  } catch {
    return full("Verification baseline or its ancestor history is unavailable; build everything.");
  }
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
