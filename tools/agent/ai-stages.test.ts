import assert from "node:assert/strict";
import { existsSync, globSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AI_STAGES,
  COOLDOWN_MS,
  SHARED_PATHS,
  STAGE_IDS,
  fingerprints,
  parseSetupOptions,
  parseTestAiOptions,
  refusal,
  reusableStages,
  selectStages,
  type RunRecord,
} from "./ai-stages.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const stagesFor = (changed: string[]) => selectStages({ changed }).stages;
const ATLAS = [
  "atlas-describe",
  "atlas-workspace",
  "atlas-reuse",
  "atlas-disabled",
  "atlas-refused",
  "atlas-exhausted",
];

await test("changed paths select their stages and the stages those require", () => {
  const examples: [string[], string[]][] = [
    [["apps/website/worker/avatars/api.ts"], ["avatars"]],
    [["apps/website/src/routes/AvatarEditor.tsx"], ["avatars"]],
    [["apps/website/worker/merge-queue/ai.ts"], ["queue"]],
    [
      ["apps/website/worker/assistant/tools.ts"],
      ["knowledge", "search", "assistant", "knowledge-edit", "release-notes"],
    ],
    [["apps/website/worker/tracker/store.ts"], ["knowledge", "knowledge-edit", "release-notes"]],
    [
      ["apps/website/worker/release-notes/generate.ts"],
      ["knowledge", "knowledge-edit", "release-notes"],
    ],
    [
      ["apps/website/src/routes/Highlights.tsx"],
      ["knowledge", "knowledge-edit", "release-notes", "release-highlights"],
    ],
    [
      ["apps/website/worker/timelines/checkpoints.ts"],
      ["knowledge", "knowledge-edit", "release-notes", "overlays", "timeline-pages"],
    ],
    [
      ["apps/website/worker/retention/repo-purge.ts"],
      ["knowledge", "search", "repository-deletion"],
    ],
    [["apps/website/src/palette/Palette.tsx"], ["knowledge", "search"]],
    [["apps/website/worker/atlas/describe.ts"], ATLAS],
    [["apps/website/src/routes/atlas/WorkspaceAtlas.tsx"], ["atlas-describe", "atlas-workspace"]],
    [
      ["apps/website/worker/knowledge/wiki.ts"],
      [
        "knowledge",
        "search",
        "knowledge-edit",
        "release-notes",
        "overlays",
        "timeline-pages",
        ...ATLAS,
      ],
    ],
    [["tools/agent/provider-e2e.ts"], STAGE_IDS.filter((id) => !id.startsWith("atlas"))],
    [["tools/agent/atlas-provider-e2e.ts"], ATLAS],
    // Shared infrastructure runs everything.
    [["apps/website/worker/ai-gateway.ts"], STAGE_IDS],
    [["apps/website/cloudflare.config.ts"], STAGE_IDS],
    [["pnpm-lock.yaml"], STAGE_IDS],
    // Nothing AI changed: nothing is provisioned or spent.
    [["apps/cli/src/main.rs", "README.md"], []],
    [[], []],
  ];
  for (const [changed, expected] of examples)
    assert.deepEqual(stagesFor(changed), expected, changed.join(", "));
});

await test("classification is bounded and independent, without narrowing shared AI coverage", () => {
  const selected = selectStages({ changed: [], requested: ["classification"] });
  assert.deepEqual(selected.stages, ["classification"]);
  assert.deepEqual(selected.reasons.classification, [{ kind: "requested" }]);
  assert.deepEqual(AI_STAGES.find((stage) => stage.id === "classification")!.requires, []);
  for (const path of [
    "apps/website/shared/ai.ts",
    "apps/website/worker/settings/ai.ts",
    "apps/website/worker/knowledge/models.ts",
  ])
    assert.deepEqual(stagesFor([path]), STAGE_IDS, path);
  assert.deepEqual(stagesFor(["apps/website/worker/api/dev.ts"]), [
    "classification",
    "knowledge",
    "search",
    "knowledge-edit",
    "release-notes",
    "release-highlights",
    "repository-deletion",
  ]);
});

await test("highlights depends only on the real detailed-note fixture and preserves classification independence", () => {
  assert.deepEqual(AI_STAGES.find((stage) => stage.id === "release-highlights")!.requires, [
    "release-notes",
  ]);
  assert.deepEqual(stagesFor(["apps/website/worker/release-notes/highlights.ts"]), [
    "knowledge",
    "knowledge-edit",
    "release-notes",
    "release-highlights",
  ]);
  assert.deepEqual(selectStages({ changed: [], requested: ["classification"] }).stages, [
    "classification",
  ]);
});

await test("--all runs every stage, and --stage adds to what changed, never replaces it", () => {
  assert.deepEqual(selectStages({ changed: [], all: true }).stages, STAGE_IDS);
  const added = selectStages({
    changed: ["apps/website/worker/avatars/api.ts"],
    requested: ["queue"],
  });
  assert.deepEqual(added.stages, ["avatars", "queue"]);
  assert.deepEqual(added.reasons.avatars, [
    { kind: "changed", paths: ["apps/website/worker/avatars/api.ts"] },
  ]);
  assert.deepEqual(added.reasons.queue, [{ kind: "requested" }]);
  assert.deepEqual(selectStages({ changed: [], requested: ["release-notes"] }).reasons, {
    knowledge: [{ kind: "required", by: ["knowledge-edit"] }],
    "knowledge-edit": [{ kind: "required", by: ["release-notes"] }],
    "release-notes": [{ kind: "requested" }],
  });
  assert.equal(selectStages({ changed: [] }).skipped.avatars, "no matching change");
  assert.throws(() => selectStages({ changed: [], requested: ["wiki"] }), /Unknown test-ai stage/);
});

await test("the gateway follow-up retains every consumer and fresh search prerequisites", () => {
  const requested = ["knowledge", "assistant", "avatars", "repository-deletion", "queue"];
  const expected = ["knowledge", "search", "assistant", "avatars", "repository-deletion", "queue"];
  assert.deepEqual(selectStages({ changed: [], requested }).stages, expected);
  assert.deepEqual(
    selectStages({
      changed: [],
      requested,
      reusable: new Set(["knowledge", "search"]),
    }).stages,
    expected,
  );
  // A narrow request never hides changes to the expensive consumers.
  const changed = ["tools/agent/provider-e2e.ts"];
  assert.deepEqual(
    selectStages({ changed, requested }).stages,
    STAGE_IDS.filter((id) => !id.startsWith("atlas")),
  );
});

await test("no stage's own files can be skipped, and every mapped path exists", () => {
  for (const stage of AI_STAGES)
    for (const glob of stage.paths) {
      assert(globSync(glob, { cwd: root }).length > 0, `${stage.id}: ${glob} matches nothing`);
      if (!/[*?{[]/.test(glob))
        assert(stagesFor([glob]).includes(stage.id), `${glob} must run ${stage.id}`);
    }
  for (const glob of SHARED_PATHS) {
    assert(
      /[*?{[]/.test(glob) ? globSync(glob, { cwd: root }).length > 0 : existsSync(join(root, glob)),
      `${glob} matches nothing`,
    );
    if (!/[*?{[]/.test(glob)) assert.deepEqual(stagesFor([glob]), STAGE_IDS, glob);
  }
  // Prerequisites always precede the stages that need them.
  for (const stage of AI_STAGES)
    for (const required of stage.requires)
      assert(STAGE_IDS.indexOf(required) < STAGE_IDS.indexOf(stage.id), stage.id);
});

function record(overrides: Partial<RunRecord>): RunRecord {
  return {
    startedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    finishedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    success: false,
    base: "base",
    stages: STAGE_IDS,
    fingerprints: Object.fromEntries(STAGE_IDS.map((id) => [id, `same-${id}`])),
    outcomes: {},
    failedStages: ["scenarios", "queue"],
    evidence: "/tmp/evidence",
    ...overrides,
  };
}

await test("--resume skips only stages that passed with the same base and inputs", async () => {
  const home = await mkdtemp(join(tmpdir(), "gitmatrix-stages-"));
  try {
    const path = "apps/website/worker/avatars/api.ts";
    await mkdir(join(home, dirname(path)), { recursive: true });
    await writeFile(join(home, path), "one");
    const first = await fingerprints(home, "base", [path]);
    assert.deepEqual(await fingerprints(home, "base", [path]), first);
    await writeFile(join(home, path), "two");
    const edited = await fingerprints(home, "base", [path]);
    // Only the stage the edited file maps to has new inputs.
    assert.deepEqual(
      STAGE_IDS.filter((id) => edited[id] !== first[id]),
      ["avatars"],
    );
    await rm(join(home, path));
    assert.notEqual((await fingerprints(home, "base", [path])).avatars, edited.avatars);
    assert.notEqual((await fingerprints(home, "moved", [])).queue, edited.queue);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  const previous = record({
    outcomes: { knowledge: "passed", search: "passed", avatars: "passed", queue: "failed" },
  });
  const now = { ...previous.fingerprints, avatars: "changed-avatars" };
  // Avatars' code changed since it passed; queue failed: both run again.
  assert.deepEqual([...reusableStages([previous], "base", now)].sort(), ["knowledge", "search"]);
  assert.deepEqual([...reusableStages([previous], "moved", now)], []);
  const resumed = selectStages({
    changed: ["apps/website/worker/ai-gateway.ts"],
    reusable: reusableStages([previous], "base", now),
  });
  // search and knowledge passed, but assistant needs them in its new environment.
  assert(resumed.stages.includes("search") && resumed.stages.includes("knowledge"));
  assert.deepEqual(resumed.reasons.search, [
    { kind: "required", by: ["assistant", "repository-deletion"] },
  ]);
  const independent = selectStages({
    changed: ["apps/website/worker/avatars/api.ts", "apps/website/worker/merge-queue/ai.ts"],
    reusable: new Set(["avatars"]),
  });
  assert.deepEqual(independent.stages, ["queue"]);
});

await test("--resume preserves successful evidence across skipped runs", () => {
  const first = record({
    stages: ["avatars", "queue"],
    outcomes: { avatars: "passed", queue: "failed" },
  });
  const second = record({
    stages: ["queue"],
    fingerprints: { ...first.fingerprints, queue: "first-fix" },
    outcomes: { queue: "failed" },
  });
  const third = record({
    stages: ["queue"],
    fingerprints: { ...first.fingerprints, queue: "second-fix" },
    outcomes: { queue: "failed" },
  });
  assert.deepEqual(
    [...reusableStages([first, second, third], "base", third.fingerprints)],
    ["avatars"],
  );
});

await test("--resume never reaches past a later attempt or changed inputs", () => {
  const first = record({ stages: ["avatars"], outcomes: { avatars: "passed" } });
  for (const later of [
    record({ stages: ["avatars"], outcomes: { avatars: "failed" } }),
    record({ stages: ["avatars"] }),
    record({
      stages: ["queue"],
      fingerprints: { ...first.fingerprints, avatars: "changed" },
    }),
    record({ stages: ["queue"], base: "another-base" }),
  ])
    assert.deepEqual([...reusableStages([first, later], "base", first.fingerprints)], []);
});

await test("a failure refuses a full run, and an unchanged rerun, within the cooldown", () => {
  const failed = record({});
  const full = selectStages({
    changed: [],
    all: true,
    base: "base",
    fingerprints: failed.fingerprints,
  });
  assert.match(refusal([failed], full)!, /full run is refused/);
  const unchanged = selectStages({
    changed: [],
    requested: ["queue"],
    base: "base",
    fingerprints: failed.fingerprints,
  });
  assert.match(refusal([failed], unchanged)!, /Nothing these stages verify changed/);
  const fixed = { ...unchanged, fingerprints: { ...failed.fingerprints, queue: "fixed" } };
  assert.equal(refusal([failed], fixed), null);
  const later = Date.parse(failed.finishedAt) + COOLDOWN_MS + 1;
  assert.equal(refusal([failed], full, later), null);
  assert.equal(refusal([failed, record({ success: true })], full), null);
  assert.equal(refusal([], full), null);
});

await test("options parse strictly", () => {
  assert.deepEqual(parseSetupOptions([]), { ai: false });
  assert.deepEqual(parseSetupOptions(["--ai"]), { ai: true });
  assert.throws(() => parseSetupOptions(["--with-ai"]), /setup \[--ai\]/);
  assert.deepEqual(
    parseTestAiOptions(["--stage", "avatars,queue", "--stage=search", "--resume", "--base=HEAD"]),
    {
      all: false,
      stages: ["avatars", "queue", "search"],
      resume: true,
      force: false,
      dryRun: false,
      base: "HEAD",
    },
  );
  assert.equal(parseTestAiOptions(["--all", "--force", "--dry-run"]).all, true);
  assert.throws(() => parseTestAiOptions(["--stage", "nope"]), /Unknown test-ai stage/);
  assert.throws(() => parseTestAiOptions(["--stage"]), /needs a value/);
  assert.throws(() => parseTestAiOptions(["--loop"]), /Use test-ai/);
});
