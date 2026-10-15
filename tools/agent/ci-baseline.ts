import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface VerifiedBaseline {
  commit: string;
  runNumber: number;
  jobId: string;
}

/**
 * The last verified successful run of this CI job, when it is usable for this checkout: the
 * environment names it, the checkout is the CI commit, and the baseline is its ancestor. Otherwise
 * the reason a caller must build or test everything.
 */
export async function verifiedBaseline(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ baseline: VerifiedBaseline } | { reason: string }> {
  let baseline: VerifiedBaseline;
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
      return { reason: "No executed, runtime-equivalent verification baseline; run everything." };
    const git = async (args: string[]) =>
      (
        await exec("git", args, {
          cwd: root,
          encoding: "utf8",
          timeout: 60_000,
        })
      ).stdout.trim();
    if ((await git(["rev-parse", "HEAD"])) !== env.GITMATRIX_COMMIT)
      return { reason: "Checkout does not match the CI commit; run everything." };
    // Never compare only HEAD~1: a multi-commit push may contain unverified code.
    await git(["merge-base", "--is-ancestor", baseline.commit, "HEAD"]);
  } catch {
    return {
      reason: "Verification baseline or its ancestor history is unavailable; run everything.",
    };
  }
  return { baseline };
}
