# gm

The Gitmatrix CLI, written in Rust. It is built for agents first: JSON output,
discoverable commands, structured errors. It uses a change-based workflow like
[jj](https://jj-vcs.github.io/jj/): commit early, commit often, no staging area,
no pull requests.

```bash
pnpm run install-bin            # cargo install: puts `gm` in ~/.cargo/bin
gm auth login --persona jun     # dev sign-in; or --token gmx_…
gm clone orbit/engine && cd engine
# edit files…
gm commit -m "Add retry to fetch"
gm push --sync                  # rebase onto the latest trunk, then land on main
```

`gm cli guide` prints the whole workflow in one page; it is written to be pasted
into an AGENTS.md.

## Semantic changes

`gm semantic list` reads the repository's individual syntax-change feed without
replacing `gm diff`, `gm show`, or ordinary Git history. It uses the current
repository, or `--repo owner/name` from anywhere:

```bash
gm semantic list --ref main --limit 30
gm semantic list -R orbit/engine --ref main --path src/client.ts \
  --kind call.added --language typescript -o json
gm semantic list -R orbit/engine --ref main --cursor OPAQUE_CURSOR -o json
gm schema semantic list
```

`--ref` is a server branch, tag or commit OID (default `HEAD`), not an unpushed
local change ID. `--path`, `--kind` and `--language` are exact filters. JSON
preserves the API's versioned `entries`, pinned `head`, `nextCursor` and separate
analysis `coverage`; each entry includes its kind, syntax evidence, commit,
before/after excerpts and source-location links. Text output also reports
coverage and the continuation cursor.

Pages contain changes, not commits. Repeat the same ref and filters with the
returned cursor until `nextCursor` is null—even when a page has no entries.
Starting without a cursor observes the latest head. History follows first
parents; unsupported, binary, oversized and unparsable source is reported rather
than fabricated into semantic events.

TypeScript/TSX, Rust, Python, Go, Markdown, XML, JSON, HTML and CSS are supported.
These are parser-backed syntax facts, not inferred intent or resolved types.
See the [API, adapter contract and limits](../website/README.md#semantic-changes)
and the repository-root `vp run semantic-smoke` for the real server/CLI fixture
verification. The web Changes tab is functional work in progress, not final UI.

## Distributed issue tracker

Tracker commands work anywhere, without `gm init` or a Git repository. Accounts and
organizations own trackers; each issue belongs to one team and any number of
cross-team workspaces. Repository subscriptions are associations, not permissions.

```bash
gm tracker list
gm tracker use orbit
gm team create ENG --name Engineering
gm workspace create launch --name Launch
gm issue create 'Search redesign' --team ENG --type prd \
  --description-file design.md --acceptance-file acceptance.md --workspace launch
gm issue ready --limit 10
gm issue show ENG-1 --limit 20
gm issue update ENG-1 --data '{"priority":1,"labels":["search"]}'
gm issue link ENG-1 ENG-2 --kind blocks  # FROM blocks TO
gm issue checkpoint ENG-1 '@checkpoint.md'
gm issue evidence ENG-1 'Verified search with the integration smoke'
gm workspace subscribe launch --repo REPOSITORY_ID
gm tracker changes --after 0 --limit 100
```

Use `--owner orbit` to override the saved tracker. `gm schema issue update` and
`gm schema issue batch` describe inputs; JSON patch relationship fields use canonical
IDs, not display keys. `null` clears nullable fields. Description/acceptance file flags
accept `-` for stdin (one field at a time); patch and batch JSON accept `@file` or `-`.
`--dry-run` previews intent without sending/enqueuing mutations. Local preview is not
an authoritative permission, graph or lease validation. Tracker changes are **not**
reversed by `gm undo`.

### Offline replicas and explicit conflicts

Initialize a replica online first. Offline mode is explicit: errors never silently
turn into queued successes. Each mutation gets a stable operation ID and each new
entity a stable random ID; issue keys are `null` until the server assigns a team
number at sync. Use the returned canonical ID to edit or link a new offline issue.

```bash
gm issue create 'Reproduce timeout' --team ENG --offline
gm issue update ISSUE_ID --data '{"description":"Reproduction steps…"}' --offline
gm tracker status --offline
gm tracker sync
gm tracker conflicts
gm tracker resolve OPERATION_ID --strategy reapply-local
gm tracker sync
```

SQLite stores the confirmed snapshot and ordered durable outbox. A process lock
serializes access, writes use full SQLite durability, and HTTP receipts are applied
atomically with dequeue. Lost acknowledgements replay the **same request and ID**;
they cannot be edited/resolved until the server definitively rejects them. Version
conflicts stop replay. `conflicts` shows preserved local intent and remote snapshot.
`reapply-local` explicitly rebases only the head batch; `accept-server` explicitly
discards only that batch. Later operations stay queued and may themselves require
resolution. No automatic last-writer-wins or dependent-edit deletion occurs.

Replicas live under `$XDG_DATA_HOME/gitmatrix/tracker` (default
`~/.local/share/gitmatrix/tracker`), partitioned by server, credential and owner,
with directory mode 0700 and database/lock mode 0600 on Unix. The verified account
ID is pinned before replay, including SSH reauthentication. No auth or lease token
is stored in the tracker database. A rotated token deliberately selects a fresh
partition: old edits remain intact. Before rotation, save `gm tracker status`'s
`replica` path. After signing in again:

```bash
gm tracker use orbit
gm tracker recover /private/old-partition/orbit.sqlite
gm tracker sync
```

Recovery verifies the same server, authenticated account and owner, requires an empty
destination outbox, and atomically moves the original requests/IDs and snapshot.
It never silently imports another identity's work. `tracker status` reports the
partition parent directory to locate retained replicas. Separate `XDG_DATA_HOME`
directories provide independent offline replicas for testing or multiple agents.

### Atomic graphs and fenced agents

`gm issue batch '@plan.json'` accepts 1–100 contract mutations as one atomic batch.
Assign canonical IDs yourself so later entries can refer to earlier creates:

```json
[
  {
    "kind": "issue.create",
    "id": "plan-spec",
    "data": { "teamId": "TEAM_ID", "title": "Specify search", "type": "prd" }
  },
  {
    "kind": "issue.create",
    "id": "plan-code",
    "data": { "teamId": "TEAM_ID", "title": "Implement search", "parentId": "plan-spec" }
  },
  {
    "kind": "link.add",
    "id": "plan-edge",
    "data": { "fromId": "plan-spec", "toId": "plan-code", "kind": "blocks" }
  }
]
```

The server rejects the entire batch for invalid references, authorization or cycles.
Updates include `expectedVersion`; claim mutations are not allowed in the outbox.
Ready means todo (or an expired claimed in-progress issue), no active claim, and
every blocker **done**. Canceled blockers still block. Parent hierarchy does not
implicitly block. `ready` and `show` provide cursor, cached timestamp, bounded
sections and advisory readiness; only an online claim grants exclusive work.

```bash
gm issue claim ENG-1 --agent search-agent --ttl 900
# Capture leaseToken securely from that response, then set GM_LEASE_TOKEN.
gm issue renew ENG-1 --ttl 900
gm issue checkpoint ENG-1 'Implementation complete; verifying edge cases'
gm issue complete ENG-1 --evidence '@verification.md'
# Or: gm issue release ENG-1
```

Claim/renew/release/complete always require online access. Tokens appear only in
claim/renew responses, never normal list/context/status output or SQLite. Prefer
`GM_LEASE_TOKEN` to a command-line argument that shell history/process listings may
expose. Expired or superseded tokens are rejected even for the same human account.
An ambiguous lease response is an error, not ownership: inspect the issue and do
not start work without a received token.

### Agent capability profiles

```bash
gm agent detect                          # Local metadata; no server or login
gm agent configure search-agent --model MODEL --tag rust --tag linux \
  --skill 'review=Review Rust changes'
gm agent show search-agent
gm agent list --owner orbit              # Profiles visible to this tracker
# With the agent's own write token in GM_TOKEN:
gm agent configure                      # Refresh its own profile
gm agent show
```

`configure NAME` creates or refreshes one of your existing agent identities; it
does not mint credentials or select a lease holder. Without a name, `configure`
and `show` require an agent token and refer only to that identity. People still
mint/revoke tokens through `gm agent token`/`revoke`. `configure --dry-run` shows
the proposed request without publishing it.

Version-1 profiles report the detected harness, OS/architecture, available CPU
parallelism, memory bytes (capped by visible Linux cgroup limits), runtime kind,
tags and skill descriptors. Unknown observations remain null or `unknown`; a
model is never inferred from a harness. Use `--harness`, `--model` and `--runtime`
for explicit declarations, including environments detection cannot identify.
Runtime values are `host`, `container`, `vm`, `wsl`, `cloudflare-worker`, `unknown`.

Skill discovery reads YAML `name` and `description` from `SKILL.md` frontmatter,
not prompts. It scans repository/ancestor and user `.agents`, `.claude`, `.codex`,
`.gemini`, `.opencode`, `.omp` and `.pi` skill directories, including user
`.omp/agent/skills`, `.pi/agent/skills` and `.config/{opencode,omp}/skills`.
Repeat `--skill-dir DIR` for additional roots. Traversal is bounded and
cycle-safe; symlinked skill collections work. Reports contain no skill paths,
prompt bodies, hostnames, tokens or environment-variable values.

Every refresh redetects environment, harness and installed skills. Omitted
`--model`, `--tag` and `--skill` preserve previous declarations. Supplied tags
replace the tag set; supplied skills replace the declared skill set. A declared
skill takes precedence over a discovered skill of the same name. `--clear-model`,
`--clear-harness`, `--clear-tags` and `--clear-skills` explicitly clear those
values; clearing skills removes declarations, not currently discovered skills.

Profiles are **self-reported advice**, visible to the accountable person and
members of their trackers. Treat skill descriptions and tags as untrusted data,
not instructions or proof of access. Choose a suitable identity from the profile,
then use the existing `gm issue claim --agent NAME` or delegation flow.
Capabilities do not grant permissions, change claim eligibility or automatically
route work. Reports carry `capabilitiesUpdatedAt`; old/unconfigured agents have
null capabilities rather than invented defaults.

## The model

- **The working copy is a change (`@`).** Workspace commands snapshot the files
  on disk into `@` first, so nothing is ever "uncommitted" and there's no index.
- **Change ids are stable.** `kxmqvtyl` (letters k-z) names a change across
  every rewrite; commit ids (hex) change each time. Both work wherever a
  revision is expected, as do `@`, `@-`, `trunk` and bookmark names.
- **Rewrites rebase descendants.** Edit, squash, split, abandon or describe any
  change in a stack; everything above it is rebased automatically.
  Conflicts never stop a command: they become conflict markers in the
  affected change, listed by `gm status`, and `gm push` refuses them.
- **Workspace changes are operations.** `gm undo` reverses the last one (repeat
  to go further back), `gm op log` lists them, `gm op restore <id>` jumps to any.
- **Trunk is immutable; there are no PRs.** `gm push` fast-forwards trunk to
  your change; `gm push -b <name>` pushes a bookmark (git branch) instead.

It stays a normal git repository. Bookmarks are branches, HEAD sits on `@`'s
parent (so `git status` and `git diff` show the change in progress), and change
ids live in a `change-id` commit header, the same one jj uses.

## Built for agents, like `cf`

The design follows Cloudflare's agent-first `cf` CLI:

- **One manifest.** `src/meta.rs` adds git equivalents, search keywords, output
  types and examples to the clap definitions in `src/cli.rs`. That manifest
  drives `--help`, `gm cli search`, `gm cli commands` and `gm schema`, and a
  unit test keeps it in sync with the CLI.
- **Discovery.** When an agent harness is detected (`CLAUDECODE`,
  `CODEX_THREAD_ID`, `CURSOR_AGENT` and so on, or `GM_AGENT=1`), help output starts
  with a banner pointing at `gm cli search "<task>"`, which returns the top 5
  commands as JSON, each with its git equivalent.
- **Schemas.** `gm schema <command>` gives the arguments, options and a JSON
  Schema of the output, generated from the Rust output types.
- **Output.** Compact JSON for agents and pipes, text at a terminal; override
  with `-o json|pretty|text`.
- **Errors.** JSON on stderr, `{"error":{"code","message","hint"}}`, with exit
  codes 1 error, 2 usage, 3 not found, 4 needs a decision (conflict, remote
  moved, missing description), 5 auth.
- **Safety.** Worktree add/remove support `--dry-run`, but are not reversed by
  `gm undo`. Workspace edits have their own undo log in each worktree.
- **Concurrency.** Mutations are serialized across the repository; each
  worktree keeps its own working copy, index, conflicts and operation log.

### Clone progress

`gm clone` reports live progress on **stderr**, leaving stdout as the single
final clone result. Text mode shows Git's transfer counters and byte/rate
information when available, followed by workspace initialization and completion.
Use `gm clone orbit/engine --quiet` to suppress progress; results and errors remain.

In JSON and pretty modes, stderr carries compact newline-delimited events:

```json
{
  "event": "clone.progress",
  "phase": "receiving",
  "elapsed_ms": 1389,
  "message": "Receiving objects:  18% (7/38)",
  "percent": 18,
  "current": 7,
  "total": 38
}
```

Phases are `connecting`, `enumerating`, `counting`, `compressing`, `receiving`,
`resolving`, `checkout`, `initializing`, and `complete`. Git determines which
transfer phases occur; other Git/server messages use `git` or `remote`.
Counters are omitted when unavailable and describe the current phase, not an
overall completion estimate. Updates within a phase are throttled to one per
250 ms, except phase completion; phase changes report immediately.

Read agent stderr as JSON lines: progress has `event: "clone.progress"`, while
a failure ends with the existing `{"error": ...}` envelope and a nonzero exit.
No `complete` event is emitted on failure. Callers that need stderr to contain
only the final error document can pass `--quiet`.

## Commands

|             |                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Inspect     | `status`, `log`, `show`, `diff`, `file show`, `file list`                                                                                 |
| Semantics   | `semantic list [--repo owner/name] [--ref ref] [--cursor cursor] [--path path] [--kind kind] [--language language] [--limit N]`           |
| Change      | `commit`, `describe`, `new`, `squash`, `split`, `edit`, `abandon`, `restore`                                                              |
| Restructure | `rebase`, `backout` (revert), `duplicate` (cherry-pick)                                                                                   |
| History     | `undo`, `op log`, `op restore`                                                                                                            |
| Bookmarks   | `bookmark list`, `bookmark set`, `bookmark delete [--remote]`                                                                             |
| Remote      | `clone`, `init`, `fetch`, `sync` (pull), `push [--sync] [-b name]`                                                                        |
| Worktrees   | `worktree add <path> [-r revision] [--include]`, `worktree list`, `worktree remove <path> [--force]`                                      |
| Server      | `auth login [--ssh]/status/logout`, `repo list/create/view/delete`, `repo mirror show/set/sync/remove`, `api`                             |
| SSH keys    | `auth ssh-key add/list/remove`, `auth git-credential` (git helper)                                                                        |
| CI          | `runs list/show/logs/wait/start/cancel/rerun`, `runner`, `secret`                                                                         |
| Packages    | `pkg list/show/versions`, `pkg delete/yank/restore/deprecate/tag`, `pkg sources/grant/revoke`, `pkg published`, `pkg upload`, `pkg setup` |
| Discovery   | `cli search`, `cli guide`, `cli commands`, `schema`                                                                                       |

## Local CI storage

`gm runner` uses `--workdir`, or `$XDG_CACHE_HOME/gitmatrix/runner` (falling back
to `~/.cache/gitmatrix/runner`), for job storage. Each attempt gets a fresh
`jobs/<attempt>/repo` checkout; cleanup removes it and its package credentials
before reporting the terminal result, including failed jobs.

Cargo compiler outputs persist under `cache/<scope>/slot-N/target`. The scope
hash includes the canonical server, repository and job name; active jobs lease
different slots so they cannot replace one another's running binaries. Later
jobs reuse released slots. Cargo still checks source/dependency freshness, and
tests always run. Explicit job or inherited `CARGO_TARGET_DIR` bypasses managed
caching unchanged; its lifetime and concurrency remain the caller's responsibility.

`GITMATRIX_CI_ARTIFACTS_DIR` is an absolute private directory under
`artifacts/<scope>/<attempt>`, retained after checkout cleanup. Its path is printed
in setup logs. Producers must write sanitized reports only; the runner does not
copy files from the checkout or provide remote artifact upload. The agent harness
exports only its allowlisted redacted JSON reports. Local cache/report directories
remain until removed by their owner; do not remove cache slots while jobs are active.

## Worktrees

Create parallel working directories without cloning objects or sharing
working-copy state:

```bash
gm worktree add ../feature --include
gm -C ../feature status
gm -C ../feature commit -m "Implement feature"
gm worktree list
gm worktree remove ../feature
```

`add` creates a detached Git worktree and initializes gm there. It defaults to
a **new change on the source checkout's current `@` snapshot**, including
pending source edits. Pass `-r trunk`, a bookmark, a change id or a commit id
to choose another base. Paths are relative to `--cwd`; creation also works
from a linked checkout or its subdirectories. The source must be initialized
with `gm init` or `gm clone`. Existing worktrees created with Git can be
adopted independently with `gm -C <path> init`.

Objects, remotes and bookmarks are shared. Working-copy changes, files,
conflicts and undo logs are independent. Undo/operation restore preserve
bookmark updates made elsewhere since this worktree last observed them.
gm refuses to move a branch checked out in a plain-Git worktree.
Repository-wide mutation locking and shared retention refs protect concurrent
gm operations and keep snapshotted history alive through Git GC.

### Include local configuration

`--include` opts into the source checkout's root `.worktreeinclude`, using
the [same gitignore pattern syntax as Claude Code](https://code.claude.com/docs/en/worktrees#copy-gitignored-files-into-worktrees):

```gitignore
# Copy ignored local settings, not tracked files.
.env
.env.local
config/secrets.json
cache/
!cache/private/
```

Blank lines, comments, negations, rooted patterns and `**` are supported.
Only matching **ignored, untracked regular files** are copied, with file
permissions preserved. Without `--include`, nothing is copied; a missing
include file is a no-op. Matching is rooted in the checkout where the command
runs, not always the main checkout.

gm rejects symlinks and metadata/traversal paths, and never overwrites an
existing destination entry or tracked path. Unlike Claude's documented
ignored-directory traversal optimization, `**` matches throughout ignored
directories. If copying or initialization fails after creation, the worktree
is kept and the error reports how to inspect/remove it.

Dependencies and setup commands are **not** run automatically. For pnpm
projects, enable `virtualStoreType: global` and install inside the new worktree;
do not copy `node_modules`. This repository's root `.worktreeinclude` selects
ignored environment files but excludes local database state and dependencies.
Only use secret copying and a writable shared package store within the same
trust boundary.

### Preview, removal and recovery

`gm worktree add ../feature --include --dry-run` lists the selected base and
files without snapshotting or creating the worktree. Its `@` is the last
stored snapshot, so unsnapshotted source edits can change the actual base.
`worktree list` includes main, bare and plain-Git worktrees and reports current,
initialized, locked and prunable state without snapshotting them.

Removal refuses the main checkout, the checkout containing the current
directory, locked worktrees, and modified/untracked/**ignored** files.
`--force` explicitly discards files, including copied secrets; it does not
override locks. `--dry-run` checks removal safety without removing anything.
Creation/removal themselves are not undoable.

Before removal, gm archives its recorded views and operation log beneath the
common Git directory's `gm/removed-worktrees/<id>/` and retains referenced
commits under `refs/gm/removed-worktrees/<id>/`. The command returns
`recovery_path` and `recovery_ref_prefix`. To recover a recorded working copy,
read `wc` from that archive's `view.json`, then run
`gm worktree add ../recovered -r <wc-commit-id>`. This starts a fresh change
on the recovered snapshot. Ignored files and edits never snapshotted by gm
are not in the archive. Retained history has no automatic expiration.

## Signing in with SSH keys

`gm auth login --ssh` signs in with an SSH key instead of a stored token, over
HTTPS: gm signs a one-time challenge from the server (SSHSIG) and gets a
one-hour session, renewed with the key when it runs out. Keys come from where
ssh finds them: the `IdentityAgent` in `~/.ssh/config` (1Password and other
agents), `SSH_AUTH_SOCK`, then key files (with a passphrase prompt at a
terminal). Register a key with `gm auth ssh-key add`; `gm auth ssh-key list`
shows what gm can see locally and what the server knows. See `src/ssh.rs`.

When git is set up to use another ssh, gm follows git instead. In WSL with
1Password on Windows that's `git config --global core.sshCommand ssh.exe`: gm
lists keys with `ssh-add.exe -L` and signs with `ssh-keygen.exe -Y sign`
(or `gpg.ssh.program`, e.g. `op-ssh-sign-wsl`, if you sign commits with it),
so 1Password's prompt appears on Windows. `user.signingKey` counts as a key
too, and `gitmatrix.sshCommand` sets the ssh for gm without touching git.

## Downloading artifacts and installing Unix CLIs

```sh
gm pkg download gm/latest/linux-x86_64/gm --owner orbit --dest ./gm
gm pkg install gm --owner orbit
gm pkg install gm --owner orbit --force
gm pkg install gm --owner orbit --version <apps/cli-tree-id> --bin-dir ./bin
```

`download` accepts `<name>/<version>/<path>` in the generic registry. Its default
destination is the artifact's basename. `install` defaults to
`$HOME/.local/bin/<name>` and selects `<os>-<arch>/<name>` within the version
(for example `linux-x86_64/gm` or `macos-aarch64/gm`). `--file` selects a different
artifact path. These are direct executable files, not archives or installer scripts.

Both commands use the normal Gitmatrix credentials, resolve `latest` once, and
verify SHA-256 while streaming to a temporary file beside the destination.
Installation sets mode `0755`. Only a verified complete download is atomically
published; `--force` is required to replace an existing regular file, including
a running `gm` binary. Symlinks and nonregular destinations are refused.
`--dry-run` checks remote metadata without creating files or directories.
Add the bin directory to `PATH` yourself; no shell configuration is edited.

The `matrixorg/gitmatrix` pipeline on gitmatrix.fward.dev publishes Linux x86-64 and ARM64 release
binaries as `gm/<apps/cli tree id>/<os>-<arch>/gm`: the git tree id of the CLI's
source (`git rev-parse HEAD:apps/cli`, `Cargo.lock` included). The same source
always has the same version, so unrelated pushes and reruns reuse the existing
artifact, and finding it needs only the checked-out commit, not history. Each
publish records the commit and CI run it came from. Publication runs in the
`deploy` job on `main`, after check, test and build pass; it asks the registry
first for each platform and builds only when an artifact is missing. The x86-64
CI host publishes `linux-x86_64/gm` and cross-compiles `linux-aarch64/gm` with
`aarch64-unknown-linux-gnu` and Debian Bookworm's ARM64 GNU toolchain. Both builds
finish before uploads start; reruns fill missing artifacts without replacing
ones already published. The native binary uploads both architectures.

On a Raspberry Pi running 64-bit Raspberry Pi OS Bookworm or newer, use
`gm pkg install gm --owner matrixorg` (add `--force` to update). It automatically
selects the ARM64 binary. The release requires glibc 2.36 or newer; it does not
run on a 32-bit Raspberry Pi OS or musl-based Linux. To bootstrap without `gm`,
build from source with `vp run cli#build`, then use the resulting release binary.
For manual cross-builds, install `gcc-aarch64-linux-gnu` and `libc6-dev-arm64-cross`,
run `rustup target add aarch64-unknown-linux-gnu`, and set
`CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc` and
`CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc` when building with
`cargo build --locked --release --manifest-path apps/cli/Cargo.toml --target aarch64-unknown-linux-gnu`.

To bootstrap from an older `gm` without these commands, use
`./apps/cli/target/release/gm pkg install gm --owner orbit` after a local release
build. For feature validation, always pass an external disposable `--bin-dir`
instead of replacing a shared/global binary.

## Layout

- `src/repo/`: the change model on git. `mod.rs` holds the workspace:
  snapshot, rebase engine, checkout, op log. `revset.rs` resolves revisions.
  `trees.rs` merges trees and writes them to disk. `view.rs` is the stored state
  in the checkout's Git administrative directory under `gm/` (`.git/gm/` for
  the main checkout, `.git/worktrees/<name>/gm/` for linked worktrees).
- `src/commands/`: local commands, worktree lifecycle/include copying,
  network commands (clone, sync, push) and server commands.
- `src/meta.rs`, `src/cli.rs`: the manifest, search, schema and guide.
- `tests/flow.rs`: end-to-end tests against a local bare remote.

libgit2 (vendored, through `git2`) implements the change model. The `git` binary
handles worktree lifecycle and ignored-file enumeration, plus fetch and push
with the token passed through `GIT_CONFIG_*` so it never appears in `ps`.
Credentials live in `~/.config/gitmatrix/gm.json`; `GM_SERVER` and `GM_TOKEN`
override them. Inside a CI job, `GITMATRIX_URL` and `GITMATRIX_TOKEN` are used
when those aren't set, so `gm pkg upload` and `gm pkg published` act as the job.

## Develop

```bash
cargo test          # unit + end-to-end (no server needed)
cargo clippy --all-targets
pnpm run check      # fmt + clippy with warnings as errors
```

## Known gaps

- `gm log` text output lists changes without drawing a graph; JSON output has
  every change's parents.
- Merge commits are rebased by their first parent's changes only.
- No interactive mode (`split -i`), tags, blame or submodules.
