# Timelines

A Git host, package registry, CI service and distributed issue tracker on Cloudflare.
The React app and Worker live in `apps/website`; the Rust `gm` CLI lives in
`apps/cli`. Timelines hosts its own source. GitHub is a one-way backup, not the
publication target.

## Timeline work and canonical history

Timelines keep full progress history in one owned work repository per timeline
and canonical repository (`work_<id>`, physical `refs/heads/work`). Landing
applies the approved tree change onto current main as a gated single-parent
commit, or records a no-op; WIP commits are not uploaded to canonical.
Source-qualified provenance keeps steps, previews and historical reads linked
to that work. Git uses `/<owner>/<repo>@<slug>.git`. Ended work is read-only
and expires by default after 30 days landed or 90 days abandoned, configurable
in Data retention independently of Tracker details, published wiki and previews.
See the [current timeline contract](apps/website/README.md#timelines) and
[CLI binding, sync and legacy migration](apps/cli/README.md#timelines).

## Downloading and installing packages

Authenticate `gm` with your Timelines server before accessing private packages.
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

Timelines publishes Linux x86-64 and ARM64 release binaries from `main`:
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

Open Cloudflare **AI Gateway → `gitmatrix`** for production usage; local
development uses `gitmatrix-dev` when its AI is on. AI is **opt-in** in
development: `vp dev` binds no Workers AI, AI Gateway, Vectorize or AI Search,
and says so when it starts, unless started with `GITMATRIX_DEV_AI=enabled vp dev`
(Knowledge builds of real repositories cost money; building this repository
once cost about $44). Application inference, including knowledge/wiki
generation, graph embeddings, routing, assistant streams/titles and avatars, goes
through the configured Gateway. Filter logs by `metadata.component`: `knowledge`,
`assistant`, `assistant-title`, `assistant-status`, `avatars`, `release-notes` or
`merge-queue` (and `metadata.account`/`metadata.feature`, as in `ai_usage`).
Logs always keep model, status, tokens, cost and latency. Whether they also keep
request and response bodies is a setting per component, "Keep AI request and
response bodies in gateway logs" (CORE-290): a site default (site admins,
**Settings → Site AI settings** or `gm settings ai set --site --log-bodies on`),
which an account's administrators can override for their own account's calls
(**AI settings** or `gm settings ai set --log-bodies assistant=off`). Without a
site choice deployed servers keep no bodies (`AI_LOG_BODIES=off`) and the dev
server and agent environments keep them (`on`). Where the effective setting is
off, a call sends `cf-aig-collect-log-payload: false`. Kept bodies, including
repository code and assistant conversations, are readable by the Cloudflare
account's dashboard users and deleted oldest-first with the gateway's logs
(`cf ai-gateway logs get-request|get-response <id> --gateway-id gitmatrix`).
Settings are read once a minute per isolate, not per call.

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
The body logging setting does not configure managed Search logging.

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

Most retention categories are opt-in. **Timeline work Git repositories** is
enabled by default: 30 days after landing, 90 after abandonment. Expired
sign-in state (auth hygiene) is always cleaned up. Account administrators can
change both durations or disable that policy in **Settings → Data retention**.
Site administrators set site categories (shared caches, the registry, sign-in
state, usage records) and defaults for every account in
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

### Choose where tools execute

Claude Code, Codex and OMP stay on your computer, editing the local source
worktree. **Local execution remains the default.** The optional `cloudflare`
backend moves dependency installation, app processes, builds, checks, scoped
`gm` and browser tests into a disposable Cloudflare container; it does not move
the agent or make the remote filesystem authoritative.

Selection, highest priority first:

1. `--execution local` or `--execution cloudflare` on the agent entry command.
2. `GITMATRIX_AGENT_EXECUTION=local|cloudflare`.
3. `.gitmatrix/development.json`, for example `{"execution":"cloudflare"}`.
4. `local`.

An existing remote environment pins the worktree to its backend. Destroy it
before switching; an explicit conflicting choice is an error. Cloud failures
never silently run expensive commands locally. The dependency-light entry
`node tools/agent/entry.ts` selects the backend before loading the local harness;
cloud users do not need a local `vp install`, Rust toolchain or Chromium.
`vp run agent` and `vp run ready` use the same selector when Vite+ is installed.

The local instructions below apply when local execution is selected. To choose
it deliberately, use `node tools/agent/entry.ts --execution local setup` (with
the local prerequisites installed). For cloud mode use the
[Cloudflare workflow](#optional-cloudflare-workflow), including remote command
paths rather than host-side `vp`, Cargo or browser automation.

### Local prerequisites

- Linux (including WSL2) with a running **user systemd** manager and `flock`.
- Vite+, Node 24+, the Rust toolchain, Git and curl. `vp install` selects pinned
  pnpm 12.8.1; each worktree installs its own links into the shared global store.
- A **system Node** (18+, in `/usr/bin` or `/usr/local/bin`; on Debian,
  `sudo apt-get install nodejs`). The merge queue's trusted merge program runs
  with the merge credential and only system tools, never `node_modules/.bin` or
  version-manager shims, so a local runner needs one (CORE-257). Keep vp's Node
  first on `PATH` for everything else; `vp env doctor` checks it.
- `cf` installed outside the worktree, authenticated with `cf auth login`.
  Setup and automatic non-AI E2E need Artifacts access. `setup --ai` and explicit
  AI verification also need Vectorize, AI Search, Workers AI and AI Gateway access.
  If login exposes multiple accounts, set `CLOUDFLARE_ACCOUNT_ID` explicitly.
- Chromium's OS dependencies. Setup installs only the pinned Playwright version's
  Chromium **headless shell** (`playwright install --only-shell chromium`) and checks
  that it launches with touch and reduced-motion emulation; missing host libraries are
  a setup error, not a skipped test. See [browser cache](#browser-cache).

Cloudflare operations use **`cf`, never Wrangler**. Remote services incur charges;
see [cleanup and cost bounds](#cleanup-and-cost-bounds) before provisioning.

### Environment limits and quota authority

Environment admission has two independent caps (CORE-300): **4 installation-wide**
by default, shared across users, machines and both execution backends, and **4
local application environments per OS user on one machine** by default, including
ephemeral E2E runs. Each `gmr-` control environment and each `gma-` application or
E2E environment consumes an installation slot: a normal Cloudflare setup uses
**two slots**, one for its container controller and one for its hosted app.
The local cap protects host capacity; raising it cannot override the installation
cap. Admission reserves capacity atomically before provider provisioning.

Before setup, explicitly choose the **same shared Timelines authority on every
host managing the installation**, and authenticate `gm` to it:

```bash
gm settings environments show --local
gm settings environments set --local --max 4 --authority https://YOUR-GITMATRIX
GM_SERVER=https://YOUR-GITMATRIX gm settings environments show --site
# Installation changes require a signed-in human site administrator:
GM_SERVER=https://YOUR-GITMATRIX gm settings environments set --site --max 4
```

`--local` reads/writes `~/.local/state/gitmatrix-agent/limits.json`; `set` accepts
`--max`, `--authority`, or both. The authority must be an HTTP(S) origin without
credentials, a path, query or fragment. `--site` addresses the current `gm` server,
not an authority inferred from local settings; use `GM_SERVER` as above to target
the pinned authority. Site settings require site-admin access, and changing them
requires a **person**, not an agent credential. The local setting grants no site
administration rights.

Limits are integers from 0 through 2147483647. Zero pauses **new allocations**;
lowering a cap below current usage does not evict existing environments.
New local application allocations must satisfy both caps; Cloudflare control
environments use the shared installation cap, not a separate hard-coded limit.
Existing reservations can still be acknowledged and cleaned up.

Each environment journal pins its authority before requesting a reservation.
Changing the local authority does not migrate existing reservations or redirect
their cleanup. Product-server selection, scoped test credentials and local fixture
credentials never select the quota authority implicitly. Missing configuration,
an unavailable quota API/schema (including a server without the API), rejected
authentication, or an unacknowledged request **fails closed**: there is no offline,
404 or local-count fallback. Deploy the quota API/schema on the chosen authority,
restore the owning identity's access, and retry cleanup/setup; do not switch to
another authority or remove journals to bypass a full or unreachable quota.

A full installation reports `Installation environment limit reached (used/maximum)`
in both local `gm` and hosted HTTP admission. Destroy unused environments on their
owning machines, or ask a site administrator to adjust
`gm settings environments set --site --max`. Expired reservations still require
cleanup; waiting for their TTL is not enough. Reservation owner/configuration
conflicts and authorization failures are reported separately from capacity.
Only recognized structured diagnostics supply bounded usage numbers; arbitrary
subprocess output and HTTP error bodies are never echoed.

On rollout, local setup adopts non-retired legacy application journals from this
user's local inventory before admitting another environment. Adoption itself needs
capacity and access to the authority. Legacy Cloudflare environments or hosted
children **without quota metadata must instead be destroyed on their owning host
and recreated**; setup refuses to guess or re-admit cached child ownership.
Drain or adopt old environments on **every owning host** before treating
installation usage as complete: no machine can discover another offline
machine's legacy inventory.

Failed provisioning, interrupted cleanup and expired reservations conservatively
retain installation capacity until cleanup succeeds and the authority acknowledges
release. A release acknowledgement reports whether it `removed` a row; when it
removed nothing, the client confirms the row is no longer listed before recording
the release. A journal's reservation only moves forward (pending, reserved,
released): no stale copy, ownership record or later command re-reserves a released
slot. Each reservation records the reserving machine's host id (hosted children
record none), which `maintenance reservations` uses to find reservations whose
journals were deleted (see [cleanup and cost bounds](#cleanup-and-cost-bounds)). A stopped application whose only remaining resource is an Artifacts
namespace that refuses deletion while listing no repositories is retired as
**orphaned**: it releases its development slot but retains its ownership journal
and cleanup retries. Other cleanup failures still hold capacity. An offline host
or elapsed TTL alone never frees a reservation. See
[cleanup and cost bounds](#cleanup-and-cost-bounds).

### Local create, run and inspect

```bash
# In the source workspace; the new worktree is a sibling of @, on its parent
# (uncommitted edits are not carried; pass -r @ to carry them).
gm worktree add ../gitmatrix-feature
cd ../gitmatrix-feature
vp install
vp run agent setup
vp run agent up
```

`setup` builds this worktree's debug `gm`, generates Worker types, provisions
uniquely named remote resources, migrates both local D1 databases and reconciles
small deterministic fixtures.

**AI is off unless you ask for it.** Plain `setup` provisions only Artifacts:
no Workers AI, AI Gateway, Vectorize or AI Search, so seeding and your pushes
start no paid Knowledge builds, and the UI shows its honest AI-off states.
`vp run agent setup --ai` adds the AI resources; use it only for changes to
knowledge, wiki, embeddings, AI Search, the assistant, release-note generation,
avatars or Atlas descriptions that you must see working with real models (most
changes, AI-adjacent UI included, don't). An existing environment keeps what it
was created with: `destroy`, then `setup --ai` (or `reset --ai`). `status` and
setup's output show each environment's `ai`. It starts the app while seeding and stops it afterward
unless it was already running. `up` runs the app in the foreground; use its printed
loopback origin, not a remembered port. CI runners start on demand from the same
worktree's binary, with two runner slots.

For the CI Sandbox execution boundary, stop the local supervisor and run
`vp run agent up --sandbox`. Docker must be available; jobs then run in actual
Sandbox containers with the same scoped origin, credentials and disposable
workspace. The default `up`, `ready` and `test` still use local Linux runners.

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

### Optional Cloudflare workflow

Use a separate local worktree per agent, just as in local mode. The Linux/WSL2
host needs Node 24+, Git, a running user-systemd manager and an authenticated
**`cf` CLI**. Install Node and `cf` outside the checkout so cleanup survives
worktree removal. No Docker, local image build, Cargo or browser dependencies
are needed on the host. Your Cloudflare account must support Workers,
Durable Objects and Containers and permit the existing CI image to be used.
The harness deploys a small per-worktree control Worker using a digest-pinned
prebuilt CI image. Missing account permissions or image access are errors,
not reasons to install and run the heavy toolchain locally.

Use your existing `cf auth login` session. If it exposes multiple accounts,
select `CLOUDFLARE_ACCOUNT_ID`. There is no separate development API token to
maintain by default. **Choosing cloud mode authorizes remote execution with
your current validated `cf` access token**: trusted code and dependencies in
that disposable container can use its Cloudflare permissions until it expires.
Use a development account and run only code you trust. The client validates
auth for remote commands and transfers the access token and necessary allowlisted
runtime values over the authenticated control channel. The channel also carries
the pinned quota authority and an access token selected specifically for that
authority through `gm`; inherited `GM_TOKEN` and `GITMATRIX_TOKEN` values are not
forwarded as quota credentials. Cloudflare mode requires an HTTPS quota authority
reachable from the hosted container, not a loopback development server.
The OAuth refresh credential, credential file and broad host environment stay
local; never copy them into the container or source tree. Connected clients renew
credentials locally and publish the current access tokens. Repair revoked or
invalid credentials locally rather than embedding a secret in source.

The hosted runtime redacts known credential-channel values **before persisting
command logs**, including values split across output chunks. Private redaction
history retains rotated values across controller restarts within that ephemeral
container, so a fresh log reader does not need old credentials to redact them.
This is not a sanitizer for arbitrary application data; treat logs and artifacts
as private.

#### Setup, edit, run and reconnect

From the local source worktree, choose cloud mode for the terminal session:

```bash
export GITMATRIX_AGENT_EXECUTION=cloudflare
node tools/agent/entry.ts setup
node tools/agent/entry.ts up
```

`setup` deploys the environment, synchronizes source, installs dependencies
remotely and runs the existing real harness setup there (build, bindings,
migrations and seed). Add `--ai` only when that capability is required.
`up` starts the remote app and prints its authenticated preview launch URL.
Keep it connected while editing locally for incremental source updates and
app logs. Open the printed URL, not a guessed workers.dev path or local port.
Cloud mode does not accept `up --sandbox`: its tools already execute remotely.
CI runners and their authenticated dispatcher use the app's loopback origin
inside the Container, not the browser-preview URL.

In another local terminal, select the same backend and worktree:

```bash
export GITMATRIX_AGENT_EXECUTION=cloudflare
node tools/agent/entry.ts status
node tools/agent/entry.ts sync
node tools/agent/entry.ts run -- vp check
node tools/agent/entry.ts run -- vp run -r --concurrency-limit 1 build
node tools/agent/entry.ts check
node tools/agent/entry.ts test
node tools/agent/entry.ts gm -- auth status
node tools/agent/entry.ts inspect db 'SELECT slug, kind FROM accounts ORDER BY slug'
```

`run -- <argv>` executes directly in the synchronized remote workspace,
without requiring the app to be running; it is the path for targeted package
tests, Cargo builds and browser tooling. `exec -- <argv>` uses the harness's
scoped client environment. `gm -- ...` uses its disposable remote client
workspace and scoped credentials, never the source worktree or shared `gm`.
Use local `gm` only for authoritative source work such as commits and pushes.
Do not run bare local `vp check`, `cargo`, browser tests or dependency installs
to work around a failed remote command.

Hosted commands set `GITMATRIX_CONTAINER_IMAGES=skip`, matching the existing
non-deploy CI build gate. They compile and package the real application without
invoking nested Docker or building/publishing the CI container image. Publish
from the authoritative source checkout through the normal `gm` workflow, not
from downloaded development build output.

`check` (also `vp run ready` when installed locally and cloud mode is selected)
uses `--all` coverage because local Git history is not uploaded. Explicit paid
`test-ai` likewise uses all stages unless stages are supplied explicitly;
it is never implied by selecting cloud mode. Inspect the actual command
outcomes and evidence rather than treating successful synchronization or
process creation as a passing check.

After losing the terminal connection, reconnect from the same worktree:

```bash
node tools/agent/entry.ts status
node tools/agent/entry.ts logs
node tools/agent/entry.ts logs <process-id>
node tools/agent/entry.ts up
```

Use the process IDs reported by the client/status; reconnect to logs rather
than launching a second copy of a long build. Exit status is recorded remotely,
not inferred from a disconnected client. Foreground heavy work is serialized;
app/debug processes have separate lifetimes. Foreground log followers and the
`up` watcher revalidate local `cf` auth and publish refreshed access tokens under
the same worktree lock as source updates and command launches. Credential
publication is a workspace mutation too: without this serialization it can
collide with a source update and fail with HTTP 409. Mutation conflicts and
authentication failures remain errors, not retries or local fallbacks.
The watcher can restart the app after token rotation or reconnect, briefly
interrupting preview/inspector connections. Source watching pauses during a
foreground build/check so that it uses a stable snapshot; subsequent local
edits sync afterward.

Within one container lifetime, process identities come from stable log entries,
not atomically replaced status filenames. Named status/log/stop operations read
the exact record, so status refresh cannot hide a running command from source
or concurrency guards. Stop still waits for owned descendants to exit.

Cloudflare HTML 404 routing-propagation responses receive bounded retries
(at most six attempts within 30 seconds and the environment's expiry).
Source uploads replay a bounded stream from the same validated local file,
without buffering a whole file. Application errors and authentication failures
remain errors; reconnecting to logs never reruns the remote command.

For interactive debugging, keep the app up and run:

```bash
node tools/agent/entry.ts debug
```

Use the printed loopback inspector endpoint in your local debugger. The client
proxies authenticated inspector traffic; do not publish the inspector or give
the browser control credentials. Map remote `/workspace/repo` to this local
worktree for source breakpoints. Keep the proxy terminal open while attached.
Browser automation and browser test execution still belong in the remote
container; a local browser/debugger is only the interactive client.

Retrieve a specific reported artifact into an explicit external destination
before teardown, for example:

```bash
node tools/agent/entry.ts artifacts apps/cli/target/debug/gm /tmp/gitmatrix-feature-gm
node tools/agent/entry.ts stop
# To resume after stopping, repeat setup, then up.
node tools/agent/entry.ts destroy
node tools/agent/entry.ts cleanup --expired
```

Use a fresh destination outside the source worktree, never a shared/global
binary location. For gate logs/screenshots, use a relative path under
`.gitmatrix-agent/artifacts` or `.gitmatrix-agent/runs/<run-id>/artifacts`.
Failed E2E runs retain their artifacts and bounded, redacted fixture Git
diagnostics; inspect them before rerunning. Treat retrieved logs and browser
traces as private.
Destroy the cloud environment before selecting `--execution local`.

#### Source authority and synchronization

Edit, review, commit and publish from the **local worktree**. No commit or push
is needed to exercise an edit remotely. Source synchronization includes
tracked and nonignored untracked files, uncommitted changes, binary content,
executable modes, additions, deletions and renames. Content hashes determine
changes, not modification times. Heavy commands synchronize before execution;
the connected `up` client also watches the local source.
Framework route filenames such as Astro's `[...slug].astro` are preserved;
filename query parameters are separate from control-route validation.

Synchronization deliberately excludes Git internals, dependency trees, build
output, `.gitmatrix-agent`, `.cloudflare`, `.env*`, `.dev.vars*`, key/credential
files, `.gitmatrix/agent.local.yml`, sockets and symlinks. Do not rely on an
ignored local file appearing remotely. Safe tracked repository configuration
such as `.gitmatrix/ci.yml` and `.gitmatrix/agents.yml` is source, not secret
runtime state. Files must fit the synchronization size limits (64 MiB per
file). An interrupted sync must complete before commands can use the new
snapshot.

The remote checkout has its own tooling Git repository, not your `.git`.
Readiness therefore runs conservatively with full coverage rather than
pretending the remote checkout knows your local merge base. Remote-generated
types, caches, dependencies and logs remain remote. There is no reverse
source sync: request an artifact explicitly into a disposable destination
outside the source worktree, and inspect it before deliberately incorporating
any result. Never copy remote state or a container's `gm` over shared tools.

#### Cloud lifecycle and cost bounds

Each worktree gets its own Worker, container, journal and unique preview
origin; app traffic never targets canonical port 5180 or a sibling's
environment. Preview authorization uses a short-lived one-use launch ticket
exchanged for a secure cookie, separate from the control credential.
Inspector access requires control authentication, not a preview cookie.
Use a fresh browser context per environment/persona even with isolated origins.

The repository pins one `standard-4` container per Worker (4 vCPU, 12 GiB RAM,
20 GB disk). Provisioning uses the [shared installation quota](#environment-limits-and-quota-authority),
not a separate four-container counter. These are Timelines policy limits, not
Cloudflare account-wide quotas. The environment has an absolute maximum lifetime
of 24 hours, with no silent renewal. A Durable Object alarm enforces compute
expiry even if the host agent disconnects. The hosted runtime installs no systemd
service; remote setup instead installs the host's hourly
`gitmatrix-remote-cleanup.timer` before provisioning. Its Node-only cleanup code
lives outside worktrees in `~/.local/state/gitmatrix-agent/remote-janitor`, uses
local `cf` and authority-specific `gm` credentials without putting tokens in
service units, and survives source-worktree removal.

Container disk, dependencies, test data and process logs are **ephemeral**:
stopping or recycling the container can discard them. Retrieve needed evidence
before stopping; reconnect is not a backup or a promise of persistent disk.
Restart requires source synchronization and installation again. Disconnecting
a client is not a stop or a teardown; remote processes can keep running.

Use `destroy` for owned app-resource, control Worker and Container application
cleanup; `stop` alone is not cleanup. Child and parent quota reservations are
released only after physical cleanup succeeds and the pinned authority
acknowledges release. Partial deletion or ambiguous release remains journaled for
retry, so never delete the journal to hide a failed teardown. The host cleanup
timer cannot run while its user manager is unavailable; provider deletion or
quota release can also fail with revoked credentials or an unavailable service.
Reconnect with valid local `cf` and quota-authority `gm` access, run
`cleanup --expired`, and inspect
`journalctl --user -u gitmatrix-remote-cleanup.service` after failures.
Do not delete unrelated resources
by guessing a prefix.

Running containers incur provisioned memory/disk charges as well as active CPU
charges, including while waiting for edits. Stopping saves running-container
compute charges but does not erase other resource costs. Workers, Durable
Objects, egress and provisioned application services have their own billing.
See [current Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/)
and set account billing alerts: profile, concurrency and expiry limits are
**not a hard currency budget**. AI remains off unless explicitly requested;
remote execution is not permission to run paid AI verification.

### Completion gate

```bash
vp run ready                 # uncached checks selected from this change's blast radius
vp run ready --dry-run       # explain changed paths, selected gates and E2E without running them
vp run ready --all           # full local suite, regardless of changed paths
vp run ready --base <ref>    # compare with another integration branch's merge base
vp run agent test            # fresh, complete non-AI live E2E only
vp run agent test-ai         # explicit paid verification of the AI stages your change maps to
```

`ready` compares against the merge base with local `origin/main`, including committed,
staged, unstaged and untracked files. Renames include both old and new paths. It does
not fetch: sync the source workspace first. `--base` changes the integration baseline,
not the requirement to verify all your unlanded work.

The root formatting/lint/type-aware `vp check` and remote Worker contract
typecheck always run. The latter generates the credential-free remote bindings
required by root lint. Website bindings are generated once before consumer checks.
Other uncached gates follow workspace dependencies, including the harness and
preview tools' relative imports of website contracts:

| Change                                                                                         | Selected coverage                                                                                                             |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| CLI source/assets                                                                              | Rust format/clippy, tests/build and full non-AI E2E; no unrelated website tests/build                                         |
| Website source                                                                                 | Website and dependent harness/preview checks/tests, website build and non-AI E2E; no unrelated Rust checks/release build      |
| Frontend-only (`src/`, `public/`)                                                              | Website coverage above; browser E2E journeys with their prerequisite scenarios, without unrelated backend scenarios or mirror |
| Shared formats                                                                                 | Package checks/tests plus dependent website/harness/preview coverage and E2E                                                  |
| Shared test helpers                                                                            | Package and consumer checks/tests, without production builds or E2E                                                           |
| Tests only                                                                                     | Their workspace's checks/tests; no builds or live E2E                                                                         |
| Known root/workspace README, AGENTS, CONTRIBUTING or CHANGELOG                                 | Mandatory checks only; Markdown runtime assets are not exempt                                                                 |
| Coding-agent Markdown instructions/skills and `.claude/settings.json`                          | Mandatory checks only; executable hooks and scripts are not exempt                                                            |
| Global/task/dependency configuration, shared harness, unknown paths or failed change discovery | Full suite                                                                                                                    |

Content-only edits to the three audited stylesheets
`apps/website/src/styles/{app,tokens,matrixkit}.css` preserve all website unit and
browser tests, the website build and selected live E2E. They omit only the implicit
agent/preview TypeScript consumer checks. Changed imports, URLs or at-rules,
renames, and mixed or unknown changes widen coverage instead of taking that shortcut.

Route-only changes to `UsageCosts.tsx` select both the usage and retention browser
journeys; `DataRetention.tsx` selects retention. Global styles and shared UI,
navigation, API/session and routing changes keep broad browser coverage. Frontend
profiles use the focused real expired-source journey instead of the full backend
retention matrix: it expires and purges real source data, removes timeline history,
and checks the explicit expired-source browser state. Full profiles keep both
journeys.

Unchanged workspaces are skipped, not reported as tested. The selection and its
reasons print before execution and are saved as `selection.json` beside the gate
logs under `.gitmatrix-agent/artifacts/gates-<timestamp>/`. `--all` restores complete
workspace checks, tests/builds and all non-AI CLI/API/browser/mirror E2E.
Gate `completion.json` records per-gate `elapsedMs`, `wallMs` and `outcome`, plus
total elapsed time and completion status, including failed cases. These describe
observed execution, not an assumed speedup from parallel scheduling.
Gate, E2E lifecycle/scenario and recovery-phase durations use the monotonic clock,
as do landing-fixture polling deadlines: wall-clock corrections cannot shorten
or extend those waits. Timestamps and persisted expiry times still use wall time.
`agent check` accepts the same flags; `agent test` remains the complete live suite.
CI/CD gate coverage is retained; candidate proof reuse requires explicit pipeline
opt-in. Update the workspace policy in `tools/agent/ready-plan.ts` when adding
workspaces or cross-workspace imports, and the scenario inventory, browser coverage
and prerequisite map in `ready-e2e.ts` when adding E2E journeys.

Measured decisions from 2026-10-09 (single local runs, not portable benchmarks):

- Keep the combined website test invocation: it took 133.2 s; separate unit and
  browser invocations took 178.4 s and did not demonstrate an improvement.
- Keep all nine recovery fault cases: the shared two-repository fixture took
  4.7 s of the 467.4 s recovery matrix, so setup was not its dominant cost.
- Use the focused expiry/history-removed browser fixture in frontend selection
  (12.9 s), while retaining the broad backend retention scenario (76.4 s) in full
  readiness. These are different coverage scopes, not interchangeable tests.

Selected test commands always execute; Cargo may reuse compiled outputs, not test
results. Missing credentials, required provider outages or an unavailable browser
fail selected gates, never cause them to be skipped. The website's `vp test` includes
browser-mode tests in headless Chromium; UI behaviour belongs there, and E2E keeps
real-stack journeys (apps/website/README.md, "Testing").

The usage and retention browser journeys close each persona/viewport context after
its assertions and trace finish, before opening the next. Keep that lifetime bounded:
finished pages still consume renderer memory if left open until scenario teardown.

The History journey compares the range summary with the same API issue population
the browser loads. Ruler drags update the address before the inspector's close link
necessarily rerenders: wait for that link's final range destination, then verify
closing preserves it before comparing counts. The selected range must include the
showcase issue's completion so the done-count check cannot pass without exercising it.

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

The source-landing fault fixture stops at `after-receipt` only once Tracker has
durably saved the repository as `advanced`, before any subsequent repository moves.
Setting that barrier before an optimistic save can deadlock recovery after a
version conflict or interrupted RPC. The real partial-retry/cancel assertions
remain unchanged; unit regressions exercise both failed-save paths.
Its secret-scoped `tick` action drives the existing recovery state machine while
waiting, since local development does not run the hourly cron after an interrupted
background invocation. Only active landings advance: failed gates and blocked
outcomes are never restarted. The separate automatic-landing journey still checks
CI-triggered progress without fixture ticks. Inventory probes dispose their
Artifacts repository handles even when they only check existence.

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
Landing-boundary failures also retain the last control response, landing state,
CI jobs and Workflow status before cleanup in these private observations. The
capability-scoped diagnostic reads do not retry the scenario or change its failure.

Local CI runners set `GITMATRIX_CI_ARTIFACTS_DIR` to a private job-specific directory
outside the disposable checkout and print its path in setup logs. The harness
retains only allowlisted sanitized JSON reports there, including failures; it strips
scenario observations and never copies credentials, raw logs or browser storage.
Structured phase timings are extracted from observations: up to 11 allowlisted
source-landing entries (fixture, nine fault cases and cleanup) retain only the
`e2e.phase` event, sanitized name, `elapsedMs` and `outcome` fields, never the
surrounding observations.
E2E `timings.json` separates preparation, provisioning, migrations, startup, seeding,
scenarios, shutdown and cleanup. Provider reports separate knowledge generation
from search-index visibility. A failed run is a failed gate; fix the cause rather
than skipping the scenario.

Before calling work complete: run `ready`, exercise the specific changed consumer
path, inspect the evidence, update affected contracts/docs, and stop or destroy
unneeded environments. Publish source changes with ordinary `gm commit` / `gm push`
**outside** the scoped `agent gm` wrapper, then check `gm runs wait`.
`.gitmatrix/ci.yml` starts check, test and build independently on production's
Cloudflare Sandbox containers; all must pass. Its check, test, build and CLI gates
explicitly opt into candidate verification reuse (see the website's CI/CD guide);
deploy remains real execution. Non-AI E2E runs only on local runners
(`if: runner == "local"`): `ready` is where it gates your work. The jobs exchange no
artifacts, so no dependency-stage barrier is needed.
The canonical development server runs one CI job at a time by default;
`GITMATRIX_CI_RUNNERS` overrides this when the server starts. Isolated agent
environments keep two slots for their fixture jobs. No running server needs to
be restarted just to adopt these defaults; they apply at its next normal start.
Both `ready` and source CI run recursive workspace test/build tasks one at a time.
Every Vitest pool is capped at two workers. `.cargo/config.toml` defaults Cargo to
four compiler workers for local commands, and source CI explicitly uses the same
limit. Manual recursive commands can use `vp run -r --concurrency-limit 1 build`
or `vp run -r --concurrency-limit 1 test` to keep the same memory budget.

Agents share the host and run their heavy test work in parallel: the website's
tests (`vp run test`, which `ready` and CI run through
`tools/agent/website-tests.ts`) and the live E2E (`ready`, `agent test`,
`agent test-ai`) take no machine-wide lock (CORE-108 removed CORE-306's). With
under 4 GiB available the browser-mode tests use one worker. If Chromium is still killed for memory ("Browser connection was
closed"), the website's tests run the browser files it abandoned once more,
one at a time; a failed assertion is never retried. A failed E2E scenario
records the memory available when it failed.
The same crash-only recovery applies when selecting the whole browser project
(`--project browser` or `--project=browser`). Arbitrary file/test filters run
unchanged without guessing a retry inventory; ordinary assertion failures never
qualify for recovery.
Locally, E2E runs on the trusted Linux host with Cloudflare login and user-systemd
prerequisites. Local runners retain repo/job-scoped Cargo output caches outside
checkouts; concurrent jobs lease separate slots. Tests still run every time.

### AI capability verification

Real AI checks are **not automatic CI requirements**. For changes to knowledge
builds, graph extraction, generated wiki, embeddings, AI Search, the assistant,
AI-written release notes, avatars or the Atlas, follow the
[AI verification skill](.agents/skills/gitmatrix-ai-verification/SKILL.md) and run
`vp run agent test-ai`.

It is **targeted**: it runs only the stages that the paths you changed against
`origin/main` (commits, the working tree and untracked files) map to, plus the
stages those build on. The mapping lives beside each stage, in
`tools/agent/provider-e2e.ts` (`COPPER_FINCH_STAGES`) and
`tools/agent/atlas-provider-e2e.ts` (`ATLAS_STAGES`); shared AI infrastructure
(`tools/agent/ai-stages.ts` `SHARED_PATHS`: the bindings, the Worker entry, the
Gateway and model layer, AI settings, dependency versions) runs every stage. A
change that maps to no stage provisions nothing. `--dry-run` prints the
selection and why; `--stage <id>` and `--all` add stages, never remove one whose
code changed. `--resume` after a failure reuses a stage's latest attempt only
if it passed, including across runs that skipped it. The merge base and mapped
changed content must stay unchanged throughout; a later failed or incomplete
attempt invalidates that evidence. Prerequisites still run in the new environment.
Within 30 minutes of a failure it refuses a full run, and any rerun with nothing
changed, unless `--force`: inspect the evidence and fix the cause instead of looping.
`completion.json` and `ai-e2e.json` (`selection`, `stages`, `cost`) record which
stages ran, why, their outcomes and the Gateway-logged spend.

| Stage                                                | Verifies                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `classification`                                     | Selected Clef Flash/Omni decisions, uncached attribution and one metered call per model             |
| `knowledge`                                          | AI settings admission, the build, graph and generated wiki overview                                 |
| `search`                                             | Vectorize entity and AI Search passage visibility, isolation, palette search                        |
| `assistant`                                          | A real turn from the index, approval-gated writes, retry, status between steps                      |
| `avatars`                                            | Real avatar generation within its ten-call budget                                                   |
| `knowledge-edit`                                     | An edit's incremental rebuild, concept naming, successor build settings                             |
| `release-notes`                                      | Daily notes, rollover, a tag, a tracker issue's entry, the team feed                                |
| `release-highlights`                                 | Grounded organization prose over seven days, authorized-source isolation, cadence, invalidation, UI |
| `overlays`                                           | A timeline bookmark's knowledge overlay, main untouched                                             |
| `timeline-pages`                                     | A checkpoint's wiki pages, main untouched                                                           |
| `repository-deletion`                                | Purging the fixture's vectors, search items and Artifacts; the orphan sweep                         |
| `queue`                                              | The merge queue's real conflict repair                                                              |
| `atlas-describe`                                     | The ledger's capabilities named and summarized with provenance; Knowledge tab                       |
| `atlas-workspace`                                    | A dependency resolved across repositories in the workspace Atlas                                    |
| `atlas-reuse`                                        | Same-tree commit: cached prose and inference provenance, advanced source basis, no new Atlas calls  |
| `atlas-disabled`, `atlas-refused`, `atlas-exhausted` | The three degraded Atlas providers                                                                  |

Every run provisions its own paid resources. Together, the stages verify the exact
pushed commit, named graph relationships, generated wiki provenance/content, and
matching Vectorize entities plus AI Search source passages. It also verifies
daily release-note rollover by UTC committer date, retained commit provenance,
optional named tags and non-duplicated daily tracker feeds. It exercises real avatar
generation and checks Gateway attempts within its ten-call budget, with successes matching the
returned images (the API permits partial generation). It also checks successful
Gateway records for knowledge, embeddings and assistant streaming/titles, including
usage metadata, and that bodies are kept for knowledge and assistant streams (the agent
environment's default) but not for titles and status lines, which the persona turns off. `ai-e2e.json` retains sanitized Gateway evidence. Assertions check source
facts, not exact generated wording. Missing providers or an expired visibility
deadline fail honestly. Interactive `agent setup` is AI-off unless `--ai`.

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

These setup measurements predate AI-off setup and include AI resources. Use the current
run's `timings.json` for automatic-gate measurements; historical totals that included
live AI generation/search are not comparable to the non-AI gate.
The measured non-AI E2E spent 41 seconds exercising scenarios, with mirror work
overlapped. These are local verification measurements, not a new trunk CI run.

### Cleanup and cost bounds

This section describes the **local backend's** cleanup service and limits.
The cloud backend has its own [lifecycle and cost bounds](#cloud-lifecycle-and-cost-bounds).

```bash
vp run agent stop                # stop app/runners; keep data until expiry
vp run agent reset [--ai]        # destroy owned data/resources, then fresh setup
vp run agent destroy             # delete this worktree's interactive environment
vp run agent cleanup --expired   # sweep expired environments across worktrees
vp run agent maintenance status
vp run agent maintenance reservations [--release [--expired]]  # reconcile installation reservations
```

- Every environment has a **24-hour maximum lifetime**, with no silent renewal.
  Both configurable caps above include E2E runs. Expired environments are swept
  before new provisioning, but expiry alone does not release installation capacity.
- Setup requires and installs the hourly `gitmatrix-agent-cleanup.timer` user
  service, with persistent catch-up and up to five minutes of jitter. Its code and
  resource journal live outside worktrees in `~/.local/state/gitmatrix-agent`, so
  deleting a worktree does not lose the cleanup inventory.
- Remote resource names must match an ownership-checked `gma-...` journal entry.
  Cleanup deletes AI Search instances/namespace, the AI Gateway, Vectorize index,
  and Artifacts repositories/namespace independently. Failed deletions stay journaled and are
  retried; unrelated resources are never discovered and deleted by prefix alone.
  An Artifacts namespace Cloudflare refuses to delete ("Namespace is not empty")
  while listing no repositories is **orphaned**: `status` reports it with the
  reason. Once the app is stopped and all other cleanup succeeds, an acknowledged
  quota release frees both local and installation capacity. Its namespace may
  still incur storage charges; the ownership journal remains and every cleanup
  retries deletion. Setup never readopts retired orphans, even after a provider
  retry fails. A persisted quota-release acknowledgement remains authoritative
  if cleanup was interrupted before writing its terminal status. An inconsistent
  live journal with released quota still fails closed. A failed quota release
  remains journaled and continues holding installation capacity until acknowledged.
  AI environments created before Gateway ownership was introduced must be destroyed
  and recreated with `setup --ai`; their legacy journals remain valid for cleanup.
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
- `maintenance reservations` lists your installation reservations at the configured
  authority as JSON and classifies each against **every** journal on this machine
  (local `environments/`, remote `gmr-` parents and the hosted `gma-` children
  their `resources[]` record): `live` (a journal still holds it), `released-locally`
  (its journal recorded the release, yet the row remains), `own-orphan` (reserved
  by this machine, with no journal left), `expired-foreign` (a `foreign` row more
  than a day past its expiry) or `foreign` (another machine's, or a row
  without a host: legacy rows and hosted children). `--release` frees only
  `released-locally` and `own-orphan` rows. The hourly local and remote sweeps run
  the same release, best effort, before taking the registry lock. A deleted local
  journal is pruned only once that listing shows its reservation gone from the
  authority the journal pinned: a journal pinned to another authority than the
  one configured now is kept, as is every journal when the listing fails.
- Each machine's host id is `~/.local/state/gitmatrix-agent/host.json`, stored
  with a digest of the Linux machine id (`/etc/machine-id`, else
  `/var/lib/dbus/machine-id`) and the uid that minted it. A home directory copied
  to another machine (VM or WSL clone, restored backup, dotfile sync) mints a new
  id there rather than sharing one, so neither machine can mistake the other's
  live rows for its own orphans. A machine without a machine id records no host.
  Replacing or deleting `host.json` turns that machine's existing rows `foreign`,
  never `own-orphan`. An unreadable `host.json` fails with its path; an empty one
  is replaced.
- `maintenance reservations --release --expired` is the explicit, opt-in path for
  host-less rows leaked before reservations recorded a host: it also frees your
  `expired-foreign` rows. A row's expiry already marks the end of its
  environment's 24-hour lifetime; the grace is one more day past that, for its
  owning machine's hourly janitor to clean it up. The sweeps never use it, and no
  row any journal on this machine still holds is released, however long ago it
  expired. It cannot see another machine's journals: run it only once those
  machines have finished cleanup (or are gone), since their resources may outlive
  the slot it frees. A `foreign` row within the grace is released only from its
  owning machine.

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
The patch also gives remote Artifacts calls explicit Cap'n Web session ownership:
scalar results close their session after materialization, and repository handles
retain it until disposal. Reopened handles own and release their replacement
sessions. Disposing only a repository capability leaves its root WebSocket and
keepalive timer alive; native Workers RPC cleanup does not own that custom root.
`tools/agent/remote-proxy-lifecycle.test.ts` exercises the installed client over
local Workerd/WebSocket transports, including retained handles, Blob materialization,
dropped reads, create reconciliation and non-replayed writes. Keep this regression
when upgrading or retiring the patch; no host port-limit change is required.
The TypeScript wrapper in `tools/agent/typecheck.ts` spawns the native compiler
because its exec-replacement launcher fails with `EBUSY` on this WSL host.
Use `vp env doctor` when runtime/package-manager setup is suspect.

## Distributed issue tracker

The Timelines tracker is account-owned and independent of Git history: teams own
issues, workspaces organize them, and repository subscriptions do not grant access.
Use `/tracker` for the human workbench or `gm tracker use OWNER` and `gm issue ready`
for agent work. See the [tracker architecture and API](apps/website/README.md#distributed-issue-tracker)
and [CLI workflows](apps/cli/README.md#distributed-issue-tracker).
