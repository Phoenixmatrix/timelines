# Vite+ Monorepo Starter

A starter for creating a Vite+ monorepo.

## Development

- Check everything is ready:

```bash
vp run ready
```

- Run the tests:

```bash
vp run -r test
```

- Build the monorepo:

```bash
vp run -r build
```

- Run the development server:

```bash
vp run dev
```

## Worktrees and shared dependencies

This repository pins pnpm 12.8.1 and enables
[`virtualStoreType: global`](https://pnpm.io/git-worktrees). Each checkout has
its own `node_modules` symlinks; package contents are shared through pnpm's
global virtual store. Run an install in **each** checkout instead of copying
or symlinking another checkout's `node_modules`.

For this GitHub-hosted source repository, use Git:

```bash
git worktree add ../gitmatrix-feature -b feature-name
cd ../gitmatrix-feature
vp install
vp run website#cf-typegen
```

Use the same pinned package manager through `vp`; `pnpm install` is also
supported when it selects the pinned version. The workspace's
`packageExtensions` supply missing React type peers so declaration resolution
works outside the checkout's directory tree. A shared writable store is only
appropriate for mutually trusted checkouts and agents.

For repositories managed by Gitmatrix, see the
[CLI worktree commands](apps/cli/README.md#worktrees). The root
`.worktreeinclude` selects ignored `.env*` and `.dev.vars*` files, excluding
example files, when using `gm worktree add --include` or Claude Code's worktrees.
It deliberately excludes dependencies, build output and mutable local database
state. Initialize local services in each checkout following the
[website development instructions](apps/website/README.md).

## Distributed issue tracker

Gitmatrix includes an account-owned tracker independent of Git repositories:
teams own issues, cross-team workspaces organize them, and repositories subscribe
to workspaces without changing access permissions.

Use `/tracker` for the human workbench, or `gm tracker use OWNER` followed by
`gm issue ready` for agent work. The CLI supports private offline SQLite replicas,
explicit conflict resolution, atomic dependency graphs and online fenced claims.
See the [tracker architecture and API](apps/website/README.md#distributed-issue-tracker)
and [CLI workflows](apps/cli/README.md#distributed-issue-tracker).
