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

These steps require a v4-compatible client. An old binary may not understand
`--space`, and its content API calls are refused after cutover. Do not try the
removed `--owner` flag as a fallback. If the installed client is incompatible,
use the bootstrap sequence below first.

1. Wait for the pipeline: `gm runs wait`. Continue only when `deploy`
   succeeded.
2. Install the release:

   ```sh
   gm pkg install gm --space matrixorg --force
   ```

   It verifies the checksum and replaces `~/.local/bin/gm` in place.

3. Confirm you got main's gm, not just any release. These two must match:

   ```sh
   gm pkg install gm --space matrixorg --force --dry-run   # "version"
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

## Bootstrap when the installed client is too old

1. Confirm in the pipeline's web view that the v4 `main` deployment and CLI
   publication succeeded. An old client's `gm runs wait` may itself be gated.
   Do not install an unpublished feature build to bypass the gate.
2. Obtain that exact released `main` commit with native Git. On Linux x86-64
   or ARM64, follow apps/cli/README.md's **Bootstrapping across the v4 cutover**
   import-only invocation of `tools/preview/preview.ts`'s exported `installGm`.
   It downloads a published binary into a new temporary directory and verifies
   `x-checksum-sha256`; it does not compile source or run preview operations.
   Provide authorized `GITMATRIX_URL`, `GITMATRIX_SPACE` and `GITMATRIX_TOKEN`
   through the environment without exposing secrets. Clear `GITMATRIX_PREVIEW_GM`,
   whose override would bypass download/checksum verification.
3. Use that temporary binary's explicit path for
   `pkg install gm --space matrixorg --force --dry-run`. The helper selects
   latest; require the dry-run version to match
   `git rev-parse origin/main:apps/cli` for the released commit. Then run
   `pkg install gm --space matrixorg --version <released-apps/cli-tree-id> --force`
   with that same binary. The package installer verifies the published SHA-256
   and atomically replaces `~/.local/bin/gm`. Install on the intended machine,
   not into a remote runtime's home directory by accident. Remove only this
   invocation's temporary download/directory afterward.
4. Check PATH precedence and report the source-tree version as above. Preserve
   legacy tracker replicas/outboxes and follow apps/cli/README.md's explicit
   export/recovery sequence with the released v4 client.

This sequence uses an existing checksum-verifying release helper and package
installer, not the old client's content API. It requires released v4 helper
source, a supported Node runtime, Linux x86-64 or ARM64 with glibc 2.36+, and
authorized registry access. The helper is not a macOS, 32-bit or musl installer.
If a prerequisite is unavailable, report it instead of improvising an unverified
download or installing a feature build.

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
