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

# Required agent development workflow

- Follow the root [agent-first workflow](README.md#agent-first-development).
  Each agent uses its own source `gm worktree`, `vp install`, and
  `vp run agent setup`; run the app with `vp run agent up`.
- Use the printed isolated origin and `vp run agent gm -- ...` for product
  testing. That wrapper uses this worktree's compiled binary, credentials and
  external disposable workspace. Never test mutations on canonical port 5180,
  copy another environment's state, or install a feature binary globally.
- Use fresh browser contexts: cookies are not isolated by port. `agent seed`
  reconciles fixtures; `agent reset` destroys and recreates them. Inspect data
  with `agent inspect` or scoped tracker/issue commands.
- Before completion, run **`vp run ready`**. It runs uncached static gates,
  every workspace's tests/builds and fresh real CLI/API/browser/mirror E2E,
  without AI inference or AI resource provisioning. E2E runs **only here**:
  server CI skips it (too expensive per push), so `ready` is the only place
  it runs before code lands. For changes to knowledge,
  wiki, embeddings or AI Search, follow
  `.agents/skills/gitmatrix-ai-verification/SKILL.md` and explicitly run
  `vp run agent test-ai`. Also exercise the specific changed consumer path.
  Missing required services, browser dependencies or credentials are failures.
- Keep the E2E artifacts and inspect failures before changing assertions.
  Sandbox/deployment changes (`apps/website/ci/`, `worker/ci/sandbox.ts`,
  `cloudflare.config.ts`) need their own deployment-boundary check: push and
  watch the production run with `gm runs wait`.
- Remote resources cost money. Setup installs hourly user-systemd cleanup;
  environments expire after 24 hours, with four live environments per user.
  Use `agent destroy` when finished, not merely `agent stop`. Check
  `agent maintenance status`; never delete the central resource journal.
- `.worktreeinclude` intentionally copies no secrets or local service state.
  Agents and local runners share a trusted host, not a hostile-code sandbox.

# Version control in this repo

This checkout is a `gm` workspace, and Gitmatrix is the source of truth:

- **Commit and push this project with ordinary `gm`**, outside `agent gm`.
  `origin` is `matrixorg/gitmatrix` on production
  (`https://gitmatrix.fward.dev`), and plain `gm` defaults to that server:
  `gm commit -m "…"`, then `gm push` (or `gm push --sync` when trunk moved)
  lands it on `main`. Run `gm cli guide` once for the workflow,
  and `gm cli search "<task>"` to find commands. Plain `git commit` still
  works (gm adopts the commits), but never `git push`: gm pushes with the
  right credentials and keeps its own view of trunk. Git shows a detached
  HEAD here; that's gm's working copy, not a problem.
- **GitHub is a backup, written only by the mirror.** Every push to
  Gitmatrix is mirrored to GitHub (the `github` remote) one way. Don't push
  there: the mirror overwrites it. Use `gh` only to read GitHub.
- **Every push runs the quality gates** in `.gitmatrix/ci.yml` on production,
  in Cloudflare Sandbox containers: check, test and build, independently;
  all must pass. On main, a `deploy` job then ships what changed (migrations,
  the Worker, `gm`); pushing to main **is** deploying to production. E2E is local-only (`if: runner == "local"`), so run
  `vp run ready` first, then `gm push && gm runs wait` to confirm the
  pipeline. Real AI checks are explicit, never automatic.
- **Testing Gitmatrix itself:** use the scoped workflow above. Keep all product
  clones outside this source checkout. `gm -C <clone>` selects a disposable
  clone while `agent gm` keeps its server and credentials isolated.
- **CI on a local server runs on this machine, on demand.** `vp dev` starts a
  runner per queued job; it exits when done. There the pipeline also runs E2E,
  which needs the trusted Linux host's Cloudflare login and user-systemd
  manager. `GITMATRIX_CI_RUNNER=sandbox vp dev` requires Docker and tries the
  Sandbox path locally; it is not a substitute for watching a production run.

# Cloudflare tooling: use `cf`, not wrangler

The `cf` CLI supersedes wrangler for everything in this repo: types,
D1 migrations, deploys, resource management (Artifacts, AI Search, Vectorize,
Workers AI and so on). Don't run `wrangler` commands or add wrangler configs.

- Worker configuration lives in `cloudflare.config.ts` (`cf/config`), not
  `wrangler.jsonc`/`wrangler.toml`. The pinned Vite plugin v2 reads it directly
  without the legacy `experimental.newConfig` option.
- Generate binding types with `cf workers types` (writes `.cloudflare/types/`).
- Find commands with `cf cli search "<task>"`, then `<command> --help` or
  `cf schema <command>`; don't crawl `--help` trees.
- The `wrangler` package stays installed only because `@cloudflare/vite-plugin`
  depends on it.
- Name new D1 migrations (`apps/website/migrations`, `registry/migrations`,
  `seed`) by UTC timestamp: `YYYYMMDDHHMMSS_snake_case_description.sql`, from
  `date -u +%Y%m%d%H%M%S`. Never add a four-digit name or reuse a prefix;
  `vp test` refuses both. See "Adding a migration" in `apps/website/README.md`.

<!-- gm:agents begin: managed by `gm agent setup` from .gitmatrix/agents.yml; edit that and rerun -->

## Working through the issue graph

Work is tracked in Gitmatrix: matrixorg, team CORE. The loop, in brief (the
`gitmatrix-graph-work` skill has the details):

1. `gm issue next` picks and claims the most valuable ready issue in scope.
   Nothing ready means stop, not retry.
2. Work it: `gm issue checkpoint <issue> '<done; next>'` as you go, and
   `gm issue renew <issue>` before the lease (1 hour) ends.
3. Need to find something out (where code lives, why CI failed, what an issue
   depends on)? `gm ask "<question>"` asks the Gitmatrix assistant. Blocked on
   a person? `gm issue ask <issue> --kind question|approval|decision|credential --prompt '…'`.
4. Ship (`vp run ready`, then `gm push && gm runs wait`), then `gm issue complete <issue> --evidence '…'`. Can't
   finish: `gm issue release <issue>`.

When an agent harness drives gm here, gm acts as this checkout's agent
(`gm auth status` shows `actingAs`) and keeps lease tokens for it. To change
any of this, edit `.gitmatrix/agents.yml` (shared) or
`.gitmatrix/agent.local.yml` (this checkout), then rerun `gm agent setup`.

<!-- gm:agents end -->
