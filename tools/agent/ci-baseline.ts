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
  try {
    // An array of candidates, newest first; an older server names one object.
    const parsed: unknown = JSON.parse(env.GITMATRIX_VERIFIED_BASE ?? "null");
    const candidates = (Array.isArray(parsed) ? parsed : [parsed]).filter(valid);
    if (!candidates.length || !/^[a-f0-9]{40}$/.test(env.GITMATRIX_COMMIT ?? ""))
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
    // The newest success may be on another branch, so take the first that is an ancestor;
    // a commit missing from a shallow clone is just not one.
    for (const baseline of candidates) {
      try {
        await git(["merge-base", "--is-ancestor", baseline.commit, "HEAD"]);
        return { baseline };
      } catch {}
    }
  } catch {}
  return {
    reason: "Verification baseline or its ancestor history is unavailable; run everything.",
  };
}

function valid(value: unknown): value is VerifiedBaseline {
  const b = value as VerifiedBaseline | null;
  return (
    !!b &&
    typeof b.commit === "string" &&
    /^[a-f0-9]{40}$/.test(b.commit) &&
    Number.isSafeInteger(b.runNumber) &&
    b.runNumber >= 1 &&
    typeof b.jobId === "string" &&
    !!b.jobId
  );
}
