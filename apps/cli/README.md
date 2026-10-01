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

## Commands

|             |                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| Inspect     | `status`, `log`, `show`, `diff`, `file show`, `file list`                                            |
| Change      | `commit`, `describe`, `new`, `squash`, `split`, `edit`, `abandon`, `restore`                         |
| Restructure | `rebase`, `backout` (revert), `duplicate` (cherry-pick)                                              |
| History     | `undo`, `op log`, `op restore`                                                                       |
| Bookmarks   | `bookmark list`, `bookmark set`, `bookmark delete [--remote]`                                        |
| Remote      | `clone`, `init`, `fetch`, `sync` (pull), `push [--sync] [-b name]`                                   |
| Worktrees   | `worktree add <path> [-r revision] [--include]`, `worktree list`, `worktree remove <path> [--force]` |
| Server      | `auth login [--ssh]/status/logout`, `repo list/create/view/delete`, `api`                            |
| SSH keys    | `auth ssh-key add/list/remove`, `auth git-credential` (git helper)                                   |
| CI          | `runs list/show/logs/wait/start/cancel/rerun`, `runner`, `secret`                                    |
| Discovery   | `cli search`, `cli guide`, `cli commands`, `schema`                                                  |

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
override them.

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
