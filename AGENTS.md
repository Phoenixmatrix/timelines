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
- [ ] Run `vp run ready` for this repository's selected checks and tests; inspect
      `vp run ready --dry-run` first. Do not routinely add blanket `vp check`/`vp test` runs.
- [ ] Check if there are `vite.config.ts` tasks or `package.json` scripts necessary for validation, run via `vp run <script>`.
- [ ] If setup, runtime, or package-manager behavior looks wrong, run `vp env doctor` and include its output when asking for help.

<!--VITE PLUS END-->

# Required agent development workflow

- Follow the root [agent-first workflow](README.md#agent-first-development).
  Each agent uses its own source `gm worktree`, `vp install`, and
  `vp run agent setup`; run the app with `vp run agent up`.
- `prepare` runs `vp config --no-agent`: it configures hooks without overwriting
  this repository's readiness guidance with Vite+'s generic agent checklist.
- AI costs money, so it is **opt-in**. `agent setup` provisions no Workers AI,
  AI Gateway, Vectorize or AI Search and seeds without paid Knowledge builds;
  the UI shows its AI-off states. Use `vp run agent setup --ai` (after
  `agent destroy` if the environment exists) only when your change is to
  knowledge, wiki, embeddings, AI Search, the assistant, release-note
  generation, avatars or Atlas descriptions and you must see it working with
  real models. `agent status` shows each environment's `ai`. The canonical
  `vp dev` is AI-off too unless started with `GITMATRIX_DEV_AI=enabled`.
- Use the printed isolated origin and `vp run agent gm -- ...` for product
  testing. That wrapper uses this worktree's compiled binary, credentials and
  external disposable workspace. Never test mutations on canonical port 5180,
  copy another environment's state, or install a feature binary globally.
- Use fresh browser contexts: cookies are not isolated by port. `agent seed`
  reconciles fixtures; `agent reset` destroys and recreates them. Inspect data
  with `agent inspect` or scoped tracker/issue commands.
- Before completion, inspect **`vp run ready --dry-run`**, then run
  **`vp run ready`**. Plain `ready` is the required, automatically selective
  gate: it runs uncached checks, workspace tests/builds and non-AI E2E selected
  from changed paths and dependencies. Do not routinely prepend or append
  blanket `vp check`, `vp test`, recursive builds or `vp run agent test`;
  targeted checks for development/debugging are still appropriate.
  Sync the source workspace and run `vp install` first: selection includes
  committed, staged, unstaged and untracked work since the merge base with
  local `origin/main`, not just the last edit, and does not fetch.
  Use `--all` only for deliberately required comprehensive verification.
  Use `--base <ref>` only for the actual integration branch, never to hide
  unlanded changes or force a smaller plan. Unknown/global/shared harness
  changes automatically fall back to full coverage; accept that selection.
  Frontend changes keep browser journeys and prerequisites. Server CI skips
  E2E (too expensive per push), so selected live journeys must pass locally
  before code lands. See [coverage rules](README.md#completion-gate).
  For changes to knowledge, wiki, embeddings, AI Search, the assistant,
  release notes, avatars or the Atlas, follow
  `.agents/skills/gitmatrix-ai-verification/SKILL.md` and explicitly run
  `vp run agent test-ai`: it runs only the stages your changed paths map to
  (`--dry-run` shows them). Run it once, deliberately: after a failure, fix
  the cause and use `--resume`; it refuses unchanged reruns and full reruns
  for 30 minutes. Also exercise the specific changed consumer path.
  Missing required services, browser dependencies or credentials are failures.
- After a change to gm (`apps/cli`) deploys, install the new release for
  every agent on this machine: follow
  `.agents/skills/gitmatrix-gm-install/SKILL.md`. Never install a feature
  build of gm machine-wide.
- Put each test where it's cheapest (apps/website/README.md, "Testing"): pure
  logic in Node unit tests, UI behaviour (rendering, keyboard, focus, touch,
  motion, themes, layout) in browser-mode tests (`*.browser.test.tsx`, in
  `vp test` and CI), and only real-stack journeys in E2E.
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
- **GitHub is a backup, written only by the mirror.** Pushes to `main` and
  tags are mirrored to GitHub (the `github` remote) one way; other branches
  stay on Gitmatrix. Don't push there: the mirror overwrites it. Use `gh` only
  to read GitHub.
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
   Nothing ready means stop, not retry. No returned fencing token means no ownership.
   `not_ready` pickup permits nobody to start; `human_only` permits people, never
   agents, even when assigned or delegated. Only a person can change an existing
   restricted policy. Ask them; do not bypass it with status changes or credentials.
2. Choose where it goes before you start: the claim's `timelineRule` says
   whether the issue requires a timeline, never wants one, or leaves it to
   you (then read the description or PRD). Record it with a checkpoint:
   `'Timeline: <slug>'`, or `'Timeline: main, because …'`.
3. Work it: `gm issue checkpoint <issue> '<done; next>'` as you go, and
   `gm issue renew <issue>` before the lease (1 hour) ends.
4. Need to find something out (where code lives, why CI failed, what an issue
   depends on)? `gm ask "<question>"` asks the Gitmatrix assistant. For human
   input, follow the current claim's `intervention` mode and guidance below.
5. Ship (Keep Claude/Codex/OMP and authoritative source edits local. Follow README.md's Agent-first development workflow. Execution selection is --execution, then GITMATRIX_AGENT_EXECUTION, then .gitmatrix/development.json, then local. When cloudflare is selected, use `node tools/agent/entry.ts` for setup/up, sync, scoped gm, checks, logs, debug and artifacts; use its `run -- <argv>` for remote vp/Cargo/browser work, never run heavy tooling on the host or silently fall back to local. Do not sync secrets, credential files or generated output back into authoritative source. Cloud mode explicitly trusts its disposable runtime with the current validated cf access token; the refresh credential stays local. AI remains opt-in. Sync the authoritative source workspace. In local mode, run `vp install`, inspect `vp run ready --dry-run`, then run `vp run ready`. In cloud mode, use `node tools/agent/entry.ts setup` for remote installation, sync source, inspect `node tools/agent/entry.ts check --dry-run`, then run `node tools/agent/entry.ts check`. These are the automatically selective required gate. Do not routinely add blanket check/test/build runs, `vp run agent test` or `--all`; use `--all` only when comprehensive verification is deliberately required. Local selection covers all unlanded committed, staged, unstaged and untracked work against the merge base with local `origin/main` and does not fetch. Use `--base` only for the actual integration branch, never to hide work. Accept automatic full fallback for broad or unknown changes, including remote source snapshots without Git metadata. Preserve required real consumer smoke checks, explicit AI verification and deployment-boundary checks in `AGENTS.md`; see `README.md#completion-gate` for coverage. Then follow the queue or timeline shipping workflow below from the authoritative local worktree and verify actual landing and required CI/deployment before completing the issue. Destroy the owned cloud environment when finished; stop is not resource cleanup.). For independent main work, explicitly submit
   `gm push --queue --issue <issue>` and checkpoint the returned queue ID,
   source commit and verification still pending. Accepted is not landed or deployed.
   Keep/renew the original lease while its acceptance remains unverified.
   Continue other independently authorized work; inspect `gm queue show <id>`
   at work boundaries, not in a busy polling loop. When deliberately waiting,
   use `gm queue wait <id> --deploy --timeout 600`.
6. Discover P0 failures with `gm issue ready --type remediation --all-teams`.
   Claim with `gm issue claim <issue>` (or normal `gm issue next` in scope),
   inspect `queueFailure`, queue details and run logs, fix and verify, then submit
   the new fix with `gm push --queue --issue <remediation>`. Use `gm queue retry <id>`
   only to retry the same source after fixing the cause, not to upload new code.
   Complete original/remediation work only with actual landing and required CI/deploy
   evidence: `gm issue complete <issue> --evidence '…'`. Do not report admission as success.
   The `--evidence` argument is optional; omitted or blank evidence creates no note.
   Record only verification actually performed. Optional evidence never waives acceptance,
   required gates or approvals.
   Abandoning active work? `gm issue release <issue>`. Keep parked request leases.
   Queue unavailable? Ordinary `gm push` remains an explicit recovery path;
   investigate uncertain admission first, never silently bypass gates or approvals.

## Creating issues

Classify the expertise needed by the actual scope and acceptance criteria, not
by the intended agent. Tag issues from the tracker's tag catalog (`gm issue
tags` lists it), reusing its spelling. In a new tracker, use lowercase `ux`
(usability and interaction design), `frontend` (client UI), `backend` (server
logic), `data` (schemas and pipelines), `architecture` (system design), `api`
(contracts and integrations), `security` (auth and threat mitigation), `testing`
(test strategy and infrastructure), `infrastructure` (CI/CD and operations), or
`documentation` (user and developer docs). Avoid synonyms and speculative tags;
ordinary verification alone does not need `testing`.

    gm issue create 'Fix keyboard navigation in search' --team ENG --type bug --tag ux --tag frontend

Substitute the actual team. Repeat `--tag` for each area, then read back the
returned issue key with `gm issue show <issue>` and check its Tags line. A new
name joins the catalog. An issue's tags describe work; an agent's tags (from the
same catalog) say what work it suits; a `tag:ux` requirement limits claims to
agents tagged ux. Tagging an issue never restricts claims. Agent profiles are
self-reported, advisory delegation hints, not proof of expertise; do not declare
an agent's tags from the issues it touches. (`--label` is the old spelling of
`--tag` and still works.)

## Human intervention

`gm issue next` and `gm issue claim` return the effective `intervention` mode
and guidance for this checkout. Follow that current policy if configuration
has changed since these instructions were generated. At setup:

Use the agent or harness's normal human-intervention behavior, including its own interactive prompts or software-factory workflow. gm does not require asynchronous requests or continuing other work. Durable `gm issue ask` requests remain available when that workflow chooses them; they appear in the accountable person's Needs you panel and park a held lease until the requests are resolved. This setting never grants permissions or bypasses required approvals.

Choose with `gm agent setup --intervention autonomous|harness`. The repository's
`intervention` default lives in `.gitmatrix/agents.yml`; existing repositories
save the flag as this checkout's override in `.gitmatrix/agent.local.yml`.

When the issue or a person asks for a timeline (a separate line of work that
lands on main later), `gm timeline start <slug>` or `gm timeline use <slug>`
binds this checkout to it: `gm push` then goes to `timeline/<slug>`, never to
main. `gm timeline use main` goes back. `--queue` is refused in a timeline;
use its push/checkpoint/land flow. Approval timelines still require a person's
approval of the exact current checkpoint; generic queue submission never replaces it.

When an agent harness drives gm here, gm acts as this checkout's agent
(`gm auth status` shows `actingAs`) and keeps lease tokens for it. If gm says
the agent's profile has no model, or you run a different model than
`gm agent show` lists, record yours: `gm agent configure --model <model-id>`. To change
any of this, edit `.gitmatrix/agents.yml` (shared) or
`.gitmatrix/agent.local.yml` (this checkout), then rerun `gm agent setup`.

<!-- gm:agents end -->
