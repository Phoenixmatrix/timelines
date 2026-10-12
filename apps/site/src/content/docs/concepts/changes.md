---
title: Changes and trunk
description: gm's change-based model, how undo and automatic rebasing work, and how gm push lands work on trunk without pull requests.
section: Concepts
order: 1
---

`gm` is change-based, like [jujutsu](https://jj-vcs.github.io/jj/), rather than commit-and-stage based like git. It is built for agents that commit very often: commit early, commit often, no staging area, no pull requests. Under the hood it stays a normal git repository.

## The working copy is a change

Your files always belong to a change called `@`, the working copy. Every workspace command first snapshots the files on disk into `@`, so nothing is ever "uncommitted" and there is no index to manage.

`gm commit -m` describes `@` and starts a new, empty `@` on top of it. That is the "save my work" step:

```sh
gm status                          # where am I, what changed
gm commit -m "Add retry to fetch"
gm commit -m "Cover retry in tests"
```

Pass paths to commit only those files; the rest stays in the new working copy:

```sh
gm commit -m "Only the docs" docs/
```

## Change ids and revisions

Every change has a **change id**, written in the letters k to z (for example `kxmqvtyl`). It stays the same when the change is rewritten. Commit ids (hex) change on every rewrite. Prefer change ids when you refer to a change.

Anywhere a revision is expected you can use:

| Revision    | Meaning                     |
| ----------- | --------------------------- |
| `@`         | the working copy            |
| `@-`, `@--` | its parent, its grandparent |
| `trunk`     | the server's main line      |
| `kxmq`      | a change id prefix          |
| `1a2b3c`    | a commit id prefix          |
| `name`      | a bookmark (a git branch)   |

`gm log -r` also takes ranges such as `trunk..@` and `all`.

## Rewrites rebase descendants

You can edit, squash, split, abandon or describe any change in a stack, and everything above it is rebased automatically.

```sh
gm squash --into kxmq          # move @'s edits into an earlier change
gm edit kxmq                   # make an earlier change the working copy
gm new                         # start a fresh change on top again
gm describe -m "Better message" # reword the working copy's description
gm abandon kxmq                # drop a change; its descendants move onto its parent
```

Conflicts never stop a command halfway. A conflicted change gets conflict markers in its files and is listed under `conflicts` in `gm status`. Edit the markers away in `@` (or `gm edit` the change first) and the next gm command records the fix. For a conflict in a change below `@`, fix the files in `@` and then `gm squash --into <change>`. `gm push` refuses changes that still have conflicts.

`gm merge <rev>` creates a merge change with parents `@-` and `<rev>`, below `@`. Rewrites keep every parent of a merge.

## Everything can be undone

Each workspace change is an operation. `gm undo` reverses the last one; repeat it to go further back. `gm op log` lists operations and `gm op restore <id>` jumps to any of them.

```sh
gm undo
gm op log
gm op restore <operation-id>
```

Undo covers your local workspace only. It does not reverse tracker changes, timeline records on the server, or anything already pushed.

## Trunk is the truth

`trunk` is the server's main line, and changes in trunk are immutable. There are no pull requests: `gm push` fast-forwards trunk to your change, and its ancestors go with it.

```sh
gm push                 # land @ (or @- when @ is empty) on trunk
gm push -r kxmq         # land a specific change and its ancestors
```

If trunk has moved since you last fetched, `gm push` stops with exit code 4. `gm sync` fetches and rebases your changes onto the new trunk, and `gm push --sync` does both before pushing:

```sh
gm sync                 # like git pull --rebase
gm push --sync
```

When trunk has landed some of your changes (for example as rewritten copies), `gm sync` drops them from your stack and moves what was built on them onto trunk.

To push to a branch instead of trunk, use a bookmark: `gm push -b feature-x` creates or moves the bookmark and pushes it.

Each push to main runs the repository's CI. See [CI and steps](/docs/concepts/ci/).

### Other ways to land

- **The merge queue.** For independent work tracked in the issue graph, `gm push --queue --issue <key>` submits your change to the server, which merges it onto current main, runs the gates, and advances main only with a passing candidate. Submission is not landing. See [The issue graph](/docs/concepts/issue-graph/#the-merge-queue).
- **Timelines.** Broad or risky work can go to a timeline, where `gm push` updates the timeline instead of main, and lands later. See [Timelines](/docs/concepts/timelines/).

## It stays a git repository

Bookmarks are git branches. `HEAD` sits on `@`'s parent, so `git status` and `git diff` show the change in progress. Change ids live in a `change-id` commit header, the same one jujutsu uses. Git shows a detached `HEAD`; that is gm's working copy, not a problem.

## Git equivalents

| gm                        | git                                       |
| ------------------------- | ----------------------------------------- |
| `gm commit -m`            | `git commit -am`                          |
| `gm squash`               | `git commit --amend` / fixup              |
| `gm split -m msg <paths>` | partial commit                            |
| `gm restore [paths]`      | discard edits                             |
| `gm new`                  | start a fresh change (also how you stash) |
| `gm rebase -d trunk`      | `git rebase`                              |
| `gm backout -r <rev>`     | `git revert`                              |
| `gm duplicate <rev>`      | `git cherry-pick`                         |
| `gm sync`                 | `git pull --rebase`                       |
| `gm push`                 | `git push` to main                        |

`gm cli search "<task>"` returns the matching commands with their git equivalents.

## Worktrees

`gm worktree add` creates a parallel working directory without cloning objects again. Each worktree has its own files, `@` and undo log; objects and bookmarks are shared. This suits several agents working in one repository.

```sh
gm worktree add ../feature            # a sibling of @, on its parent (no uncommitted edits)
gm worktree add ../clean -r trunk     # start from trunk instead (-r @ carries uncommitted edits)
gm -C ../feature status
gm worktree list
gm worktree remove ../feature
```

`--include` copies ignored, untracked files that match the root `.worktreeinclude` (gitignore syntax), such as local environment files. Dependencies are not installed for you. Creating and removing worktrees is not undoable, though removal archives gm's recorded history for recovery.

See the [gm reference](/docs/gm/) for each command, for example [`gm push`](/docs/gm/#gm-push), [`gm sync`](/docs/gm/#gm-sync) and [`gm undo`](/docs/gm/#gm-undo).
