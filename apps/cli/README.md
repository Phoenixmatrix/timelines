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

- **The working copy is a change (`@`).** Every command snapshots the files on
  disk into `@` first, so nothing is ever "uncommitted" and there's no index.
- **Change ids are stable.** `kxmqvtyl` (letters k-z) names a change across
  every rewrite; commit ids (hex) change each time. Both work wherever a
  revision is expected, as do `@`, `@-`, `trunk` and bookmark names.
- **Rewrites rebase descendants.** Edit, squash, split, abandon or describe any
  change in a stack; everything above it is rebased automatically.
  Conflicts never stop a command: they become conflict markers in the
  affected change, listed by `gm status`, and `gm push` refuses them.
- **Every command is an operation.** `gm undo` reverses the last one (repeat
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
- **Safety.** Every mutating command takes `--dry-run`, and everything local can
  be undone.
- **Speed.** About 10 ms per command on a normal repository. Concurrent invocations
  are serialized by a lock, so parallel agents can share a working copy.

## Commands

|             |                                                                              |
| ----------- | ---------------------------------------------------------------------------- |
| Inspect     | `status`, `log`, `show`, `diff`, `file show`, `file list`                    |
| Change      | `commit`, `describe`, `new`, `squash`, `split`, `edit`, `abandon`, `restore` |
| Restructure | `rebase`, `backout` (revert), `duplicate` (cherry-pick)                      |
| History     | `undo`, `op log`, `op restore`                                               |
| Bookmarks   | `bookmark list`, `bookmark set`, `bookmark delete [--remote]`                |
| Remote      | `clone`, `init`, `fetch`, `sync` (pull), `push [--sync] [-b name]`           |
| Server      | `auth login/status/logout`, `repo list/create/view/delete`, `api`            |
| CI          | `runs list/show/logs/wait/start/cancel/rerun`, `runner`, `secret`            |
| Discovery   | `cli search`, `cli guide`, `cli commands`, `schema`                          |

## Layout

- `src/repo/`: the change model on git. `mod.rs` holds the workspace:
  snapshot, rebase engine, checkout, op log. `revset.rs` resolves revisions.
  `trees.rs` merges trees and writes them to disk. `view.rs` is the stored state
  in `.git/gm/`.
- `src/commands/`: local commands, network commands (clone, sync, push) and
  server commands.
- `src/meta.rs`, `src/cli.rs`: the manifest, search, schema and guide.
- `tests/flow.rs`: end-to-end tests against a local bare remote.

libgit2 (vendored, through `git2`) does everything local. The `git` binary
handles fetch and push, with the token passed as a Bearer header through
`GIT_CONFIG_*` environment variables so it never appears in `ps`.
Credentials live in `~/.config/gitmatrix/gm.json`; `GM_SERVER` and `GM_TOKEN`
override them.

## Develop

```bash
cargo test          # unit + end-to-end (no server needed)
cargo clippy --all-targets
pnpm run check      # fmt + clippy with warnings as errors
```

## Known gaps

- Old operations rely on git keeping their commits: `git gc` may prune
  unreachable ones after two weeks, after which `gm op restore` to them fails.
- `gm log` text output lists changes without drawing a graph; JSON output has
  every change's parents.
- Merge commits are rebased by their first parent's changes only.
- No interactive mode (`split -i`), tags, blame or submodules.
