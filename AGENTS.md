<!--VITE PLUS START-->

# Using Vite+, the Unified Toolchain for the Web

This project is using Vite+, a unified toolchain built on top of Vite, Rolldown, Vitest, tsdown, Oxlint, Oxfmt, and Vite Task. Vite+ wraps runtime management, package management, and frontend tooling in a single global CLI called `vp`. Vite+ is distinct from Vite, and it invokes Vite through `vp dev` and `vp build`. Run `vp help` to print a list of commands and `vp <command> --help` for information about a specific command.

Docs are local at `node_modules/vite-plus/docs` or online at https://viteplus.dev/guide/.

## Built-in Commands vs Scripts

`vp <name>` runs a built-in command. `vp run <name>` runs a `package.json` script or a `vite.config.ts` task. Scripts cannot overwrite built-ins, so `vp dev` and `vp run dev` may do different things. Check `package.json` and `vite.config.ts` first, and run `vp run <name>` when the project defines a script or task with that name.

## Tool Versions

Run `vp toolchain` to show versions and relationships in the active Vite+
release. Add a tool name to select part of the graph. For example, run
`vp toolchain vite`. Use `--global` to ignore the local `vite-plus` package. Use
`vp why <package>` to show the package-manager dependency graph.

## Review Checklist

- [ ] Run `vp install` after pulling remote changes and before getting started.
- [ ] Run `vp check` and `vp test` to format, lint, type check and test changes.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Version control in this repo

This checkout is a `gm` workspace, and Gitmatrix is the source of truth:

- **Commit and push this project with `gm`** (`apps/cli`, installed with
  `pnpm --filter cli run install-bin`). `origin` is `orbit/gitmatrix` on the
  dev server: `gm commit -m "…"`, then `gm push` (or `gm push --sync` when
  trunk moved) lands it on `main`. Run `gm cli guide` once for the workflow,
  and `gm cli search "<task>"` to find commands. Plain `git commit` still
  works (gm adopts the commits), but never `git push`: gm pushes with the
  right credentials and keeps its own view of trunk. Git shows a detached
  HEAD here; that's gm's working copy, not a problem.
- **GitHub is a backup, written only by the mirror.** Every push to
  Gitmatrix is mirrored to GitHub (the `github` remote) one way. Don't push
  there: the mirror overwrites it. Use `gh` only to read GitHub.
- **Every push runs the quality gates** in `.gitmatrix/ci.yml` (check, test,
  build). Run `vp check`, `vp test` and `vp run cli#check` first, then
  `gm push && gm runs wait` to confirm the run.
- **Testing Gitmatrix itself:** exercise the product (cloning
  Gitmatrix-hosted repos, committing, pushing, checking permissions as
  different personas) with `gm` against the local dev server (`vp dev` in
  `apps/website`), in throwaway clones outside this checkout, such as a temp
  directory.
- **CI in development runs on this machine, on demand.** `vp dev` starts a
  runner for each queued job and it exits when the job is done, the way
  Cloudflare Sandbox containers come and go once deployed; nothing needs to
  stay running. Use `GITMATRIX_CI_RUNNER=sandbox vp dev` (needs Docker) only
  when changing the sandbox runner itself.

# Cloudflare tooling: use `cf`, not wrangler

The `cf` CLI supersedes wrangler for everything in this repo: types,
D1 migrations, deploys, resource management (Artifacts, AI Search, Vectorize,
Workers AI and so on). Don't run `wrangler` commands or add wrangler configs.

- Worker configuration lives in `cloudflare.config.ts` (`cf/config`), not
  `wrangler.jsonc`/`wrangler.toml`. The Vite plugin loads it with
  `cloudflare({ experimental: { newConfig: true } })`.
- Generate binding types with `cf workers types` (writes `.cloudflare/types/`).
- Find commands with `cf cli search "<task>"`, then `<command> --help` or
  `cf schema <command>`; don't crawl `--help` trees.
- The `wrangler` package stays installed only because `@cloudflare/vite-plugin`
  depends on it.
