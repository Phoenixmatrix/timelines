// Attach the pictures a CI job collected to its commit's step (CORE-383).
// The test job's browser tests save screenshots to $GITMATRIX_VISUALS_DIR
// (apps/website/src/testing/visual.ts); this uploads each *.png as a
// screenshot and each *.mmd as a Mermaid diagram, so the Story's step view
// shows them. Visuals never fail CI: a skipped or failed upload is a warning
// and the script exits 0.

import { readdir, readFile, stat } from "node:fs/promises";
import { join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { STEP_ARTIFACT_LIMITS } from "../../apps/website/shared/steps.ts";

export interface Candidate {
  file: string;
  size: number;
}

export interface Upload {
  file: string;
  name: string;
  kind: "screenshots" | "documents";
}

/**
 * What to upload: sorted, the right kinds only, within the per-run limit and
 * each file's size bound. `warnings` says what was left out and why.
 */
export function planUploads(candidates: Candidate[]): { uploads: Upload[]; warnings: string[] } {
  const uploads: Upload[] = [];
  const warnings: string[] = [];
  for (const { file, size } of [...candidates].sort((a, b) => a.file.localeCompare(b.file))) {
    const { name, ext } = parse(file);
    const kind = ext === ".png" ? "screenshots" : ext === ".mmd" ? "documents" : null;
    if (!kind) continue;
    const limit =
      kind === "screenshots" ? STEP_ARTIFACT_LIMITS.imageBytes : STEP_ARTIFACT_LIMITS.documentChars;
    if (!STEP_ARTIFACT_LIMITS.name.test(name)) warnings.push(`${file}: not a valid name, skipped`);
    else if (size > limit)
      warnings.push(`${file}: ${size} bytes is over the ${limit} limit, skipped`);
    else if (uploads.length >= STEP_ARTIFACT_LIMITS.perRun)
      warnings.push(`${file}: over ${STEP_ARTIFACT_LIMITS.perRun} per run, skipped`);
    else uploads.push({ file, name, kind });
  }
  return { uploads, warnings };
}

/** The regular files in `dir` with their sizes; one that can't be statted (a dangling link, a directory) is a warning, not a failure. */
export async function collectCandidates(
  dir: string,
  files: string[],
): Promise<{ candidates: Candidate[]; warnings: string[] }> {
  const candidates: Candidate[] = [];
  const warnings: string[] = [];
  for (const file of files) {
    try {
      const info = await stat(join(dir, file));
      if (info.isFile()) candidates.push({ file, size: info.size });
      else warnings.push(`${file}: not a regular file, skipped`);
    } catch (error) {
      warnings.push(`${file}: ${error instanceof Error ? error.message : String(error)}, skipped`);
    }
  }
  return { candidates, warnings };
}

async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const { GITMATRIX_VISUALS_DIR: dir, GITMATRIX_URL: url, GITMATRIX_TOKEN: token } = env;
  const repository = env.GITMATRIX_REPOSITORY;
  if (!dir || !url || !token || !repository) {
    console.log(
      "No visuals uploaded: GITMATRIX_VISUALS_DIR, _URL, _TOKEN or _REPOSITORY is unset.",
    );
    return;
  }
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    console.log(`No visuals uploaded: ${dir} does not exist.`);
    return;
  }
  const collected = await collectCandidates(dir, files);
  const { uploads, warnings } = planUploads(collected.candidates);
  for (const warning of [...collected.warnings, ...warnings]) console.warn(`warning: ${warning}`);
  const base = `${url}/api/repos/${repository}/steps/artifacts`;
  let sent = 0;
  for (const { file, name, kind } of uploads) {
    const document = kind === "documents";
    try {
      const bytes = await readFile(join(dir, file));
      const response = await fetch(`${base}/${kind}/${encodeURIComponent(name)}`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": document ? "application/json" : "image/png",
        },
        body: document
          ? JSON.stringify({ format: "mermaid", source: bytes.toString("utf8") })
          : bytes,
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) sent++;
      else
        console.warn(
          `warning: ${file}: upload failed with ${response.status}: ${(await response.text()).slice(0, 300)}`,
        );
    } catch (error) {
      console.warn(
        `warning: ${file}: upload failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log(`Uploaded ${sent} of ${uploads.length} visuals for the step view.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main(process.env);
