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

## Knowledge map labels

The Knowledge view reveals component, folder, file and symbol labels as you zoom
in. Long names wrap or end in an ellipsis instead of leaving readable tiles blank;
hover a tile or select it to see the complete name in the tooltip or inspector.
Hover names wrap within the map, including near its edges. Tiny tiles remain
unlabeled until there is enough room to read them.

## Agent-first development

Use one **source worktree and isolated environment per agent**. Never test product
mutations against the canonical development server on port 5180, and never install
a feature worktree's `gm` over the shared binary.

### Prerequisites

- Linux (including WSL2) with a running **user systemd** manager and `flock`.
- Vite+, Node 24+, the Rust toolchain, Git and curl. `vp install` selects pinned
  pnpm 12.8.1; each worktree installs its own links into the shared global store.
- `cf` installed outside the worktree, authenticated with `cf auth login`.
  Automatic non-AI E2E needs Artifacts access. Interactive setup and explicit AI
  verification also need Vectorize, AI Search and Workers AI.
  If login exposes multiple accounts, set `CLOUDFLARE_ACCOUNT_ID` explicitly.
- Chromium's OS dependencies. Setup installs the pinned Playwright browser and
  checks that it launches; missing host libraries are a setup error, not a skipped test.

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
or an unavailable browser fail the command.

The E2E command creates a **separate ephemeral environment**, seeds it twice,
exercises it and destroys it on success or failure. It does not reset the interactive
environment. Its checks include:

| Boundary                       | Observable behavior                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and permissions | Anonymous/public access, invalid and revoked tokens, read/write roles, private-repo concealment                                                    |
| CLI and Git transport          | Real clone/commit/push; denied push leaves remote refs unchanged                                                                                   |
| Tracker                        | Blocked and contested claims, fencing, completion evidence and local replica synchronization                                                       |
| Registry                       | Real upload/download, executable install/run/update in disposable directories, failed-update preservation, denied writes, grants and CI provenance |
| CI                             | Push-triggered DAG, dependency ordering, failed prerequisite, skipped dependent, cancellation and job-token lifetime                               |
| Browser                        | Independent persona sessions, persisted repository/CI/tracker/package views, reloads and access boundaries                                         |
| Mirror                         | Authenticated Git mirror update/tag/prune, rejected credentials and recovery against a real local HTTP target                                      |

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
optional named tags and non-duplicated daily tracker feeds. Assertions check
source facts, not exact generated wording. Missing providers or an expired
visibility deadline fail honestly. Normal interactive `agent setup` remains AI-enabled.

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
  Cleanup deletes AI Search instances/namespace, Vectorize index, and Artifacts
  repositories/namespace independently. Failed deletions stay journaled and are
  retried; unrelated resources are never discovered and deleted by prefix alone.
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
