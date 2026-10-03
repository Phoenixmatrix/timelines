# CORE-180 ground truth

Every answer here comes from the study repository's **source**: its files, imports
and the timelines' actual diffs at fixed commits. None of it comes from Gitmatrix
(either condition) or any other tool's output, so accuracy is judged against what
the code really does.

- Repository: [steveukx/git-js](https://github.com/steveukx/git-js) (simple-git), MIT
- Main commit: `98864c678444d9336357c844efa4fd5a7984c0d7` ("V4 (#1193)", 2026-09-23), 359 tracked files
- `timeline/change-a`: `dfeb11648190b2d82a98c91768ec6e3a65bb401c`, the upstream child of the main commit
- `timeline/change-b`: `2b27941aae6b9e55439a3ecbf76f7f6c039609c0`, upstream `76f308e` cherry-picked onto the main commit
- Both timelines' merge base with main is the main commit.

[ground-truth.json](ground-truth.json) holds the machine-derived facts (line ranges,
dependents, diffs). [derive-ground-truth.mjs](derive-ground-truth.mjs) derives them
from Git objects and checks the committed file:

```sh
node derive-ground-truth.mjs ~/.cache/gitmatrix-study/core-180/git-js --check ground-truth.json
```

`study-env.sh up` creates that clone (and the reproducible timeline B commit).

## Scoring rules

- **A file path** is correct when it names the right file. Paths may be shortened
  if they're unambiguous (`flags.helpers.ts`).
- **A source location** (T2) is correct when the file is right and the cited line is
  inside the accepted range (±3 lines), or the cited function or constant is the one
  named in the range.
- **Source-location accuracy** (the gate's accuracy measure) counts every location
  given in T2 (each of the two citations) and T3 (each listed file):
  `locations_correct / locations_cited`. A T3 file is correct when it is a true
  direct dependent, whether or not it is a test.
- **Direct dependent of F:** a file whose own `import`, `export … from`, `import()`
  or `require()` resolves to F. Type-only imports count. Re-exports through
  another file, and imports by package name (such as `@simple-git/argv-parser`),
  don't make a file a direct dependent: they import the package's entry file.

## Variant A: unsafe-operation protection

### A1. Find a capability

Derived by reading the source: `blockUnsafeOperationsPlugin` (installed for every
instance in `simple-git/src/lib/git-factory.ts:45`) passes each command's arguments
and environment to `vulnerabilityCheck` from the `@simple-git/argv-parser` package,
which parses argv, `-c` config writes and git environment variables and reports
vulnerabilities by category; the plugin throws unless the caller's `unsafe` option
enables that category.

**Purpose (must be stated):** it inspects the arguments (and config/environment)
of a git command before it runs, and refuses (throws an error) when they include
something that could run an arbitrary program, unless the caller opted in through
an `unsafe` setting.

**Accepted files.** Core:

| Directory                                   | Files                                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simple-git/src/lib/plugins/`               | `block-unsafe-operations-plugin.ts`, `allow-environment.plugin.ts`                                                                                  |
| `packages/argv-parser/src/vulnerabilities/` | `vulnerability-check.ts`, `vulnerability-analysis.ts`, `detect-vulnerable-flags.ts`, `detect-vulnerable-config-writes.ts`, `vulnerability.types.ts` |
| `packages/argv-parser/src/env/`             | `parse-env.ts`                                                                                                                                      |

Supporting (also correct): `packages/argv-parser/index.ts`, everything in
`packages/argv-parser/src/{args,config,flags,tokens}/`, `simple-git/src/lib/git-factory.ts`,
`simple-git/src/lib/types/index.ts`, `docs/PLUGIN-UNSAFE-ACTIONS.md`.

**Completed when:** the purpose is stated, and at least 3 named files are accepted,
including at least one core file under `simple-git/` and one core file under
`packages/argv-parser/`, with at most one named file outside the accepted set.

### A2. Cite two sources

1. List of unsafe command-line options: `preventUnsafeFlags` in
   `packages/argv-parser/src/vulnerabilities/detect-vulnerable-flags.ts`, **lines 37–48**.
   Also accepted, because `-c key=value` is a command-line option:
   `preventUnsafeConfig` in `detect-vulnerable-config-writes.ts`, lines 39–72.
2. Where the command is stopped with an error: the `action` of
   `blockUnsafeOperationsPlugin` in `simple-git/src/lib/plugins/block-unsafe-operations-plugin.ts`,
   **lines 12–19** (the `throw new GitPluginError(…)` is line 15). Registering the plugin
   (`git-factory.ts:45`) is not accepted: it doesn't decide anything.

**Completed when:** both citations are correct.

### A3. Direct dependents of `packages/argv-parser/src/flags/flags.helpers.ts`

Derived by resolving every relative import in the tree at the main commit. Seven
files, none of them tests (`type` marks a type-only import):

| File                                                                  | Import line |
| --------------------------------------------------------------------- | ----------- |
| `packages/argv-parser/src/args/parse-argv.ts`                         | 2 (type)    |
| `packages/argv-parser/src/config/analyse-config.ts`                   | 2           |
| `packages/argv-parser/src/config/detect-config-action.ts`             | 2           |
| `packages/argv-parser/src/flags/parse-global-flags.ts`                | 2 (type)    |
| `packages/argv-parser/src/flags/parse-task-flags.ts`                  | 5 (type)    |
| `packages/argv-parser/src/vulnerabilities/detect-vulnerable-flags.ts` | 1 (type)    |
| `packages/argv-parser/src/vulnerabilities/vulnerability-analysis.ts`  | 2 (type)    |

**Completed when:** at least 6 of the 7 are listed, with at most one incorrect file.

### A4. Explain `timeline/change-a`

Derived from `git diff 98864c6 dfeb116` (upstream "Fix/exec path vulnerability (#1197)").

| File                                                                  | Change  | +/-     | Kind   |
| --------------------------------------------------------------------- | ------- | ------- | ------ |
| `packages/argv-parser/src/vulnerabilities/detect-vulnerable-flags.ts` | changed | +42/−11 | source |
| `packages/argv-parser/src/vulnerabilities/vulnerability.types.ts`     | changed | +6/−0   | source |
| `packages/argv-parser/src/env/parse-env.ts`                           | changed | +1/−1   | source |
| `packages/argv-parser/test/vulnerability-analysis.spec.ts`            | changed | +40/−0  | test   |
| `packages/argv-parser/test/parse-env.spec.ts`                         | changed | +1/−1   | test   |
| `simple-git/test/integration/vulnerabilities/exec-path.spec.ts`       | added   | +36     | test   |
| `simple-git/test/integration/vulnerabilities/git-dir.spec.ts`         | added   | +110    | test   |
| `docs/PLUGIN-UNSAFE-ACTIONS.md`                                       | changed | +36/−5  | docs   |
| `.changeset/lucky-guards-block.md`                                    | added   | +16     | other  |
| `.nvmrc`                                                              | changed | +1/−1   | other  |

Behaviour, from the diff:

1. New blocked global options: `--exec-path` (new category `allowUnsafeExec`) and
   `--git-dir`, `--work-tree`, `-C` (category `allowUnsafeConfigPaths`) are refused
   when they are given **with a value, before the git sub-command**. Used as
   getters (`rev-parse --git-dir`) or as task options (`commit -C HEAD~1`) they're
   still allowed. (`preventFlagBuilder` gains `globalOnly`/`withValue` options and
   now receives the whole parsed flag, not just its name.)
2. A new opt-in category, `allowUnsafeExec`, is added to `VulnerabilityCategoryFlags`,
   and the `GIT_EXEC_PATH` environment variable moves to it from `allowUnsafeConfigPaths`.
3. `push --exec` is now matched exactly (`/^--exec$/`), so it no longer also matches
   longer options that start with `--exec`.

Direct dependents of the changed source files (who is affected):
`detect-vulnerable-flags.ts` ← `vulnerability-analysis.ts`; `parse-env.ts` ←
`vulnerability-check.ts`, `packages/argv-parser/index.ts`; `vulnerability.types.ts` ←
7 files (see ground-truth.json).

**Completed when:** the answer names `detect-vulnerable-flags.ts` and at least one
other changed source file; states behaviour 1 (at least one of the new blocked
options, and that it's about passing such a path/value) and behaviour 2 (a new
unsafe category/opt-in, or `GIT_EXEC_PATH` moving); and places it in the
unsafe-operation protection (the argv-parser vulnerability checks). Behaviour 3,
tests and docs are not required.

## Variant B: diff and stat summaries

### B1. Find a capability

Derived by reading the source: `git.diffSummary()` (`simple-git/src/git.mjs:500`)
runs `diffSummaryTask` (`tasks/diff.ts`), which uses `logFormatFromCommand`
(`args/log-format.ts`) to pick the summary format from the options and
`getDiffParser` (`parsers/parse-diff-summary.ts`) to parse git's output into a
`DiffSummary` (`responses/DiffSummary.ts`). `parse-list-log-summary.ts` calls the
same `getDiffParser` to attach a `diff` to each `git.log()` entry.

**Purpose (must be stated):** it runs `git diff` (or `git log`) with a summary format
and parses the output into a structured result: the files changed, with
insertions/deletions (or binary sizes) and totals.

**Accepted files.** Core (all under `simple-git/src/lib/`): `tasks/diff.ts`,
`parsers/parse-diff-summary.ts`, `responses/DiffSummary.ts`, `args/log-format.ts`.
Supporting (also correct): `parsers/parse-list-log-summary.ts`, `tasks/log.ts`,
`tasks/diff-name-status.ts`, `utils/line-parser.ts`, `simple-git/src/typings/response.ts`,
`simple-git/src/typings/simple-git.ts`, `simple-git/src/git.mjs`.

**Completed when:** the purpose is stated, and at least 3 named files are accepted,
including at least 2 core files, spanning at least two directories, with at most one
named file outside the accepted set.

### B2. Cite two sources

1. One `--stat` line becomes a per-file entry: the first `LineParser` of `statParser`
   in `simple-git/src/lib/parsers/parse-diff-summary.ts`, **lines 7–19** (the regex is
   line 9, insertions/deletions are counted on lines 14–15).
2. Working out the requested format from the options: `logFormatFromCommand` in
   `simple-git/src/lib/args/log-format.ts`, **lines 11–20**. Also accepted: the
   format-to-parser table `diffSummaryParsers` in `parse-diff-summary.ts` (lines
   108–114) and `diffSummaryTask` in `simple-git/src/lib/tasks/diff.ts` (lines 7–26),
   which calls both.

**Completed when:** both citations are correct.

### B3. Direct dependents of `simple-git/src/lib/args/log-format.ts`

Derived by resolving every relative import in the tree at the main commit. Seven
files, two of them tests:

| File                                                   | Import line |
| ------------------------------------------------------ | ----------- |
| `simple-git/src/lib/parsers/parse-diff-summary.ts`     | 2           |
| `simple-git/src/lib/parsers/parse-list-log-summary.ts` | 2           |
| `simple-git/src/lib/tasks/diff.ts`                     | 2           |
| `simple-git/src/lib/tasks/log.ts`                      | 4           |
| `simple-git/src/lib/tasks/stash-list.ts`               | 2           |
| `simple-git/test/unit/args.log-format.spec.ts`         | 3 (test)    |
| `simple-git/test/unit/diff.spec.ts`                    | 5 (test)    |

**Completed when:** at least 6 of the 7 are listed, with at most one incorrect file.

### B4. Explain `timeline/change-b`

Derived from `git diff 98864c6 2b27941` (upstream "Pr/1180 (#1195)", co-authored by
JUNYAN, cherry-picked unchanged).

| File                                               | Change  | +/-    | Kind   |
| -------------------------------------------------- | ------- | ------ | ------ |
| `simple-git/src/lib/parsers/parse-diff-summary.ts` | changed | +8/−0  | source |
| `simple-git/test/unit/diff.spec.ts`                | changed | +21/−0 | test   |
| `simple-git/test/integration/diff.spec.ts`         | changed | +54/−0 | test   |
| `.changeset/tiny-diffs-smile.md`                   | added   | +5     | other  |

Behaviour, from the diff: `statParser` gains a third `LineParser` for `--stat` lines
that report a binary file with no byte counts, such as a renamed binary
(`uploads/{image.png => image-test.png} | Bin`). Such a line now becomes a binary file
entry (`binary: true`, `before: 0`, `after: 0`). Before, it matched neither the text
pattern (it has no change count) nor the binary pattern (it has no
`Bin X -> Y bytes`), so the file was left out of `files`.

Direct dependents of the changed source file (who is affected):
`parse-list-log-summary.ts` (so `git.log()` diffs too), `tasks/diff.ts` (so
`git.diffSummary()`), and the test `simple-git/test/unit/diff.spec.ts`.

**Completed when:** the answer names `parse-diff-summary.ts`; states that diff/stat
summaries now include binary files reported as `Bin` without sizes (renamed binaries
are the example) as binary entries, where before they were missing; and places it in
the diff-summary parsing. Tests are not required.

## Variant balance

The variants are parallel (the same four task types, the same number of direct
dependents, two citations each) but not identical: variant A's capability spans two
packages and its timeline changes three source files, while variant B's timeline
changes one. The ordering ([ordering.csv](ordering.csv)) therefore gives the larger
variant A to the new experience in three of five sessions, so any variant difference
works against the new experience, and the analysis reports medians per variant too.
