# Gitmatrix

A git host on Cloudflare: one Worker serves the React app, a JSON API, and git's
smart HTTP protocol. Repository contents live in
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/); accounts,
permissions and tokens live in D1.

```
git client ──Basic user:token──▶ Worker /:owner/:repo.git/*  ──Bearer art_…──▶ Artifacts git remote
browser    ──cookie──▶ Worker /api/*  ──env.ARTIFACTS──▶ log / readTree / readFile
                          └── D1: accounts, org_members, repos, repo_collaborators, access_tokens
```

## Run it

```bash
pnpm install
pnpm run db:migrate   # local D1: schema + dev personas
vp dev                # http://localhost:5180
```

Sign in with `cf auth login` (the account needs Artifacts and Workers AI). There
is no local Artifacts, Workers AI, Vectorize or AI Search emulator, so dev uses
the real services (`dev: { remote: true }` in `cloudflare.config.ts`); D1, the
Durable Object and the Workflow run locally, with state in `.wrangler/state`
(the Vite plugin's default, shared with `cf --persist-to`). `cf` 1.0.0-beta.7
doesn't exit after local D1 commands; stop it once it prints its result.

On the persona screen, **Load samples** imports three small public GitHub repos
and creates one empty repo.

## Personas (dev sign-in)

Picking a persona sets a cookie holding the account id, with no secret. This is
deliberately throwaway; real sign-in replaces the session half of
`worker/auth.ts` and `migrations/0002_dev_personas.sql`.

| Persona    | Access                                                         |
| ---------- | -------------------------------------------------------------- |
| Priya      | Site admin: admin everywhere                                   |
| Marco      | Owner of the Orbit Labs org: admin on its repos                |
| Jun        | Orbit member (read), plus write collaborator on `orbit/engine` |
| Sam        | Read collaborator on `orbit/engine`; owns private `sam/notes`  |
| Signed out | Public repos, read only                                        |

Roles add up: public → read, org member → the org's base role, collaborator →
their role, owner/org owner/site admin → admin (`worker/permissions.ts`).
Repos you can't read return 404, never 403.

## Git over HTTPS

One command points the git CLI at Gitmatrix as a persona, with no browser:

```bash
pnpm run git:login priya          # or jun, sam, marco; add --read for a clone-only token
git clone http://localhost:5180/orbit/engine.git
```

It mints a token through the dev API and stores it with git's `store` helper in
`~/.config/gitmatrix/credentials`, scoped to `http://localhost:5180` in your global
git config. Run it again to switch persona. From the browser instead, create a
token under **Access tokens** and use it as the password.

Tokens are `read` (clone/fetch) or `write` (also push), and are stored as SHA-256
hashes. The proxy checks the person's role and the token's scope, then streams
the request to Artifacts with a short-lived repo token cached per isolate.

## SSH keys over HTTPS

Workers speak HTTP, not SSH, so `gm` signs in with SSH keys without an SSH
connection: it proves it holds a registered key by signing a one-time
challenge, then uses a short-lived token like any other.

```
gm ─ POST /api/auth/ssh/challenge {fingerprints} ─▶ first registered key offered + nonce
gm ─ sign "gitmatrix-ssh-auth\n<origin>\n<nonce>\n<fingerprint>\n" (SSHSIG, namespace gitmatrix-auth)
gm ─ POST /api/auth/ssh/token {nonce, signature} ─▶ 1-hour session token (git + API)
```

- **Keys** are registered under **SSH keys** in the web app or with
  `gm auth ssh-key add` (Ed25519, ECDSA P-256/P-384, RSA ≥ 2048 with SHA-2), each
  read or write. Removing a key ends its sessions.
- **Signatures** are SSHSIG, the format of `ssh-keygen -Y sign` and git's SSH
  commit signing, verified with WebCrypto (`worker/ssh.ts`, tested against
  OpenSSH-made signatures). Nonces are single-use, expire in 2 minutes, and are
  bound to the server's origin; gm refuses to sign anything else.
- **gm finds keys like ssh**: the agent named by `IdentityAgent` in
  `~/.ssh/config` (how 1Password's agent is set up), then `SSH_AUTH_SOCK`, then
  `IdentityFile`s and `~/.ssh/id_*`. It signs through the agent, so 1Password's
  approval prompt works as usual; key files with a passphrase prompt at a
  terminal.
- **…or like git, when git uses another ssh.** If `core.sshCommand` (or
  `GIT_SSH_COMMAND`) names something other than plain `ssh`, e.g. `ssh.exe` in
  WSL so Windows OpenSSH reaches 1Password, gm uses that ssh's `ssh-add -L` to
  list keys (plus `user.signingKey`) and signs the way git signs commits: with
  `gpg.ssh.program` when set (e.g. `op-ssh-sign-wsl`), else that ssh's
  `ssh-keygen -Y sign`, given Windows paths. `gitmatrix.sshCommand` in git
  config sets the ssh for gm alone. Sessions are cached in `~/.cache/gitmatrix/ssh-session.json` and
  renewed with the key when they end.
- **Plain git** can use the same sign-in through gm as a credential helper:
  `git config --global credential.<server>.helper '!gm auth git-credential'`.

```bash
gm auth login --persona priya   # (dev) any sign-in, to register a key
gm auth ssh-key add             # first key in your agent or ~/.ssh; --key to pick
gm auth login --ssh             # from now on gm signs in with the key
```

## Headless API

Every `/api` route accepts `Authorization: Bearer gmx_…` in place of the browser's
persona cookie; read-scoped tokens can only `GET`.

```bash
H=http://localhost:5180
TOKEN=$(curl -s -X POST $H/api/dev/tokens -d '{"persona":"jun"}' | jq -r .secret)
curl -H "Authorization: Bearer $TOKEN" $H/api/repos
curl -H "Authorization: Bearer $TOKEN" -X POST $H/api/repos \
  -d '{"owner":"jun","name":"demo","visibility":"private"}'
```

| Route                                                                                     | Does                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `POST /api/dev/tokens` `{persona, scope?, name?}`                                         | Mint a token for any persona (dev only, no auth) |
| `POST /api/dev/seed`                                                                      | Load the sample repositories                     |
| `GET /api/session`                                                                        | Who the token or cookie belongs to               |
| `GET /api/personas`, `GET /api/users`, `GET /api/accounts/:slug`                          | People and orgs                                  |
| `GET /api/repos`, `POST /api/repos` `{owner, name, visibility, description?, importUrl?}` | List, create or import                           |
| `GET\|PATCH\|DELETE /api/repos/:owner/:name`                                              | Detail with branches and tags, update, delete    |
| `GET /api/repos/:owner/:name/tree?ref=&path=`                                             | Folder listing, latest commit, README            |
| `GET /api/repos/:owner/:name/blob?ref=&path=`                                             | File contents                                    |
| `GET /api/repos/:owner/:name/commits?ref=&page=`                                          | History, 30 per page                             |
| `GET\|PUT\|DELETE /api/repos/:owner/:name/collaborators[/:user]` `{role}`                 | Manage access (admin)                            |
| `GET\|POST /api/tokens`, `DELETE /api/tokens/:id`                                         | Your tokens                                      |
| `POST\|DELETE /api/session` `{accountId}`                                                 | Browser persona cookie                           |

## Knowledge graph and wiki

Every repository has a knowledge graph that stays current as it changes; the
wiki is one consumer of it (the Knowledge tab and `/api/repos/:o/:n/knowledge/*`
are others). Inspired by OpenDeepWiki, rebuilt around the graph and around
real-time incremental updates on Cloudflare.

```
push ─▶ git proxy ─▶ KnowledgeCoordinator (Durable Object, one per repo)
                       debounce 1.5s (max 8s), one build in flight, rebuild if dirty
                     ─▶ KnowledgeBuild (Workflow, durable retried steps)
   snapshot ─▶ analyze ─▶ graph ─▶ align ─▶ concepts ─▶ synthesize ─▶ review ─▶ graph-final ─▶ index ─▶ wiki ─▶ finish
                 │           │        │          │            │                         │        │
   kg_blob_analysis  kg_nodes/edges kg_concept_pairs kg_concepts  kg_synthesis   Vectorize + AI Search  wiki_pages
   (by blob id)      kg_changes feed (clef, by pair) (groups,     (by inputs hash) (entities / passages) (inputs hash +
                                                      links, trim)                                         clef gate)
```

- **Analysis per content, not per commit.** Each file version (blob) is
  analyzed once: exact structure from regex extractors (imports, symbols,
  resolved file/package edges), its role from `clef`, and a semantic card from
  `glm-5.3-flash`. An edit `clef` judges cosmetic reuses the previous card.
- **The graph** (repo, directories, files, symbols, packages, concepts,
  components) is rebuilt from cached analyses on every build and diffed, so
  ids are stable and each build leaves a change feed (`kg_changes`).
  Components are size-bounded directory clusters; their summaries, the
  repository overview and concept definitions come from `qwen3.8-27b`, cached
  by a hash of their inputs.
- **Retrieval:** Vectorize holds one embedding per entity
  (`qwen3-embedding-0.6b`); AI Search holds source files and wiki pages for
  hybrid keyword + semantic passage search with reranking.
- **Concepts are aligned and trimmed with `clef`** (`worker/knowledge/concepts.ts`),
  after the entity-alignment recipe: candidate pairs come from shared uncommon
  words and mutual nearest neighbours by name embedding; `clef` scores each
  pair 0 different / 1 related but separate / 2 the same ("should a glossary
  list these as one entry?"), plus which is part of the other. Level-2 pairs
  merge under a stable canonical key (never chaining into a group with a
  concept judged different); clear level-1 directions become `part_of` edges.
  Then each group is asked whether a newcomer would look it up in the glossary
  (3+ files always stay); the rest become `topics` on their files. Once kept
  concepts have definitions, their related pairs are asked again with the
  definitions (`review`), which settles many that names alone left in between.
  Decisions are stored, so a push only asks about the concepts it introduced.
  The wording was picked on hand-labelled samples from this repo: the glossary
  framing with file paths ranked pairs best (AUC 0.94 vs 0.85 for the recipe's
  wording; file summaries made it worse) with all level-2 merges correct; the
  glossary question separated keep/trim at AUC 0.88; with definitions, the
  review recovered half the duplicates names missed. On this repo: 410 concept
  names → 118 concepts (34 names merged into others, 258 groups trimmed to topics), all defined,
  15 part-of links; the glossary went from 60 to 118 entries. First alignment
  ~1,300 `clef` calls (~6 min); a rebuild with nothing new asks none.
- **The wiki** catalog comes from the graph. A page is rewritten only when its
  inputs change _and_ `clef` judges the change makes it out of date; diagrams
  are drawn from the graph on every build, never by a model.
- **Latency** on this repo: a 2-file push updates the graph in ~14s, summaries
  in ~40s, search in ~60s and the affected wiki page in ~90s. A first build of
  ~100 files takes ~13 minutes (mostly writing every page once).
- **Robustness:** model calls have deadlines and back off on Workers AI rate
  limits; a failed file is retried next build; the coordinator's watchdog
  stops a hung build and retries it once.

Models live in `worker/knowledge/models.ts`. `POST /api/dev/clef` with
`{state, questions}` is a playground for tuning `clef` questions. Resources (dev): Vectorize index
`gitmatrix-knowledge`, AI Search namespace `gitmatrix` / instance `knowledge`.

## CI/CD

Repositories declare a pipeline in `.gitmatrix/ci.yml`; every push that moves
a matching branch starts a run (also: the Run button, `gm runs start`, re-runs).

```yaml
on:
  push:
    branches: [main, "release/*"] # globs; omit for every branch
env: { CI_MODE: strict }
jobs:
  test:
    steps:
      - name: Install
        run: pnpm install --frozen-lockfile
      - run: vp test
  deploy:
    needs: [test] # runs only if test succeeded
    if: branch == "main" # ==, !=, &&, ||, () over branch, trigger, commit
    secrets: [CLOUDFLARE_API_TOKEN] # `gm secret set`, masked in logs
    timeout_minutes: 15 # default 20
    instance: standard-2 # sandbox size (default standard-1)
    steps:
      - run: cf deploy
```

```
push ─▶ git proxy ─▶ onPush: ci_refs diff (one run per moved branch) ─▶ ci_runs/jobs/steps (D1)
                                                                     ─▶ CiRun (Workflow, one per run)
CiRun: jobs in dependency stages, in parallel within a stage, dependents of failures skipped
   CI_RUNNER=sandbox  step.do ─▶ CiSandbox (Durable Object + container, one per job):
                      start, clone from Artifacts, bash each step, stream logs, destroy
   CI_RUNNER=local    job queued ─▶ POST CI_DISPATCH_URL ─▶ vp dev starts `gm runner --once`
                      ─▶ it claims the job over the API, runs the steps on your machine,
                      streams logs, reports the end, exits ─▶ step.waitForEvent resumes
```

- **Runners.** Deployed, jobs run in Cloudflare Sandbox containers (image
  `ci/Dockerfile`: Node 24, pnpm, Vite+, Rust, git). Under `vp dev` they run on
  this machine instead, so development doesn't start paid containers, and
  they come and go the same way: when the CI Workflow queues a job it pings
  the dev server (`CI_DISPATCH_URL`), whose `vite/ci-runners.ts` plugin starts
  `gm runner --once` processes until the queue is empty (4 at a time;
  `GITMATRIX_CI_RUNNERS` changes it). Nothing has to be left running; jobs
  queued while the dev server was down start when it comes back. Outside
  `vp dev`, `gm runner` still works by hand. `GITMATRIX_CI_RUNNER=sandbox vp dev`
  runs the container path locally with Docker. The choice is made in
  `cloudflare.config.ts`, which attaches the container only when sandboxed.
- **Both runners report the same way** (`worker/ci/jobs.ts`): batched log
  chunks, step transitions, the end. Secret values are masked server-side; a
  cancelled job is told so in the reply to its next report and kills its
  process group.
- **Agents** push, then `gm runs wait`: it blocks on the commit's run and exits
  non-zero with the failing job named; `gm runs logs --job <name>` has the output.

API: `/api/repos/:o/:n/ci` (runs, run detail, logs with `?after=`, cancel,
re-run, commit statuses, secrets) and `/api/ci/runner` (claim, report).

## Packages

Every owner gets a package registry in each format the first time something is
published to it: npm, Docker/OCI, PyPI, Maven, Cargo, Go, Helm, APT, RPM,
Homebrew, generic files and releases. The engine (`registry/`,
`packages/formats`) comes from artifatrix and runs in this same Worker on its
own D1 database (`REGISTRY_DB`), R2 bucket (`REGISTRY_BLOBS`), Durable Objects
and queue. Accounts and permissions stay in gitmatrix's `DB`.

```
npm / docker / pip / cargo … ──▶ /npm/<owner>/… /v2/<owner>/<image>/… /pypi/<owner>/…  (registry/app.ts)
web app, gm                  ──▶ /api/packages/…   (registry/manage: console queries, housekeeping, feeds)
every publish                ──▶ publishes: version, repository, branch, commit, CI run, actor
```

- **CI publishes natively.** A job gets a credential (`gmj_…`) bound to the job
  and through it to its repository, commit and run. It ends with the job. Package
  tools come set up with it: `npm publish`, `docker push
$GITMATRIX_IMAGE_PREFIX/app:tag`, `twine upload`, `cargo publish --registry
gitmatrix`, `mvn deploy` (server id `gitmatrix`), `helm push`, Go modules
  through `GOPROXY`, and `gm pkg upload` for files (`worker/ci/registry.ts`).
- **Packages remember their sources.** The first CI publish of a package claims
  it for the job's repository. After that, only its sources' jobs and people
  who can write to a source may publish it. Owner admins grant more
  repositories, cross-owner ones included (`package_sources`). People without
  write access to a source get a 403 naming the sources.
- **Access follows the owner.**
  - The owner and org owners are admins. Org members get read, or write when
    the org gives members write. Collaborators who can write one of the
    owner's repositories get write.
  - Deleting versions takes admin, and CI jobs never delete.
  - Feeds are private by default.
  - Tokens: `gmx_` access tokens and SSH sessions, `gmj_` job tokens, Docker's
    token flow, and the web session.
- **The console.** `/:owner/-/packages/:format/:name` queries a package's
  publish history:
  - a query language (`source:web branch:main status:active since:7d
commit:4f2a run:42 by:jun tag:latest`, with `-` to exclude);
  - facet counts, and a publish-rate strip you brush to zoom in;
  - a virtualized table, built for tens of thousands of versions;
  - bulk delete, yank, deprecate and tag, for a selection or everything a
    query matches.

  Repositories have a Packages tab, and CI runs list what they published.

- **Feeds and proxies.** `/:owner/-/feeds` sets visibility and retention (keep
  the newest N versions, or remove them after N days; tagged versions stay),
  and adds proxies (`<owner>.<name>`, credentials sealed with `REGISTRY_KEK`)
  and virtual feeds over several of them. An hourly cron sweeps retention, and
  a GC deletes unreferenced blobs.
- **npm login** works both ways: an access token as the password, or
  `--auth-type=web`, which approves the login at `/cli-auth/npm/:id`.

Deployed, set `GITMATRIX_PUBLIC_URL` (package indexes embed it) and the
`REGISTRY_KEK` secret. Development uses a fixed public key. `pnpm run
db:migrate` applies both databases' migrations. Account slugs must not take
the registry's path prefixes (`v2`, `npm`, `pypi`, `maven`, `cargo`, `go`,
`helm`, `apt`, `rpm`, `brew`, `generic`, `releases`) or `-`.

## Mirrors

A repository can mirror every push on to another git host: Settings → Mirror,
`gm repo mirror set <url> --token-stdin`, or `PUT /api/repos/:o/:n/mirror`.
Gitmatrix's own repository mirrors to GitHub this way, as a backup.

```
push ─▶ git proxy ─▶ queueMirror ─▶ JOBS queue (gitmatrix-jobs) ─▶ syncMirror
syncMirror: target refs (receive-pack advertisement) vs Artifacts' (ls-refs)
            ─▶ fetch exactly the missing objects from Artifacts (v2 fetch, haves = target tips)
            ─▶ stream that pack into the target's receive-pack ─▶ report-status
```

- **One way, and safe by default.** Branches and tags are pushed (force, so
  rewinds follow); anything pushed to the target directly is overwritten.
  Refs that disappear here stay on the target unless pruning is on, so a
  backup never loses data on its own.
- **Off the push path.** A push enqueues its repository; the consumer syncs
  it and retries failures with exponential backoff. A lease in `repo_mirrors`
  keeps one sync per repository at a time, and every sync converges on the
  current refs, so duplicate or late messages are harmless. Status, the last
  error and the last synced commit show in Settings and `gm repo mirror show`.
- **No git binary.** Workers can't run git, so `worker/mirror/` speaks the
  protocol: the pack streams from Artifacts to the target without buffering.
- The token (push access on the target) is sealed with `REGISTRY_KEK`.

## Layout

- `worker/git/http.ts`: smart HTTP proxy (info/refs, upload-pack, receive-pack)
- `worker/ssh.ts`, `worker/api/ssh.ts`: SSH public keys, SSHSIG verification, key sign-in
- `worker/git/pktline.ts`: pkt-line codec and the `ls-refs` client used to list branches
- `worker/api/*`: JSON API (`dev.ts` mints persona tokens and seeds sample data)
- `worker/knowledge/*`: knowledge graph pipeline, coordinator, workflow, API
- `worker/ci/*`: CI config parser, push trigger, run Workflow, sandbox Durable Object, API
  (`registry.ts`: job credentials and package-tool setup)
- `registry/`: package registries (formats, catalog, ACL, provenance, Durable Objects,
  jobs); `registry/manage/`: the packages API behind the console, feeds and gm
- `packages/formats` (repo root): IO-free protocol libraries for every package format
- `scripts/git-login.ts`: points the git CLI at Gitmatrix as a persona
- `src/`: React Router (data mode), Base UI and Tailwind, styled with MatrixKit Neo
  (`src/styles/tokens.css` is generated from the design system's tokens;
  `matrixkit.css` is its component stylesheet, vendored as is)

## Known gaps

- No branch protection, events, or webhooks yet. `pushed_at` is set when receive-pack
  returns 200, even if git rejected a ref inside the response.
- READMEs render Markdown without raw HTML, so `<details>` and `<br>` show as text.
- In testing, imports brought over the default branch only, without tags.
- Owner slugs `signin`, `new`, `settings`, `api`, `cli-auth`, `-` and the registry prefixes
  collide with routes and should be reserved once accounts can be created.
- Packages: the tag facet lives in the header's tag plates rather than the side
  column; retention can't yet keep a branch's builds longer than another's.
