// Derives the study's ground truth from the study repository's SOURCE (its
// Git objects), never from Gitmatrix's or any other tool's output.
//
//   node derive-ground-truth.mjs <upstream-clone> [--check ground-truth.json]
//
// <upstream-clone> is the clone study-env.sh keeps (default
// ~/.cache/gitmatrix-study/core-180/git-js), which holds the main commit and
// both timeline commits. Without --check it prints the derived JSON; with
// --check it exits non-zero if the committed file differs from the source.
//
// Rules (README.md, "Ground truth"):
// - Direct dependent of F: a tracked JS/TS file at the main commit with an
//   import/export-from/import()/require() whose relative specifier resolves to
//   F (extensionless, .js->.ts and /index resolution, as TypeScript does).
//   Type-only imports count. Package specifiers (`@simple-git/...`) resolve to
//   a package entry point, not to F, so they never make a direct dependent.
// - Source locations: exact line ranges at the main commit, found by anchors.
// - Timeline changes: `git diff --numstat <main> <timeline>`; the merge base
//   is the main commit for both timelines.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const MAIN = "98864c678444d9336357c844efa4fd5a7984c0d7";
const TIMELINES = {
  A: { ref: "timeline/change-a", commit: "dfeb11648190b2d82a98c91768ec6e3a65bb401c" },
  B: { ref: "timeline/change-b", commit: "2b27941aae6b9e55439a3ecbf76f7f6c039609c0" },
};
const DEPENDENT_TARGETS = {
  A: "packages/argv-parser/src/flags/flags.helpers.ts",
  B: "simple-git/src/lib/args/log-format.ts",
};
// Source-location anchors: [file, first-line regex, last-line regex (searched from the first)].
const LOCATIONS = {
  A: {
    "A2.1": [
      [
        "packages/argv-parser/src/vulnerabilities/detect-vulnerable-flags.ts",
        /^const preventUnsafeFlags = \[/,
        /^\];/,
      ],
    ],
    "A2.1-alt": [
      [
        "packages/argv-parser/src/vulnerabilities/detect-vulnerable-config-writes.ts",
        /^const preventUnsafeConfig = \[/,
        /^\];/,
      ],
    ],
    "A2.2": [
      [
        "simple-git/src/lib/plugins/block-unsafe-operations-plugin.ts",
        /^\s+action\(args, \{ env \}\) \{/,
        /^\s+return args;/,
      ],
    ],
  },
  B: {
    "B2.1": [
      ["simple-git/src/lib/parsers/parse-diff-summary.ts", /^const statParser = \[/, /^\s+\),/],
    ],
    "B2.2": [
      ["simple-git/src/lib/args/log-format.ts", /^export function logFormatFromCommand/, /^\}/],
    ],
    "B2.2-alt": [
      ["simple-git/src/lib/parsers/parse-diff-summary.ts", /^const diffSummaryParsers/, /^\}/],
      ["simple-git/src/lib/tasks/diff.ts", /^export function diffSummaryTask/, /^\}/],
    ],
  },
};
const CAPABILITY_FILES = {
  A: {
    core: [
      "simple-git/src/lib/plugins/block-unsafe-operations-plugin.ts",
      "simple-git/src/lib/plugins/allow-environment.plugin.ts",
      "packages/argv-parser/src/vulnerabilities/vulnerability-check.ts",
      "packages/argv-parser/src/vulnerabilities/vulnerability-analysis.ts",
      "packages/argv-parser/src/vulnerabilities/detect-vulnerable-flags.ts",
      "packages/argv-parser/src/vulnerabilities/detect-vulnerable-config-writes.ts",
      "packages/argv-parser/src/vulnerabilities/vulnerability.types.ts",
      "packages/argv-parser/src/env/parse-env.ts",
    ],
    supporting: [
      "packages/argv-parser/index.ts",
      "packages/argv-parser/src/args/parse-argv.ts",
      "packages/argv-parser/src/args/parse-argv.types.ts",
      "packages/argv-parser/src/config/analyse-config.ts",
      "packages/argv-parser/src/config/config-operands.ts",
      "packages/argv-parser/src/config/config.types.ts",
      "packages/argv-parser/src/config/detect-config-action.ts",
      "packages/argv-parser/src/flags/flags.helpers.ts",
      "packages/argv-parser/src/flags/parse-global-flags.ts",
      "packages/argv-parser/src/flags/parse-task-flags.ts",
      "packages/argv-parser/src/tokens/flag-specs.ts",
      "packages/argv-parser/src/tokens/token-expander.ts",
      "simple-git/src/lib/git-factory.ts",
      "simple-git/src/lib/types/index.ts",
      "docs/PLUGIN-UNSAFE-ACTIONS.md",
    ],
  },
  B: {
    core: [
      "simple-git/src/lib/tasks/diff.ts",
      "simple-git/src/lib/parsers/parse-diff-summary.ts",
      "simple-git/src/lib/responses/DiffSummary.ts",
      "simple-git/src/lib/args/log-format.ts",
    ],
    supporting: [
      "simple-git/src/lib/parsers/parse-list-log-summary.ts",
      "simple-git/src/lib/tasks/log.ts",
      "simple-git/src/lib/tasks/diff-name-status.ts",
      "simple-git/src/lib/utils/line-parser.ts",
      "simple-git/src/typings/response.ts",
      "simple-git/src/typings/simple-git.ts",
      "simple-git/src/git.mjs",
    ],
  },
};

const args = process.argv.slice(2);
const repo = args[0];
if (!repo)
  throw new Error("usage: derive-ground-truth.mjs <upstream-clone> [--check ground-truth.json]");
const git = (...a) =>
  execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 64 << 20 });
const show = (commit, path) => git("show", `${commit}:${path}`);

const files = git("ls-tree", "-r", "--name-only", MAIN).split("\n").filter(Boolean);
const tracked = new Set(files);
const isTest = (path) =>
  /(^|\/)(test|tests|__tests__|__fixtures__|__mocks__)\//.test(path) ||
  /\.(spec|test)\.[cm]?[jt]sx?$/.test(path);

const SPEC =
  /(?:^|[\s;])(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
function resolveSpecifier(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = normalize(join(dirname(from), spec));
  const stem = base.replace(/\.(js|mjs|cjs)$/, "");
  const candidates = [
    base,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, "index.ts"),
    join(base, "index.js"),
  ];
  return candidates.find((c) => tracked.has(c)) ?? null;
}
const imports = [];
for (const from of files.filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f))) {
  const text = show(MAIN, from);
  for (const m of text.matchAll(SPEC)) {
    const spec = m[2] ?? m[3] ?? m[4];
    const to = resolveSpecifier(from, spec);
    if (to)
      imports.push({
        from,
        to,
        line: text.slice(0, m.index + m[0].indexOf(spec)).split("\n").length,
        typeOnly: !!m[1],
      });
  }
}
const dependentsOf = (target) => {
  const byFile = new Map();
  for (const i of imports.filter((x) => x.to === target)) {
    const prev = byFile.get(i.from);
    byFile.set(i.from, {
      path: i.from,
      line: prev?.line ?? i.line,
      typeOnly: (prev?.typeOnly ?? true) && i.typeOnly,
      test: isTest(i.from),
    });
  }
  return [...byFile.values()].sort((a, b) => a.path.localeCompare(b.path));
};

function locate([path, first, last]) {
  const lines = show(MAIN, path).split("\n");
  const start = lines.findIndex((l) => first.test(l));
  if (start < 0) throw new Error(`${path}: anchor ${first} not found`);
  const end = lines.findIndex((l, i) => i > start && last.test(l));
  if (end < 0) throw new Error(`${path}: end ${last} not found`);
  return { path, lines: [start + 1, end + 1], text: lines[start].trim() };
}

function timeline({ ref, commit }) {
  const mergeBase = git("merge-base", MAIN, commit).trim();
  const changed = git("diff", "--numstat", MAIN, commit)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, path] = line.split("\t");
      const status = tracked.has(path) ? "modified" : "added";
      const kind = isTest(path) ? "test" : /\.(ts|tsx|mts|js|mjs)$/.test(path) ? "source" : "other";
      return { path, status, added: Number(added), removed: Number(removed), kind };
    });
  const source = changed.filter((c) => c.kind === "source");
  return {
    ref,
    commit,
    mergeBase,
    subject: git("log", "-1", "--format=%s", commit).trim(),
    files: changed,
    sourceFiles: source.map((c) => c.path),
    directDependentsOfChangedSource: Object.fromEntries(
      source.map((c) => [c.path, dependentsOf(c.path).map((d) => d.path)]),
    ),
  };
}

const truth = {
  repository: { url: "https://github.com/steveukx/git-js", commit: MAIN, files: files.length },
};
for (const v of ["A", "B"]) {
  const missing = [...CAPABILITY_FILES[v].core, ...CAPABILITY_FILES[v].supporting].filter(
    (f) => !tracked.has(f),
  );
  if (missing.length) throw new Error(`capability ${v}: not in the tree: ${missing.join(", ")}`);
  truth[v] = {
    capability: CAPABILITY_FILES[v],
    locations: Object.fromEntries(
      Object.entries(LOCATIONS[v]).map(([k, anchors]) => [k, anchors.map(locate)]),
    ),
    dependents: { target: DEPENDENT_TARGETS[v], files: dependentsOf(DEPENDENT_TARGETS[v]) },
    timeline: timeline(TIMELINES[v]),
  };
}

const json = `${JSON.stringify(truth, null, 2)}\n`;
const check = args.indexOf("--check");
if (check >= 0) {
  const path =
    args[check + 1] ?? join(dirname(fileURLToPath(import.meta.url)), "ground-truth.json");
  // Compare values, not bytes: the formatter may lay the committed file out differently.
  if (JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) !== JSON.stringify(truth)) {
    process.stdout.write(json);
    console.error(`\n${path} differs from what the source derives (above).`);
    process.exit(1);
  }
  console.error(`${path} matches the source at ${MAIN}.`);
} else process.stdout.write(json);
