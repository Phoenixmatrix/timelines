---
name: gitmatrix-gm-install
description: Keep this machine's gm current after a gm change ships, and keep feature builds out of the shared install. Use when you change apps/cli (gm), after its push to main deploys, or when `gm` behaves like an older version.
---

# Keeping the machine's gm current

Every agent and person on this machine runs one shared `gm`: the published
release at `~/.local/bin/gm`. When your change to gm (`apps/cli`) lands on
main, the next session runs the old binary until someone installs the new
release. If you shipped it, that's your job.

## While developing

- Test your build with `vp run agent gm -- …`. It runs this worktree's
  compiled binary against an isolated server.
- Never put a feature build where other agents pick it up. That means no
  `cargo install`, no `pnpm run install-bin`, and no copying `target/*/gm`
  into `~/.local/bin` or `~/.cargo/bin`. A gm install that isn't on main
  changes every other agent's tools mid-task.

## After your gm change deploys

Pushing to main runs the `deploy` job, whose **Publish gm if it changed**
step uploads release binaries. Each release is versioned by the `apps/cli`
source tree id, so pushes that don't touch gm reuse the existing release.

1. Wait for the pipeline: `gm runs wait`. Continue only when `deploy`
   succeeded.
2. Install the release:

   ```sh
   gm pkg install gm --owner matrixorg --force
   ```

   It verifies the checksum and replaces `~/.local/bin/gm` in place.

3. Confirm you got main's gm, not just any release. These two must match:

   ```sh
   gm pkg install gm --owner matrixorg --dry-run   # "version"
   git rev-parse origin/main:apps/cli
   ```

   `gm --version` doesn't change between releases, so don't use it to check.
   To check a feature instead, use one of its new flags or output fields
   (`gm schema <command>`).

4. Confirm nothing hides it:

   ```sh
   which -a gm    # ~/.local/bin/gm must be the first, ideally the only, entry
   ```

   Shells and agent harnesses here put `~/.cargo/bin` before `~/.local/bin`,
   so any `gm` there wins silently. If you find one, `cargo install --list`
   shows which crate installed it. Ask the person before removing a binary
   you didn't install, then run `cargo uninstall gitmatrix-cli`.

5. Report the installed version (the `apps/cli` tree id) with your completion
   evidence.

## If agents can't find gm

`~/.local/bin` must be on `PATH` for every shell an agent might start,
including one started with a clean environment:

```sh
for s in bash sh zsh; do env -i HOME=$HOME PATH=/usr/bin:/bin $s -lc 'command -v gm'; done
env -i HOME=$HOME PATH=/usr/bin:/bin zsh -c 'command -v gm'
```

Each should print `~/.local/bin/gm`. zsh reads `~/.zshenv` for every shell,
not `~/.profile`, so a missing path belongs there, behind a guard so it isn't
added twice. Change shell configuration only with the person's agreement.

## Not covered here

- Agent worktrees: `vp run agent gm` always uses that worktree's own build,
  whatever the machine has installed.
- Other machines, such as a Raspberry Pi, install the same way; the installer
  picks the right architecture.
