# Gitmatrix

A Git host, package registry, CI service and distributed issue tracker on Cloudflare.
The React app and Worker live in `apps/website`; the Rust `gm` CLI lives in
`apps/cli`. Gitmatrix hosts its own source. GitHub is a one-way backup, not the
publication target.

## Downloading and installing packages

Authenticate `gm` with your Gitmatrix server before accessing private packages.
Download any generic artifact to a local file, or install a direct Unix executable:

```sh
gm pkg download tools/1.2.3/linux-x86_64/tools --owner orbit --dest ./tools
gm pkg install tools --owner orbit
gm pkg install tools --owner orbit --force
gm pkg install tools --owner orbit --version 1.2.3 --bin-dir ./disposable-bin
```

`download` defaults to the artifact's basename in the current directory; `install`
defaults to `$HOME/.local/bin/<name>`. Both refuse existing files unless `--force`
is supplied. Use `--force` to update an installed executable. Symlinks and other
nonregular destinations are refused even with `--force`. Downloads verify the
registry's SHA-256 checksum before atomically replacing a destination; a failed
download leaves the existing file unchanged.

Install defaults to `--version latest`. Download also accepts `latest` in place
of the version, for example `tools/latest/linux-x86_64/tools`. Each command resolves
`latest` once from package metadata; use an explicit version to pin an artifact.
The default install artifact is `<os>-<arch>/<name>`, such as
`linux-x86_64/tools`, `linux-aarch64/tools`, `macos-x86_64/tools`, or
`macos-aarch64/tools`. Use `--file path/to/executable` to select another artifact
inside the version. Installation writes the executable with mode `0755`; it does
not unpack archives or run installer scripts.

Add the chosen bin directory to `PATH` yourself if needed; `gm` does not edit shell
configuration. `--dry-run` resolves the version and checks remote checksum metadata
without creating local files or directories. For feature-worktree validation,
always choose an external disposable `--bin-dir`, never a shared/global install.

Gitmatrix publishes Linux x86-64 and ARM64 release binaries from `main`:
`gm pkg install gm --owner matrixorg`, then use `--force` for updates. Versions
use the `apps/cli` source tree id; unrelated pushes reuse existing artifacts.
On 64-bit Raspberry Pi OS (Bookworm or newer), the installer selects
`linux-aarch64/gm` automatically. A 32-bit OS cannot run this ARM64 binary.
See [CLI installation and bootstrap](apps/cli/README.md#downloading-artifacts-and-installing-unix-clis).

## Knowledge Atlas

The Knowledge tab shows the repository as capability territory: groups of files
that work together, found from imports and shared concepts rather than folders.
Open a region to see its areas and files, select anything to read why it is
grouped, what it uses and what uses it, and jump to its source. Labels appear
as you zoom in; a name is drawn whole or not at all. The account page's
Knowledge link opens the same view across the repositories you pick.

### AI usage in Cloudflare AI Gateway

Open Cloudflare **AI Gateway → `gitmatrix`** for production usage; normal local
development uses `gitmatrix-dev`. Application inference, including knowledge/wiki
generation, graph embeddings, routing, assistant streams/titles and avatars, goes
through the configured Gateway. Filter logs by `metadata.component`: `knowledge`,
`assistant`, `assistant-title` or `avatars`. Application calls disable raw
prompt/response payload storage while retaining model, status, tokens, cost and
latency metadata.

The Worker reads the `AI_GATEWAY` text binding. Agent environments override it
with their owned `GITMATRIX_AI_GATEWAY`; they never fall back to a shared Gateway.
Gateways require authentication, enable logging, use postpaid Workers AI billing,
and leave caching and rate limiting disabled. Existing model choices and
application retry behavior are unchanged.

Managed AI Search's `knowledge` instance is also connected to the matching Gateway.
**Exception:** Cloudflare includes built-in Workers AI embedding/reranking in
AI Search usage, not Gateway logs or analytics. Those models remain unchanged;
consult AI Search usage for that portion. Query rewriting/generation and
external-provider model calls use its connected Gateway
([Cloudflare's coverage](https://developers.cloudflare.com/ai-search/configuration/models/ai-gateway/)).
Application payload-suppression headers do not configure managed Search logging.

For a new deployment, create the Gateway before deploying the Worker, then connect
the existing Search instance (use `gitmatrix-dev` and namespace `gitmatrix` for
normal development):

```bash
cf ai-gateway gateways create --id gitmatrix --authentication true --collect-logs true --cache-ttl 0 --cache-invalidate-on-update false --rate-limiting-interval 0 --rate-limiting-limit 0 --workers-ai-billing-mode postpaid
cf ai-search update knowledge --name gitmatrix-prod --ai-gateway-id gitmatrix
```

## Release note evidence

On repository and account release-note pages, select an item's **last commit**
time to open its details sidebar. The sidebar lists every linked commit, the
linked tracker issue when available, and any landing timeline; commit links open
the exact source revision. These links stay out of the reading view until opened.

Select another item's time to switch details, or use Close or Escape to dismiss
the sidebar and return focus to the opener. On phones, details fill the screen.

## Steps: work context for every commit

In a timeline, agents commit at meaningful steps, and each step carries the
context that produced it: the person's instructions and steering, why the
work was done this way, what got in the way, and its test results (PRD
CORE-226). People and agents read it live and long after:

- **Writing:** `gm step -m '…' --context step.md` tests, commits and pushes;
  harness hooks for Claude Code, Codex and Oh My Pi record what the person said
  (`gm agent setup` installs them). Missing context warns, never blocks.
- **Reading:** the timeline page's **Live now** and **Story**, a line's
  **Why?** in the file view, and `gm steps --follow`, `gm context show`,
  `gm log --context`, `gm why`.
- **Checks:** `on: step` jobs in `.gitmatrix/ci.yml` run on every timeline push
  (`gm test` runs the local ones); a timeline's full CI and knowledge overlays
  wait for a quiet period or a checkpoint.
- **Keeping it:** the why stays with the repository; instructions and steering,
  step-run artifacts and the live feed follow the Data retention categories.

Details: `apps/cli/README.md` ("Steps: context for every commit") and
`apps/website/README.md` ("Steps: work context per commit", "Step runs").

## Data retention

Gitmatrix deletes nothing new until someone turns a retention category on,
except expired sign-in state (auth hygiene), which it always cleans up. Account administrators choose per account in **Settings → Data retention**;
site administrators set site categories (shared caches, the registry,
sign-in state, usage records) and defaults for every account in
**Settings → Site data retention**. Each category says what it never
deletes. **Clean up now** previews any categories (a dry run with counts,
bytes and estimated storage cost) before deleting, and every run, scheduled
or manual, is kept in the run history with who started it. The same from a
terminal: `gm retention show`, `gm retention set <category> --enable`,
`gm --dry-run retention run <category>…`, `gm retention run <category> --yes`,
`gm retention runs` (`--owner <slug>` or `--site`).

**Settings → Usage & costs** shows what each account stores and runs, priced
from Cloudflare's published list prices, with links to the categories that
clean each line up. Deleting a repository removes everything it owned.

Categories, defaults, the engine, the safety suite and what is verified
where: [`apps/website/README.md`](apps/website/README.md#data-retention).

## Agent-first development

Use one **source worktree and isolated environment per agent**. Never test product
mutations against the canonical development server on port 5180, and never install
a feature worktree's `gm` over the shared binary.

### Prerequisites

- Linux (including WSL2) with a running **user systemd** manager and `flock`.
- Vite+, Node 24+, the Rust toolchain, Git and curl. `vp install` selects pinned
  pnpm 12.8.1; each worktree installs its own links into the shared global store.
- A **system Node** (18+, in `/usr/bin` or `/usr/local/bin`; on Debian,
  `sudo apt-get install nodejs`). The merge queue's trusted merge program runs
  with the merge credential and only system tools, never `node_modules/.bin` or
  version-manager shims, so a local runner needs one (CORE-257). Keep vp's Node
  first on `PATH` for everything else; `vp env doctor` checks it.
- `cf` installed outside the worktree, authenticated with `cf auth login`.
  Automatic non-AI E2E needs Artifacts access. Interactive setup and explicit AI
  verification also need Vectorize, AI Search, Workers AI and AI Gateway access.
  If login exposes multiple accounts, set `CLOUDFLARE_ACCOUNT_ID` explicitly.
- Chromium's OS dependencies. Setup installs only the pinned Playwright version's
  Chromium **headless shell** (`playwright install --only-shell chromium`) and checks
  that it launches with touch and reduced-motion emulation; missing host libraries are
  a setup error, not a skipped test. See [browser cache](#browser-cache).

Cloudflare operations use **`cf`, never Wrangler**. Remote services incur charges;
see [cleanup and cost bounds](#cleanup-and-cost-bounds) before provisioning.

### Create, run and inspect

```bash
# In the source workspace; gm snapshots the current working copy.
gm worktree add ../gitmatrix-feature
cd ../gitmatrix-feature
vp install
vp run agent setup
vp run agent up
```

`setup` builds this worktree's debug `gm`, generates Worker types, provisions
uniquely named remote resources, migrates both local D1 databases and reconciles
small deterministic fixtures. It starts the app while seeding and stops it afterward
unless it was already running. `up` runs the app in the foreground; use its printed
loopback origin, not a remembered port. CI runners start on demand from the same
worktree's binary, with two runner slots.

In another terminal in that source worktree:

```bash
vp run agent status
vp run agent gm -- auth status
vp run agent gm -- repo list
vp run agent inspect db 'SELECT slug, kind FROM accounts ORDER BY slug'
vp run agent inspect registry
vp run agent seed
```

`agent gm` supplies the correct server, isolated HOME/XDG credentials, Git config
and tracker replica. Its default working directory is the environment's disposable
workspace **outside the source checkout**. To exercise Git transport:

```bash
vp run agent gm -- clone orbit/engine
# Use the clone path printed by the command; edit files there.
vp run agent gm -- -C /path/to/printed/clone commit -m 'Exercise the changed behavior'
vp run agent gm -- -C /path/to/printed/clone push
```

`agent exec -- <command> <args>` runs another tool with the same scoped client
environment, but starts in the source worktree. `inspect` accepts one read-only
SQL query. Inspect tracker state through `agent gm -- tracker ...` / `issue ...`;
tracker authorities are Durable Objects, not tables in the main D1 database.

The seed contains four tiny repositories with real Git commits: private
`orbit/engine`, public `orbit/website`, public `marco/hello-world`, and private
`sam/notes`. Priya is site admin; Marco owns Orbit; Jun can write `orbit/engine`;
Sam can only read it. Orbit's tracker includes ready, blocked, prerequisite and
completed issues. Seeding is repeatable and preserves existing work; use `reset`
for a fresh data set. No moving GitHub repositories are imported.

Browser automation must create a **fresh browser context per environment/persona**.
Cookies are host-scoped, not port-scoped: separate ports alone do not isolate
browser sessions. The dev persona UI and token/seed endpoints are disabled outside
development; harness dev endpoints additionally require an environment capability.

### Completion gate

```bash
vp run ready                 # uncached quality gates + non-AI live E2E
vp run agent test            # fresh non-AI live E2E only
vp run agent test-ai         # explicit paid knowledge/wiki/search verification
```

`ready` runs formatting/lint checks, Rust format/clippy, all website and harness
TypeScript projects, recursive unit/integration tests, recursive builds, then the
non-AI real-service end-to-end suite. Test commands always execute; Cargo may reuse
compiled outputs, not test results. Missing credentials, required provider outages
or an unavailable browser fail the command. The website's `vp test` includes
browser-mode tests in headless Chromium; UI behaviour belongs there, and E2E
keeps a few real-stack journeys (apps/website/README.md, "Testing").

The usage and retention browser journeys close each persona/viewport context after
its assertions and trace finish, before opening the next. Keep that lifetime bounded:
finished pages still consume renderer memory if left open until scenario teardown.

The E2E command creates a **separate ephemeral environment**, seeds it twice,
exercises it and destroys it on success or failure. It does not reset the interactive
environment. Its checks include:

| Boundary                       | Observable behavior                                                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and permissions | Anonymous/public access, invalid and revoked tokens, read/write roles, private-repo concealment                                                                                                                                     |
| CLI and Git transport          | Real clone/commit/push; denied push leaves remote refs unchanged                                                                                                                                                                    |
| Tracker                        | Blocked and contested claims, fencing, completion evidence and local replica synchronization                                                                                                                                        |
| Registry                       | Real upload/download, executable install/run/update in disposable directories, failed-update preservation, denied writes, grants and CI provenance                                                                                  |
| CI                             | Push-triggered DAG, dependency ordering, failed prerequisite, skipped dependent, cancellation and job-token lifetime                                                                                                                |
| Steps                          | `gm step` with a hook-captured instruction and steering, local `gm test` results, the live feed within 5 s, the step run's summary, a no-context warning, anonymous readers refused, and `gm why` on a landed line showing its step |
| Browser                        | Independent persona sessions, persisted repository/CI/tracker/package views, reloads and access boundaries; a scoped timeline round trip; an Atlas smoke down to the cited source                                                   |
| Mirror                         | Authenticated Git mirror update/tag/prune, default branch and tags only, rejected credentials and recovery against a real local HTTP target                                                                                         |

Local runners keep deadline and cancellation supervision after stdout/stderr EOF.
Silent running steps use a five-second cancellation heartbeat. The live cancellation
scenario requires the held process to disconnect without the test releasing it.

Automatic E2E provisions only Artifacts and omits Workers AI, Vectorize and AI Search
bindings. It verifies that fixture pushes/status reads do not start knowledge builds;
explicit AI rebuild/search requests return 503 in this isolated non-AI mode.
Independent mirror checks run alongside the other scenarios; both finish before
teardown, even when one fails. This gate exercises **local Linux runners**, not deployed
Cloudflare Sandbox containers or production sign-in. Changes to those deployment
boundaries require their own targeted smoke run; do not claim deployment parity.

Local evidence remains under `.gitmatrix-agent/runs/<id>/artifacts/`: completion
status, lifecycle timings, scenario observations, mirror/AI evidence, server logs,
browser screenshots and failure traces. Failures before provisioning use
`.gitmatrix-agent/artifacts/test-<mode>-<timestamp>/`. Treat local traces/logs as
private even though textual bearer credentials are redacted.

Local CI runners set `GITMATRIX_CI_ARTIFACTS_DIR` to a private job-specific directory
outside the disposable checkout and print its path in setup logs. The harness
retains only allowlisted sanitized JSON reports there, including failures; it strips
scenario observations and never copies credentials, raw logs or browser storage.
`timings.json` separates preparation, provisioning, migrations, startup, seeding,
scenarios, shutdown and cleanup. Provider reports separate knowledge generation
from search-index visibility. A failed run is a failed gate; fix the cause rather
than skipping the scenario.

Before calling work complete: run `ready`, exercise the specific changed consumer
path, inspect the evidence, update affected contracts/docs, and stop or destroy
unneeded environments. Publish source changes with ordinary `gm commit` / `gm push`
**outside** the scoped `agent gm` wrapper, then check `gm runs wait`.
`.gitmatrix/ci.yml` starts check, test and build independently on production's
Cloudflare Sandbox containers; all must pass. Non-AI E2E is too expensive per push,
so it runs only on local runners (`if: runner == "local"`): `ready` is where it gates
your work. The jobs exchange no artifacts, so no dependency-stage barrier is needed.
The canonical development server runs one CI job at a time by default;
`GITMATRIX_CI_RUNNERS` overrides this when the server starts. Isolated agent
environments keep two slots for their fixture jobs. No running server needs to
be restarted just to adopt these defaults; they apply at its next normal start.
Both `ready` and source CI run recursive workspace test/build tasks one at a time.
Every Vitest pool is capped at two workers. `.cargo/config.toml` defaults Cargo to
four compiler workers for local commands, and source CI explicitly uses the same
limit. Manual recursive commands can use `vp run -r --concurrency-limit 1 build`
or `vp run -r --concurrency-limit 1 test` to keep the same memory budget.
Locally, E2E runs on the trusted Linux host with Cloudflare login and user-systemd
prerequisites. Local runners retain repo/job-scoped Cargo output caches outside
checkouts; concurrent jobs lease separate slots. Tests still run every time.

### AI capability verification

Real AI checks are **not automatic CI requirements**. For changes to knowledge
builds, graph extraction, generated wiki, embeddings, AI Search or AI-written
release notes, follow the
[AI verification skill](.agents/skills/gitmatrix-ai-verification/SKILL.md) and run
`vp run agent test-ai`. It provisions its own paid resources and verifies the exact
pushed commit, named graph relationships, generated wiki provenance/content, and
matching Vectorize entities plus AI Search source passages. It also verifies
daily release-note rollover by UTC committer date, retained commit provenance,
optional named tags and non-duplicated daily tracker feeds. It exercises real avatar
generation and checks Gateway attempts within its ten-call budget, with successes matching the
returned images (the API permits partial generation). It also checks successful
Gateway records for knowledge, embeddings and assistant streaming/titles, including
empty payloads and usage metadata. `ai-e2e.json` retains sanitized Gateway evidence. Assertions check source
facts, not exact generated wording. Missing providers or an expired visibility
deadline fail honestly. Normal interactive `agent setup` remains AI-enabled.

Build completion acknowledges uploads, not search visibility. The AI gate observes
the fixture item’s own AI Search indexing status before making at most six
retrieval calls. A ten-minute overall deadline bounds indexing and retrieval
together; the last probe reserves 30 seconds for its request near that deadline
so Vectorize gets the remaining visibility window too. The exact entity and
source passage must appear in the same response. `indexVisibilitySummary` in
`ai-e2e.json` records the item key/ID/status, observations, elapsed wait and missing
invariants, including when a completed item never becomes retrievable.
`ai-e2e.json` records each attempt's elapsed time and separate entity/passage
visibility so a delayed index is distinguishable from a failed build.

### Fast edit loop

Keep `vp run agent up` running and reuse its environment while editing. Use targeted
package tests and `vp check` for feedback; run `vp run ready` at completion, not after
every edit. CI repeats the non-AI gate; run the explicit AI command when the changed
capability requires it, not on every push.

Observed on the local Linux/WSL workstation with warm caches; these are measurements,
not cold-install or provider-latency guarantees:

| Operation                              | Observed duration |
| -------------------------------------- | ----------------- |
| Format/lint/type-aware check           | About 3–4 seconds |
| Website unit tests                     | About 3–4 seconds |
| Setup with an existing environment     | 17 seconds        |
| New environment with CLI already built | 44 seconds        |
| Fresh worktree install/build/setup     | 82–98 seconds     |
| Full non-AI completion gate            | 157 seconds       |
| Non-AI E2E including lifecycle         | 107 seconds       |

These setup measurements include AI-enabled interactive resources. Use the current
run's `timings.json` for automatic-gate measurements; historical totals that included
live AI generation/search are not comparable to the non-AI gate.
The measured non-AI E2E spent 41 seconds exercising scenarios, with mirror work
overlapped. These are local verification measurements, not a new trunk CI run.

### Cleanup and cost bounds

```bash
vp run agent stop                # stop app/runners; keep data until expiry
vp run agent reset               # destroy owned data/resources, then fresh setup
vp run agent destroy             # delete this worktree's interactive environment
vp run agent cleanup --expired   # sweep expired environments across worktrees
vp run agent maintenance status
```

- Every environment has a **24-hour maximum lifetime**, with no silent renewal.
  At most **four live environments per OS user** may be provisioned, including E2E
  runs. Expired environments are swept before new provisioning.
- Setup requires and installs the hourly `gitmatrix-agent-cleanup.timer` user
  service, with persistent catch-up and up to five minutes of jitter. Its code and
  resource journal live outside worktrees in `~/.local/state/gitmatrix-agent`, so
  deleting a worktree does not lose the cleanup inventory.
- Remote resource names must match an ownership-checked `gma-...` journal entry.
  Cleanup deletes AI Search instances/namespace, the AI Gateway, Vectorize index,
  and Artifacts repositories/namespace independently. Failed deletions stay journaled and are
  retried; unrelated resources are never discovered and deleted by prefix alone.
  AI environments created before Gateway ownership was introduced must be destroyed
  and recreated with `setup`; their legacy journals remain valid for cleanup.
- Foreground apps stop at expiry. Process-group shutdown is PID-start-time fenced;
  kernel-backed locks release after crashes. A removed or redirected worktree
  cannot prevent remote resource deletion. Local credentials, state, disposable
  clones and owned temporary directories are deleted; diagnostic artifacts remain
  for inspection. CI checkouts and scoped CLI temporary files stay in the environment's
  external disposable workspace, never in the source checkout or shared `/tmp`.
- `stop` is **not** remote cleanup. Destroy environments when finished. The timer
  cannot run while the host/user manager is unavailable or credentials are revoked;
  check `maintenance status` and `journalctl --user -u gitmatrix-agent-cleanup.service`
  after failures. Keep a development-account billing alert: these limits bound
  resource accumulation, **not a hard currency budget or provider-side TTL**.
- `maintenance uninstall` refuses while owned live environments remain. Do not
  remove the central journal to silence cleanup failures.

`.worktreeinclude` copies no credentials or mutable state by default; `gm worktree
add` always copies the checkout's agent (`.gitmatrix/agent.local.yml`, a name and
profile, no token) so a worktree's work keeps its agent. Never copy
`.gitmatrix-agent`, `.wrangler`, HOME/XDG state, binaries or another worktree's
`node_modules`. Checkouts share immutable package contents, not mutable application
state; the shared store and local runners assume mutually trusted agents, not
hostile-code sandboxing.

### Browser cache

Every browser check launches `chromium.launch({ headless: true })` without a
`channel`, which Playwright serves from `chromium_headless_shell-<revision>`.
Setup therefore skips full Chromium (Chrome for Testing): per revision about
266 MB on disk instead of 658 MB, and a 117 MiB download instead of 303 MiB.
Browser tests in other tools share this install only if they also launch
headless with no channel. Vitest browser mode defaults `browser.headless` to
`process.env.CI`, so set `headless: true` explicitly. A headed run, a
`channel: "chromium"` launch or a debugger needs full Chromium; install it
yourself with `vp exec playwright install chromium`.

Browsers live in `~/.cache/ms-playwright` (or `PLAYWRIGHT_BROWSERS_PATH`),
shared by every worktree and every other Playwright project on the machine.
Playwright's own cleanup during install keeps any revision that a still-present
package registered, and pnpm's global store keeps old packages present, so old
revisions accumulate. Prune them explicitly:

```bash
vp run agent prune-browsers --dry-run   # report what would go, with sizes and reasons
vp run agent prune-browsers             # delete it
vp run agent prune-browsers --dry-run --include-other-installs   # also other projects' browsers
```

- **Kept:** every revision that any `playwright-core` version in any worktree's
  lockfiles (from `git worktree list`) names in its installed `browsers.json`.
  That includes full Chromium, which other agent tools on the host launch directly
  from this cache. The command refuses to run when a linked version isn't
  installed, rather than guess which revisions it needs.
- **Also kept:** any revision that a running process executes, maps or uses as its
  working directory (from `/proc`). Each revision is renamed aside and checked
  again before it is deleted.
- **Also kept by default:** every revision another live Playwright install
  registered in `.links` (`npx playwright`, `pnpm dlx`, other repositories), as
  long as its package still exists. The report lists them under
  `heldByOtherInstalls` with their sizes and owners: what `--include-other-installs`
  would also delete. Those projects download their browsers again on their next
  `playwright install`, so pass the flag only when you know they are unused.
- **Deleted:** every other revision, such as one whose registering package is gone.
  An old Playwright version that pnpm's global store still holds counts as a live
  install, so its revisions stay until the store is pruned or you pass the flag.
- Only Playwright revision directories are candidates; `.links`, profiles and
  unknown entries are never touched.
- The command holds Playwright's install lock (`__dirlock`) and refuses if an
  install holds it.
- Pruning is manual, not part of the hourly cleanup.

## Toolchain notes

The pinned Miniflare patch in `patches/` prevents a disposed registry watcher from
reopening after a pending file-stat failure. Without it, `cf d1 ... --local` can
print a result and never exit. Keep the patch until an upstream version contains
the fix; verify both successful and failing local commands terminate when upgrading.
The TypeScript wrapper in `tools/agent/typecheck.ts` spawns the native compiler
because its exec-replacement launcher fails with `EBUSY` on this WSL host.
Use `vp env doctor` when runtime/package-manager setup is suspect.

## Distributed issue tracker

Gitmatrix's tracker is account-owned and independent of Git history: teams own
issues, workspaces organize them, and repository subscriptions do not grant access.
Use `/tracker` for the human workbench or `gm tracker use OWNER` and `gm issue ready`
for agent work. See the [tracker architecture and API](apps/website/README.md#distributed-issue-tracker)
and [CLI workflows](apps/cli/README.md#distributed-issue-tracker).
