import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { STEP_ARTIFACT_LIMITS } from "../../apps/website/shared/steps.ts";
import { collectCandidates, planUploads } from "../visuals/upload.ts";

test("planUploads takes pngs and mermaid files, sorted, and warns about the rest", () => {
  const { uploads, warnings } = planUploads([
    { file: "b shot.png", size: 10 },
    { file: "notes.txt", size: 1 },
    { file: "a diagram.mmd", size: 10 },
    { file: "huge.png", size: STEP_ARTIFACT_LIMITS.imageBytes + 1 },
    { file: ".hidden.png", size: 10 },
  ]);
  assert.deepEqual(uploads, [
    { file: "a diagram.mmd", name: "a diagram", kind: "documents" },
    { file: "b shot.png", name: "b shot", kind: "screenshots" },
  ]);
  assert.equal(warnings.length, 2);
});

test("planUploads stops at the per-run limit", () => {
  const files = Array.from({ length: STEP_ARTIFACT_LIMITS.perRun + 2 }, (_, n) => ({
    file: `shot ${String(n).padStart(3, "0")}.png`,
    size: 1,
  }));
  const { uploads, warnings } = planUploads(files);
  assert.equal(uploads.length, STEP_ARTIFACT_LIMITS.perRun);
  assert.equal(warnings.length, 2);
});

test("collectCandidates warns about a dangling link and a directory instead of failing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "visuals-"));
  try {
    await writeFile(join(dir, "ok.png"), "x");
    await symlink(join(dir, "missing"), join(dir, "dangling.png"));
    await mkdir(join(dir, "x.png"));
    const { candidates, warnings } = await collectCandidates(dir, [
      "ok.png",
      "dangling.png",
      "x.png",
    ]);
    assert.deepEqual(candidates, [{ file: "ok.png", size: 1 }]);
    assert.equal(warnings.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
