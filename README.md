# Gitmatrix

A Git host, package registry, CI service and distributed issue tracker on Cloudflare.
The React app and Worker live in `apps/website`; the Rust `gm` CLI lives in
`apps/cli`. Gitmatrix hosts its own source. GitHub is a one-way backup, not the
publication target.

## Agent-first development

Use one **source worktree and isolated environment per agent**. Never test product
mutations against the canonical development server on port 5180, and never install
a feature worktree's `gm` over the shared binary.

### Prerequisites

- Linux (including WSL2) with a running **user systemd** manager and `flock`.
- Vite+, Node 24+, the Rust toolchain, Git and curl. `vp install` selects pinned
  pnpm 12.8.1; each worktree installs its own links into the shared global store.
- `cf` installed outside the worktree, authenticated with `cf auth login`.
  The development account must permit Artifacts, Vectorize, AI Search and Workers AI.
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
vp run ready                 # complete, uncached gate
vp run agent test            # fresh live E2E only
```

`ready` runs formatting/lint checks, Rust format/clippy, all website and harness
TypeScript projects, recursive unit/integration tests, recursive builds, then the
real-service end-to-end suite. It never treats a cached task, missing credentials,
provider outage or unavailable browser as a passing live test.

The E2E command creates a **separate ephemeral environment**, seeds it twice,
exercises it and destroys it on success or failure. It does not reset the interactive
environment. Its checks include:

| Boundary                       | Observable behavior                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication and permissions | Anonymous/public access, invalid and revoked tokens, read/write roles, private-repo concealment                                            |
| CLI and Git transport          | Real clone/commit/push; denied push leaves remote refs unchanged                                                                           |
| Tracker                        | Blocked and contested claims, fencing, completion evidence and local replica synchronization                                               |
| Registry                       | Real upload/download, denied writes, repository grants and CI publication provenance                                                       |
| CI                             | Push-triggered DAG, dependency ordering, failed prerequisite, skipped dependent, cancellation and job-token lifetime                       |
| Browser                        | Independent persona sessions, persisted repository/CI/tracker/package views, reloads and access boundaries                                 |
| Providers                      | Authenticated Git mirror update/tag/prune and auth failure; knowledge build, graph, Vectorize entity search and AI Search source retrieval |

Local runners keep deadline and cancellation supervision after stdout/stderr EOF.
Silent running steps use a five-second cancellation heartbeat. The live cancellation
scenario requires the held process to disconnect without the test releasing it.

Provider assertions check source identity and state, not exact generated prose.
Fixtures and search attempts are bounded. The mirror target is a real local Git
HTTP server, not GitHub. This gate exercises **local Linux runners**, not deployed
Cloudflare Sandbox containers or production sign-in. Changes to those deployment
boundaries require their own targeted smoke run; do not claim deployment parity.

Evidence is retained under `.gitmatrix-agent/runs/<id>/artifacts/`: completion
status, scenario observations, failed CI details/logs, provider evidence, server
logs, browser screenshots and failure traces. Treat traces/logs as private even
though textual bearer credentials are redacted. A failed run is a failed gate;
fix the cause and rerun it rather than skipping the scenario.

Before calling work complete: run `ready`, exercise the specific changed consumer
path, inspect the evidence, update affected contracts/docs, and stop or destroy
unneeded environments. Publish source changes with ordinary `gm commit` / `gm push`
**outside** the scoped `agent gm` wrapper, then check `gm runs wait`.
`.gitmatrix/ci.yml` enforces check → test → build → live E2E on the trusted local
Linux CI host, which needs the same Cloudflare login and user-systemd prerequisites.

### Fast edit loop

Keep `vp run agent up` running and reuse its environment while editing. Use targeted
package tests and `vp check` for feedback; run `vp run ready` at completion, not after
every edit. CI repeats the full gate, including the expensive live provider checks.

Observed on the local Linux/WSL workstation with warm caches; these are measurements,
not cold-install or provider-latency guarantees:

| Operation                              | Observed duration  |
| -------------------------------------- | ------------------ |
| Format/lint/type-aware check           | About 3–4 seconds  |
| Website unit tests                     | About 3–4 seconds  |
| Setup with an existing environment     | 17 seconds         |
| New environment with CLI already built | 44 seconds         |
| Fresh worktree install/build/setup     | 82–98 seconds      |
| Full uncached completion gate          | About 4–5½ minutes |

Live provider verification accounts for roughly 2–3¾ minutes of the full gate;
browser checks take about 20 seconds. The four runner-supervision regressions add
no provider provisioning and complete with the focused CI unit checks in about
0.3 seconds.

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

`.worktreeinclude` copies no credentials or mutable state by default. Never copy
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
