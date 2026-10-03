# Gitmatrix

A git host on Cloudflare: one Worker serves the React app, a JSON API, and git's
smart HTTP protocol. Repository contents live in
[Cloudflare Artifacts](https://developers.cloudflare.com/artifacts/); accounts,
permissions and tokens live in D1. Account-owned issue trackers live in SQLite
Durable Objects, independent of repository history.

```
git client ──Basic user:token──▶ Worker /:owner/:repo.git/*  ──Bearer art_…──▶ Artifacts git remote
browser    ──cookie──▶ Worker /api/*  ──env.ARTIFACTS──▶ log / readTree / readFile
                          └── D1: accounts, org_members, repos, repo_collaborators, access_tokens
```

## Run it

For agent development, start at the repository root and follow the
[isolated agent workflow](../../README.md#agent-first-development):

```bash
vp install
vp run agent setup
vp run agent up
```

Use the origin printed by `up`. Setup builds the worktree's CLI, installs and
checks Chromium, provisions dedicated Artifacts/Vectorize/AI Search resources,
migrates both local D1 databases, and seeds deterministic Git/tracker fixtures.
Use `vp run agent inspect` for data, `vp run agent test` for non-AI real-service
E2E, and `vp run agent test-ai` when verifying knowledge/wiki/search capabilities.
Automatic E2E provisions only Artifacts and disables background AI work; normal
interactive setup remains AI-enabled. Use `vp run agent destroy` when finished.
Hourly cleanup and 24-hour expiry bound resource accumulation; see the root README
for costs and failure recovery.

There is no local Artifacts, Workers AI, Vectorize or AI Search emulator.
These bindings use real services; D1, Durable Objects and Workflows run locally
under the environment's `.gitmatrix-agent` state directory. The pinned Vite
plugin v2 reads `cloudflare.config.ts` directly. A pinned Miniflare lifecycle
patch makes local `cf d1` commands exit normally; do not terminate them early
after merely seeing output.

The canonical source host remains a separate, owner-managed environment:
from this directory, `vp run db:migrate`, `vp run db:seed` and `vp dev` use port 5180 and
`.wrangler/state`. Feature agents must not reuse that state or test mutations
against it. **Load samples** creates four small empty named repositories;
the agent harness fills them through real `gm` commits, without GitHub imports.

## File history

The repository file list shows each entry's most recent change, author,
co-authors and date. File views include the last change and a link to scoped
history. History and commit counts follow the selected revision's first-parent
chain; a path's history includes additions, deletions and mode changes but does
not follow renames. Co-authors (including agents) come from `Co-authored-by`
commit trailers, not verified account identities.

`GET /api/repos/:owner/:name/history` accepts `at=<ref>/<path>` or `ref` and
`path`, plus `entries=true` for immediate-child metadata. Each request scans at
most 100 commits. `next` is the next commit to scan; pass it as `cursor` and pin
`ref` to the returned `head` for subsequent pages. The file list loads this
separately from files and automatically follows pages until every displayed file
and folder has its latest change, then stops. One sequential scan serves the
whole directory, not a request per row; immutable history pages and commit/tree
objects are reused. Older pages never replace a newer last-change message.
Pending rows say **Finding last change…**; a failed page preserves resolved rows
and offers **Retry history**. Leaving the directory stops further pagination.
Counts remain partial (labelled with `+`) until **Load older history** reaches the
end. No file contents are read to calculate history.

## Sign-in

People sign in with an emailed one-time code ([Better Auth](https://www.better-auth.com),
`worker/better-auth.ts`, under `/api/identity`). Sign-up is **invite only**: a
code is only sent to an existing user, the instance owner (`OWNER_EMAIL`,
hello@fward.me) or an address a site admin invited at `/settings/invites`;
anyone else gets the same "check your email" answer. Failed codes and device
approvals count against the email and the IP through the `AUTH_FAILURES`
rate-limit binding; past the limit the key is locked out for 15 minutes.

- **Locally**, codes print in the dev server's log (the Email Service binding
  only simulates delivery), and hello@fward.me is the seeded superuser `fward`,
  reachable by email code or as a persona.
- **Deployed**, the owner's first sign-in makes them a site admin and the owner
  of the `matrixorg` organization (`OWNER_ORG`); the database starts with no
  other data. Codes are sent from gitmatrix@mail.fward.dev. Mirror pushes are
  attributed to the owner account, whoever configured the mirror.
- **gm** signs in through the browser: `gm auth login` shows a code and a link
  to `/device`, you approve it while signed in, and gm trades that one-time
  session for a personal access token (`POST /api/tokens/device`).

Deploying needs the `BETTER_AUTH_SECRET` and `REGISTRY_KEK` secrets. The Worker
serves https://gitmatrix.fward.dev (override with `GITMATRIX_PUBLIC_URL` at deploy
time), with production-only D1, Artifacts, Vectorize and AI Search resources so it
never shares data with `vp dev`. mail.fward.dev is enabled for Email Sending.

**CI deploys main.** Once check, test and build pass on main, the `deploy` job
(`tools/agent/deploy.ts`) ships only what changed since the deployed version:

- Every deploy tags its Worker version with its commit (`cf deploy --tag`), and
  the next run diffs from that commit. `node tools/agent/deploy.ts --plan` prints
  the plan from any checkout without changing anything.
- Changed `migrations/` or `registry/migrations/` apply to their database first;
  Worker code, assets or dependencies then deploy with `--containers-rollout none`.
  Docs, tests, `seed/` and `gm` changes deploy nothing.
- `gm` publishes to the owner's generic registry only when its source changed
  (`tools/agent/publish-cli.ts` asks the registry before compiling).
- A Sandbox has no Docker, so CI reuses the deployed CI image
  (`GITMATRIX_CI_IMAGE`). A change under `ci/` fails the job after the rest has
  shipped: run `vp run deploy` here, which builds the image and tags the commit.

The job's `CLOUDFLARE_API_TOKEN` is a repository CI secret (`gm secret set`).

**Adding a migration.** Name it by the current UTC time,
`YYYYMMDDHHMMSS_snake_case_description.sql` (for example
`20261003021500_ref_updates.sql`, from `date -u +%Y%m%d%H%M%S`), in
`migrations/`, `registry/migrations/` or `seed/`; don't use
`cf d1 migrations create`, which numbers the next file. D1 records applied
migrations by file name, and parallel work picking the same next number
collided once (the two `0016_` files). `cf d1 migrations apply` orders by the
integer before the first `_`, so timestamps apply after the frozen
`0001`–`0020` files; the test harnesses' sorted `readdir` agrees.
`worker/migrations.test.ts` (in `vp test`, so CI and `vp run ready`) fails on
a shared prefix, a new four-digit name or an invalid timestamp. A migration
merged after a newer one still applies, since D1 diffs by name, so write each
one to stand on its own. Update `worker/schema.ts` or `registry/core/db.ts` in
the same change.

**Parallel pushes.** The deploy job has `concurrency: production`: one deploy per
repository at a time, and a deploy still waiting when a newer push's run reaches
(or passes) its own deploy is skipped as superseded, so a burst of pushes deploys
once, from the newest commit (`worker/ci/concurrency.ts`). A deploy restarts the
CI Durable Objects and Workflows of runs in flight: their jobs start over in a
fresh sandbox (an attempt in progress is joined, a leftover container replaced,
a start that doesn't take is retried), with three retries per job.

**Fewer runs (CORE-23, `worker/ci/coalesce.ts`).** Starting a commit that already
has a run in flight on its branch returns that run. A job can declare `paths:`
(files or directories): on a push, it's skipped as unchanged when those paths
have the same git object ids as the last commit it passed on (with the same
spec), and the skip counts as a pass for jobs that need it; gm's Rust work is a
`cli` job with `paths: [apps/cli]`. With `on.push.coalesce_after: N` runs in
flight on a branch, a push's run is held; when one finishes, the newest held run
starts and covers the older ones (`covered_by`), and `gm runs wait` follows the
covering run.

## Personas (dev sign-in)

Development data (the personas below, Orbit Labs, the owner account) lives in
`seed/`, applied by `vp run db:seed` and the agent harness as local-only
migrations; deploys apply `migrations/` alone.

Picking a persona in development sets a cookie holding the account id. Production
rejects persona cookies and dev sign-in/token/seed endpoints; this mechanism is
not production authentication. Isolated environments require a private capability
for headless bootstrap. Always use a separate browser context for each environment.

| Persona    | Access                                                         |
| ---------- | -------------------------------------------------------------- |
| Priya      | Site admin: admin everywhere                                   |
| Marco      | Owner of the Orbit Labs org: admin on its repos                |
| Jun        | Orbit member (read), plus write collaborator on `orbit/engine` |
| Sam        | Read collaborator on `orbit/engine`; owns private `sam/notes`  |
| Francois   | hello@fward.me: superuser, also signs in by email code         |
| Signed out | Public repos, read only                                        |

Roles add up: public → read, org member → the org's base role, collaborator →
their role, owner/org owner/site admin → admin (`worker/permissions.ts`).
Repos you can't read return 404, never 403.

## Git over HTTPS

From the source worktree, use its scoped client:

```bash
vp run agent gm -- auth status
vp run agent gm -- clone orbit/engine
```

The clone belongs to the environment's external disposable workspace. Pass its
printed path with `vp run agent gm -- -C <clone> ...` for subsequent commands.
The harness keeps personal tokens and Git configuration out of the user's global
credential store. Browser-created **Access tokens** remain usable as an HTTPS
password by ordinary Git clients.

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
gm auth login                   # in the browser (or --persona priya in dev), to register a key
gm auth ssh-key add             # first key in your agent or ~/.ssh; --key to pick
gm auth login --ssh             # from now on gm signs in with the key
```

## Headless API

Every `/api` route accepts `Authorization: Bearer gmx_…` in place of the browser's
persona cookie; read-scoped tokens can only `GET`.

```bash
# From the source worktree, with agent up running:
vp run agent gm -- repo list
```

For direct HTTP clients, use the environment's printed origin and a scoped token;
never substitute the canonical server. `/api/dev/tokens`, `/api/dev/seed` and
`/api/dev/environment` require the harness capability in isolated environments.

| Route                                                                                     | Does                                                              |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `POST /api/dev/tokens` `{persona, scope?, name?}`                                         | Mint a dev token; capability required in isolated environments    |
| `POST /api/dev/seed`                                                                      | Reconcile empty sample repositories (dev only)                    |
| `GET /api/session`                                                                        | Who the token or cookie belongs to                                |
| `GET /api/personas`, `GET /api/users`, `GET /api/accounts/:slug`                          | People and orgs                                                   |
| `GET /api/search?q=&categories=&limit=&cursor=`                                           | Global search: see [Global search](#global-search)                |
| `GET /api/repos`, `POST /api/repos` `{owner, name, visibility, description?, importUrl?}` | List, create or import                                            |
| `GET\|PATCH\|DELETE /api/repos/:owner/:name`                                              | Detail with branches and tags, update, delete                     |
| `GET /api/repos/:owner/:name/tree?ref=&path=`                                             | Folder listing, latest commit, README                             |
| `GET /api/repos/:owner/:name/blob?ref=&path=`                                             | File contents                                                     |
| `GET /api/repos/:owner/:name/commits?ref=&page=`                                          | History, 30 per page                                              |
| `GET /api/repos/:owner/:name/semantic?ref=&cursor=&limit=&path=&kind=&language=`          | Individual syntax changes with source links and analysis coverage |
| `GET\|PUT\|DELETE /api/repos/:owner/:name/collaborators[/:user]` `{role}`                 | Manage access (admin)                                             |
| `GET\|POST /api/tokens`, `DELETE /api/tokens/:id`                                         | Your tokens                                                       |
| `POST\|DELETE /api/session` `{accountId}`                                                 | Browser persona cookie; DELETE also ends an email sign-in         |
| `/api/identity/*`                                                                         | Better Auth: email codes, device login (`/device/*`)              |
| `POST /api/tokens/device` (Bearer: device session)                                        | Trade a one-time device session for a gm token                    |
| `GET\|POST /api/invites`, `DELETE /api/invites/:email`                                    | Invitations (site admins)                                         |

## Global search

**The palette** (CORE-94): press **⌘K** (Mac) or **Ctrl+K**, or the magnifying
glass in the rail (the top bar on phones), from any page but sign-in. Type to
filter; **↑/↓** choose, **Enter** opens, **Esc** closes and returns focus to where
you were. It lists, in labelled groups:

- **In owner/name**: the current repository's sections (the same list as its tabs);
- **Go to**: the app's places (tracker, Needs you, packages, settings…);
- **Actions**: things to do, such as opening the assistant, and **Create issue
  in …** for each tracker you can use (the current one first);
- **Repositories**, **Issues**, **Packages**, **People and organizations**,
  **Conversations**: from `/api/search` as you type (debounced; signed-in
  only). Issues show their key, status and tracker; packages their format and
  owner; choosing a conversation reopens it in the assistant.

- **Or**: fallbacks that act on what you typed, such as **Create issue “…”**,
  which proposes the text as a title in the current tracker (else the one
  `/tracker` opens, else your own; the hint names it). Fallbacks come last and
  are never selected by default, so Enter on a search opens a result. **Ask
  Gitmatrix “…”** (CORE-96) submits the text to the assistant in a new
  conversation and opens it; it's the only palette action that reaches a model,
  and only when chosen: typing, highlighting or closing sends nothing.

Create issue never creates anything itself: it opens the tracker's own
creator (CORE-95), which keeps its validation, drafts and same-operation
retries. The handoff is a one-shot intent in router state
(`src/palette/intents.ts`), so the title never appears in a URL, and the
tracker clears it as soon as it opens the creator, so back and refresh don't
reopen it. A title proposed this way leaves the capture box's draft alone.

Ask goes through the assistant's own provider (`ask()` in
`src/assistant/state.tsx`): one step mints the new chat and queues the prompt
addressed to it (`src/assistant/queue.ts`), and only that chat takes it, once,
after its own connection is up, so it can't land in the conversation that was on
screen, double-send on a re-render, or vanish into a socket a remount closed. The
earlier conversation keeps its history, pending approvals and unsent draft
(drafts are kept per conversation for the tab). Choosing a **Conversations**
search result reopens that chat without sending anything. While the palette
animates closed it ignores keys, so a quick second Enter can't run an option twice.

Local groups answer at once and keep working while remote ones load or fail;
a category that can't be searched says so instead of looking empty. Selection
follows the option you picked, so results arriving never move it, and only the
newest query's answer is ever shown. Signed out, the palette only navigates.
While it's open, page shortcuts (⌘J, tracker keys) don't fire. Code lives in
`src/palette/`: `commands.ts` is the typed catalog of pages and actions (a new
action adds a `CommandSource`), `selection.ts` and `remote.ts` hold the
selection and race rules, with tests in `palette.test.ts`.

`GET /api/search` (CORE-91) is the lookup behind the global palette: plain,
permission-aware matching over names and titles, never inference, embeddings or
AI Search. The contract is `shared/search.ts`; each category is a provider in
`worker/search/providers.ts` (packages in `worker/search/packages.ts`).

| Category        | Matches                                                                     | Leads to                        |
| --------------- | --------------------------------------------------------------------------- | ------------------------------- |
| `repositories`  | `owner/name` and description, readable repos only                           | `/owner/name`                   |
| `issues`        | Key, title and description, open and closed, in every tracker you belong to | `/tracker/owner/issues/id`      |
| `packages`      | `owner/name`, name and format, in feeds the registry lets you read          | `/owner/-/packages/format/name` |
| `accounts`      | Slug and display name; every profile is public                              | `/slug`                         |
| `conversations` | Titles of the viewer's own assistant chats, all of them                     | the chat (`{kind: "chat"}`)     |

- **Signed in only.** `q` is trimmed and whitespace collapsed: 1–100
  characters, at most 6 words, each of which must match. Empty, oversized or
  malformed requests get 400; nothing enumerates a directory.
- **Ranking.** `exact` (an identifier equals the query: `owner/name`, a repo
  name, a slug, a title), then `prefix`, `word` (a word in a name starts with
  it; `-`, `_`, `.` and `/` separate words) and `contains`; ties go to the most
  recently pushed or updated, then name, then ID. Every result says its `match`.
- **Authorization first.** Repositories are filtered in SQL by `readableRepo`
  (`worker/db.ts`, held to `permissions.ts` by the tests) before ranking,
  limits or cursors, so private repositories and other people's chats never
  reach a row, an order or a page. Responses are `private, no-store`; there is
  no server cache, so revoked access applies at once.
- **Bounds and continuation.** `categories` is a comma list (default: all, in
  the order above); `limit` is 1–20 per category (default 5). A group's
  `cursor` continues that category: pass it back with the same `q` and that
  category alone. Continuation stops at 100 results per category; past that a
  group reports `truncated: true` and no cursor, so narrow the query. There are
  no totals.
- **Issues across trackers.** Each tracker's Durable Object ranks its own
  issues in SQL (`TrackerStore.searchIssues`: exact key, then title prefix and
  words, then description; ties by priority, most recently updated, ID) and the
  provider merges them. Only trackers from `accessible()` are asked, so losing
  membership removes their issues at once; keys repeat across trackers, so
  each result carries its tracker. At most 25 trackers (yours first) are read,
  6 at a time; when some fail or are past that bound the group stays `ok` but
  sets `incomplete` to what was missed, and only when every tracker fails is it
  `unavailable`.
- **Packages from the registry's rules.** The provider builds the registry's
  own `Services` from the request, so it authenticates exactly as
  `/api/packages` does (cookies, tokens, CI job tokens), keeps only feeds
  `AccessControl.can(feed, "read")` allows (visibility, owner roles, repository
  collaborators, source-derived job grants), and matches packages in SQL only
  inside those feeds. Owner, format and name together identify a result, so
  equal names in other owners or formats stay distinct; ties go to name,
  format, owner, ID. Publication history and artifact contents aren't searched.
- **Failures stay local.** A category that throws or takes over 5 seconds
  comes back `{status: "unavailable", error}`, which is not "no matches", and
  the other groups are unaffected.

## Semantic changes

The repository **Changes** tab (`/:owner/:repo/changes`) is a functional
work-in-progress feed of individual changes, not commit rows. Each entry links
to its originating commit and before/after source lines, with syntax-highlighted
excerpts. Ref, exact-path, change-kind and language filters are independent of
the existing Code and Commits views; ordinary Git diffs remain unchanged.
Final UI design and polish are intentionally separate work.

The shared engine in `shared/semantic/` supports TypeScript/TSX, Rust, Python,
Go, Markdown, XML, JSON, HTML and CSS:

- Programming adapters extract declarations, signatures, parameters, calls,
  arguments and imports. Unique same-scope declaration shapes permit conservative
  rename pairing; ambiguous matches remain additions/removals.
- Document adapters extract Markdown sections/links, JSON properties and array
  positions, XML/HTML elements/attributes/text, and CSS rules/declarations.
- Changes carry `evidence: "syntax"`: these are parser-backed facts, not resolved
  types, cross-file symbol identity, macro expansion, runtime effects or inferred
  author intent. Parent and child changes can both appear.

The repository file view uses those same grammars and the Changes tab's shared
token renderer in both themes. Source appears immediately as selectable plain
text; a dedicated Web Worker applies syntax colors without parsing on the UI
thread. Source text selection and the knowledge rail remain available.
Highlighting is limited to 256 KiB of UTF-8 source. Unknown extensions,
truncated/oversized files and unavailable or failed workers retain plain text;
binary files retain the existing not-shown notice. Navigation cancels the worker,
stale results cannot color another file, and a five-second watchdog terminates
unfinished worker loading/parsing. The worker uses only the syntax tree, not
semantic fact extraction.

Click a line number to select it; Shift-click another to extend the range in
either direction. On touch screens, choose **Extend range**, then tap the other
endpoint. Line-number links remain keyboard-focusable (Enter selects a line;
Shift+Enter extends). Selection replaces the current history entry and uses
`#L12` or `#L12-L20`; opening either form highlights and scrolls to the selection
after client-side rendering. Invalid anchors are ignored; ranges extending past
the visible source are bounded to its last line.

The file header stays visible while scrolling, flush with the top of the
viewport (below the bar on phones). **Copy link** and **Copy permalink** are
always there: without a selection they link to the file, with one to its lines.
**Copy link** shares the current branch/tag/ref; **Copy permalink** pins the same
file and lines to the exact commit used to load the displayed source, not a newer
branch tip. The blob API returns that SHA as `BlobResponse.commitOid`. A
**Permalink** button also sits on the selection's first line, `Y` copies the
permalink from anywhere on the page, and `Esc` (or **Clear**) drops the
selection. Successful copies show a toast naming what was linked; denied
clipboard access shows an error rather than claiming the copy succeeded.

### API and pagination

`GET /api/repos/:owner/:name/semantic` returns the versioned
`SemanticFeedResponse` from `shared/semantic/types.ts`: `entries`, immutable
`head`, `nextCursor`, and separate file-analysis `coverage`. Kinds use
`<entity>.added|removed|changed|renamed`, plus `symbol.signature_changed`.
Source positions are one-based line/column coordinates with UTF-16 columns;
highlight token offsets are relative to the excerpt.

History follows the first parent; merge changes are compared with that parent.
The default limit is 30 entries (maximum 100), not commits. An opaque cursor
pins the head, repository, ref, filters and analysis version. Keep ref/filters
unchanged when continuing. Empty pages can have a `nextCursor` because scanning
is bounded: continue until the cursor is null, not until `entries` is empty.
Changing filters starts a new scan. File moves are not inferred across paths.

Per-page scan budgets are 12 commits, 24 tree reads, 8 changed files and 512
traversal steps. Unchanged trees are skipped. Sources are limited to 256 KiB,
10,000 extracted facts and 8,000 characters per excerpt. Large directories,
excessive nesting, binary content, unsupported files and parser failures have
explicit coverage diagnostics, never invented semantic results. Coverage is
independent of kind/language filters. Ordinary blob/diff access remains available.

Analysis is derived on demand and cached by repository, analysis version,
commit, path and blob pair; no schema migration or background index is required.
Repository authorization precedes analysis-cache access. Feed responses are
private/no-store.
Git object, ref and upstream-token caches share only completed data across
requests. Pending object loads stay reader-local so a closed request cannot
cancel another request's cached read.

### Extending the adapters

1. Implement `LanguageAdapter` in `shared/semantic/types.ts`: declare the language
   and extensions, expose its `parser: Parser` for syntax-only highlighting, and
   implement `parse()` to produce a Lezer tree, `SyntaxFact[]` and diagnostics.
   Register the adapter in `shared/semantic/index.ts`; the file viewer discovers
   its extensions automatically.
2. Give each fact a stable scope-local key and actual UTF-16 source offsets.
   Normalize insignificant syntax without changing strings or meaningful text.
   Use `signature` for declaration headers; supply `shape` only when conservative
   name-independent rename matching is justified. Report parser errors rather
   than guessing through invalid syntax.
3. Extend the language union and web filter list for a new language. Add exact
   before/after fixtures under `shared/semantic/fixtures/`, including ambiguity,
   formatting, meaningful whitespace and malformed source. Existing adapter tests
   and the real server/CLI smoke consume these fixtures.
4. Bump `ANALYSIS_VERSION` when extraction/comparison semantics change so cached
   analyses and continuation cursors cannot mix versions.

Lezer's pure-JavaScript parsers run inside Workers without native processes.
Language servers are appropriate for workspace-aware type/reference resolution,
but require project files, dependencies and a separate process host; this Worker
does not pretend to run them or label syntax evidence as LSP results. Lezer
grammars are not full compiler frontends: the current JavaScript grammar rejects
shorthand destructuring defaults such as `const {x = fallback} = source`, the Go
grammar has method-expression/type-argument limitations, and Rust macros remain
token trees. Rejected grammar forms are reported as `parse_error`.

### Isolated end-to-end smoke

Use the root [agent-first workflow](../../README.md#agent-first-development):
run `vp run agent setup`, keep `vp run agent up` running in another terminal,
then run `vp run semantic-smoke` from the repository root.

The smoke validates the scoped server identity and uses the harness's `agent gm`
wrapper, compiled binary, credentials and external disposable workspace. It creates
one uniquely named private repository in the environment's own Artifacts namespace,
pushes before/after fixtures for every supported language, and verifies actual
API/CLI entries, filters, pagination, source links, private access and ordinary
diff/blob/history behavior. Cleanup deletes only that repository and clone; it
never resets the environment, changes global credentials or uses canonical dev
resources. Missing setup or a stopped environment is an error, not a fallback.

For browser inspection, run
`SEMANTIC_SMOKE_KEEP=1 node apps/website/scripts/semantic-smoke.ts` directly
from the root so the environment flag reaches the script. Use a fresh browser
context, sign in as Priya, and open the printed URL. Send SIGINT or SIGTERM to the
printed smoke PID when finished; it removes the disposable repository and clone
without stopping the agent server. Use `vp run agent destroy` when the worktree's
environment is no longer needed. Run `vp run ready` for the complete uncached
quality and real-service E2E gate in addition to this semantic-specific smoke.

## Distributed issue tracker

Open `/tracker` from the global navigation. Select an account, create a team,
and capture a title-only issue with **Create**. For more context up front, choose
**Add details**: the dialog carries over the title, selected team and current
workspace scope, and lets you set a Markdown description, type, status, priority,
assignee and workspaces. **Create and edit** saves the issue and immediately
opens the existing editor for acceptance criteria, labels and relationships,
including from the blocker graph. Rejected submissions keep the draft; an
unconfirmed submission stays open with an idempotent retry rather than creating
another issue.

The workbench keeps the list, board or blocker graph beside the selected issue;
phones navigate from the list into detail. Expand a ticket into a Markdown PRD,
acceptance criteria, parent/child plan, dependencies and durable comments, agent
checkpoints or evidence.

The search bar's **Clear search** (×) button clears both typed text and applied
query filters immediately, shows all issues, and returns focus to the input.
It preserves the selected layout and sort, and the empty query survives reload.
The button disappears when both the input and applied query are empty.

Use **Close issue** when work will not be completed. Choose Duplicate, Not planned,
No longer needed, Cannot reproduce, or Other, then **Confirm close**. This saves
the issue as `canceled`, not `done`; the selected reason stays visible after reload.
Creating or editing an issue into Canceled also requires a reason. **Reopen**
returns it to To do and clears its current reason; the event history retains the
earlier closure. Historical cancellations without a reason remain editable.
The API uses `issue.update` with `status: "canceled"` and `closeReason` set to
`duplicate`, `not_planned`, `obsolete`, `cannot_reproduce`, or `other`.
Existing version and lease checks still apply. Closing does not complete
subtasks or satisfy dependent issues' blockers.

**Timeline** (in the create form and the editor) tells agents whether to work an
issue in a timeline: Agent decides (the default), Required or Never. Required can
name the policy the timeline must use, Auto or Approval. The API stores it as
`timelineUse` (`agent_decides`, `required`, `never`) and `timelinePolicy` (`auto`,
`approval` or null, allowed only with `required`); issues from before the field
read as `agent_decides`.

- **Ownership:** a personal account or organization owns each tracker. An issue
  has one team and zero or more cross-team workspaces. Team prefixes and workspace
  slugs are permanent; archival preserves history.
- **Repository subscriptions:** any number of repositories can subscribe to any
  number of workspaces. The repository's **Issues** tab previews ready issues
  only from trackers the viewer already belongs to. A subscription grants neither
  tracker membership nor repository access. Managing one requires both tracker
  ownership and repository administration. After a repository is deleted, its
  tracker owner can remove the orphan association.
- **Permissions:** account members can read the tracker. Owners administer teams,
  workspaces and subscriptions. A nonempty team membership list restricts issue
  writes and assignees; an empty list permits all current account members. A site
  administrator is not automatically a member of every tracker.
  Team membership edits check an assigned agent's accountable person, not the
  agent ID: retaining that person permits renaming the team, while removing them
  from a restricted team requires reassigning their agents' issues first.
- **Graph:** `FROM blocks TO`; only `done` satisfies a blocker. Canceling a
  prerequisite does not silently unblock its dependents. Parent hierarchy is
  separate and does not imply blocking. Both blocker and parent cycles are rejected.
  The relationship view starts at the leftmost occupied dependency column rather
  than reserving space for missing steps. Blockers remain left of the selected
  issue and dependents right; phones stack the selected issue first.
  Live dependency and issue-state edits refresh connector positions and styling
  without requiring a focus change or a resize.
- **Coordination:** ready work is unblocked, unclaimed `todo` (or an expired
  claimed `in_progress` issue) with no open sub-issues, no other active lease
  above it, and nothing waiting on a person (`readiness` in `shared/tracker.ts`,
  mirrored by gm). Exclusive claims require an online transaction. Renew,
  release and complete require the unexpired fencing token; completion also
  records evidence, rechecks blockers and refuses parents with open sub-issues.
  Tokens never appear in public snapshots or event feeds.
  Granting a lease also assigns an unassigned issue to its holder's identity in
  the same transaction and audit event. Delegated claims use the receiving
  agent, not the delegator or session label. Existing assignees are preserved,
  including on renewal, handoff and takeover; ending a lease does not clear assignment.
  Lease grants use the same assignee validation as issue edits: the assignee
  (or an agent's accountable person) must be an account member and belong to any
  restricted owning team. Admin write access does not waive this requirement.
  Invalid assignments reject the claim atomically without changing the issue or lease.
- **Graph engineering (CORE-4):** agents work through issue graphs on their own.
  - _Agents_ are identities a person creates (Settings > Agents, `gm agent`); they
    act with their person's access but everything is attributed to the agent, and
    every mention names the accountable person ("builder for Ann Lee").
  - _Capability profiles (CORE-33)_ extend those identities with self-reported
    harness/model, OS/architecture, runtime, CPU/memory, tags and installed skill
    metadata. `gm agent detect` observes locally; `configure [NAME]` publishes;
    `show [NAME]` and `list --owner OWNER` expose profiles for human/agent choice.
    Tracker snapshots include member-accountable agents' capabilities, report
    timestamps and revocation state, but never their tokens. Capabilities do not
    alter membership, assignment or lease authorization.
    `GET /api/agents/:id` (`self` for an agent token) reads an owned profile;
    `PUT /api/agents/:id/capabilities` replaces its version-1 report. An agent's
    write token may update only itself; read tokens cannot update profiles.
    People can create an identity with capabilities through `POST /api/agents`.
    Strict bounded reports reject unknown fields; old identities retain null
    capabilities. Apply migration `0016_agent_capabilities.sql` before deploying.
    See the [CLI profile workflow](../cli/README.md#agent-capability-profiles)
    for detection limits, declaration replacement and privacy.
  - `issue.next` (`gm issue next`) picks and claims in one step: priority, then
    the most open work transitively unblocked, then age; it skips PRDs and other
    people's assignments.
  - _A lease covers its subtree._ Claiming a parent (allowed even with open
    sub-issues, which are never offered as work themselves) excludes everyone else
    below it; status and parent changes there need the covering token. The holder
    delegates child leases with that token (`underToken`, optionally `forActorId`
    for one of its agents) and any lease above a claim can revoke it.
  - _Waiting on a person_ sits beside status: `request.open` asks a question,
    approval, decision or credential, routed to the asker's accountable person.
    Asking with the lease token parks it (no expiry); the last answer unparks it
    for an hour for its holder to `issue.resume` with a fresh token. Only people
    answer, on Needs you (`/needs-you`, `GET /api/requests`), on the issue, or
    with `gm request`. Credentials go to the named repository secret; the tracker
    records only where.
  - _Handoff:_ `issue.offer` returns a single-use code bound to the current
    lease token; `issue.accept` moves the lease (and its accountability) with a
    fresh token and fences the giver's at that moment.
  - _Owner override:_ when a claim's holder won't finish (a lost session, a
    deleted token, a stuck agent), a tracker owner acting as themselves (not
    through an agent token) can take it over with `issue.claim {force: true}`
    (`gm issue claim KEY --force`), getting a fresh token, or end it with
    `issue.release {force: true}` (`gm issue release KEY --force`, or End claim
    on the issue page), returning it to todo. The holder's token stops working,
    the issue gets a comment naming the claim that was overridden, and it
    doesn't count as the holder's failed attempt.
  - _Escalation:_ releases without completion count as attempts; at the team's
    `attemptLimit` (default 3, 0 off) the issue asks its accountable person what
    to do differently, with the latest checkpoints, and waits until answered.
- **Distribution:** each account has one `TRACKER` SQLite Durable Object authority.
  Atomic batches, actor/payload-bound operation receipts, version checks and an
  ordered event cursor synchronize private CLI replicas. Lost acknowledgements
  replay the same operation; conflicts preserve local intent for explicit
  resolution. This is not Git-based issue storage. See the
  [offline CLI and agent workflow](../cli/README.md#distributed-issue-tracker).
- **Human workbench:** closed work is hidden by default; readiness, team and
  workspace filters stay in the URL. Desktop collection/detail panes scroll
  independently; mobile filters and account actions are disclosed on demand.
  Closed board lanes retain their counts and expand to show closed issues.
  Add subtasks from the parent without leaving it; only active workspaces are
  inherited. Checkpoints, claims, blockers and completion evidence remain distinct.
- **Creator and audit:** issue details show **Created by** and the creation time
  without opening history. Expand **Audit history** for newest-first events,
  including comments, requests, relations and parent changes. Each entry shows
  the actor (and an agent's accountable person), timestamp, client-reported source,
  operation ID and field changes; **Full event details** exposes the complete
  sanitized event. **Load older events** pages through the history. History loads
  only while expanded, refreshes when the snapshot cursor advances, and resets
  on issue/account changes. Activity & handoff remains the comments workspace.
  Legacy attribution/source gaps are labeled unknown; current-directory identity
  resolution is labeled separately from mutation-time snapshots.
- **Startup defaults:** in **Account menu → Preferences → Default view and team**, choose
  List/Board/Graph, an issue-view preset, and an active team or all teams.
  Defaults are saved on the server per person and per tracker, so they follow
  you across browsers and devices, and each tracker keeps its own. Saving also
  makes this tracker the destination of the global **Issues** link. A default
  saved by an older version in this browser is carried over once, on the next
  visit. The chosen team filters the initial view and supplies the new-issue
  team. Explicit URL filters, layouts and capture teams override defaults,
  including an empty query. Unavailable trackers fall back to the first
  accessible tracker; archived or unavailable default teams fall back to all
  teams. **Reset defaults** restores the built-in startup behavior.
- **Keyboard shortcuts:** enable them in **Account menu → Preferences**. This
  opt-in applies only to the current browser: `c`/`n` captures an issue, `/`
  filters, `j`/`k` moves between issues, and Escape closes the issue.
- **Tracker administration:** the **Settings** gear at the bottom of the
  navigation rail opens **Teams and workspaces** for the current tracker, or
  your default tracker when outside a tracker. Manage teams, workspaces and
  repository subscriptions there; existing permissions still apply. **Back
  to issues** returns to the current filters and layout.
- **Default team in one click:** the star next to each team in the facet
  column makes it your default; the filled star marks the current one, and
  clicking it clears the default. Under the query bar a note names the default
  team, says that gm and your agents use it too, and offers **Show all teams**
  and **Change**; quick capture marks it with ★. Without a default, quick
  capture picks your only team, else the team you or your agents last filed
  into, else the first open team.
- **gm uses your default team** when nothing more specific names one. Most
  specific first: `--team` (or `--all-teams`), this checkout's
  `.gitmatrix/agent.local.yml`, the project's `.gitmatrix/agents.yml`, your
  default team, then all teams. `gm issue next`, `create`, `list` and `ready`
  report the team they used and why in `team`; `gm tracker status` shows
  `defaultTeam`. Agents read their person's default but can't change it, and a
  `next` scoped to a workspace or parent doesn't add it.
- **Inline editing:** click an issue title or its description/acceptance text to
  edit just that field in place. Each text section also has a keyboard-accessible
  **Edit** button, and empty sections offer an **Add** action. Markdown preview
  remains available; links in rendered Markdown still navigate normally.
  Leaving an inline title, description, or acceptance editor returns it to read-only
  display after the save is confirmed, with a nearby **Updated** check for four
  seconds. Unchanged fields close without claiming an update; failed saves keep
  their editor and draft. Preview controls remain usable, and refocusing during a
  pending save keeps editing active without losing newer text. The complete
  **Edit issue** form stays open while moving between fields.
  Text fields (including labels) save on blur; selects, the parent picker, and
  workspace checkboxes save immediately. Saves are serialized, preserving edits
  made while an earlier request is running. The editor shows Saving, Saved, or
  an error with retry/discard controls; closing an issue waits for a close reason.
  **Discard unsaved changes** closes the draft without autosaving the focused
  field; previously saved values remain unchanged.
  **Done**, **Ctrl/Cmd+Enter**, or **Esc** saves remaining changes and finishes
  editing; Enter does the same in a title. Navigation waits for pending edits to
  save, and unsaved drafts survive a reload in the same tab. **Edit issue** (or
  `e`) and **Create and edit** open the complete autosaving form. Issue creation,
  comments, and new relationships retain explicit submit actions.
  A confirmed save applies the server's committed entities immediately; the
  whole-tracker refresh runs in the background and cannot replace a newer
  acknowledgement with an older snapshot. Rendered descriptions and acceptance
  criteria stay mounted while editing, avoiding a full Markdown rebuild when
  finishing unchanged text or saving other fields on a large issue.
- **Browser conflicts:** drafts persist for the tab session. Review named fields,
  choose individual remote values, then explicitly rebase; untouched remote
  fields are retained. Labels and workspace membership compare as sets, so
  reordering does not overwrite another person's changes. Errors remain beside
  the failed action. An uncertain write freezes mutation fields and retries its
  original operation ID; confirmation acknowledges the original save without duplicates.
- **Keyboard:** single-key shortcuts are off by default; enable or disable them
  through **Shortcuts** in the account actions. The preference persists locally.
  `c` or `n` focuses capture, `/` focuses search, `j`/`k` selects adjacent issues,
  and `e` edits the selected issue. Shortcuts do not run while typing or interacting
  with form controls. The enabled legend lists the available keys.

| Route                                                             | Contract                                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /api/tracker`                                                | Trackers accessible to the authenticated account                                                        |
| `GET /api/tracker/:owner/snapshot`                                | Complete authorized replica snapshot and cursor                                                         |
| `GET /api/tracker/:owner/changes?after=N&limit=200`               | Ordered event page; resume from the returned cursor                                                     |
| `…/snapshot?timelines=1`, `…/changes?…&timelines=1`               | Also timelines and their events (entity types `timeline`, `timelineEvent`), for replicas that know them |
| `GET /api/tracker/:owner/issues/:issue/history?before=N&limit=50` | Authorized issue audit; ID or key, newest first, exclusive cursor, default 50 / maximum 100 events      |
| `POST /api/tracker/:owner/mutate`                                 | `{operationId, mutations:[{kind,id,expectedVersion?,data?}]}`; 1–100 ordered operations, all or nothing |
| `GET /api/repos/:owner/:name/tracker`                             | Accessible subscribed workspaces for repository navigation                                              |

Updates require the version last read; stale writes return `409 version_conflict`
with current state. Issue IDs are stable client-generated identifiers; the authority
assigns readable keys such as `ENG-42`. Mutation bodies are limited to 1 MiB.
Tracker mutation clients declare `X-Gitmatrix-Source: web|cli|api|assistant`;
the browser sends `web`. This is a provenance hint, never authentication.
History retains immutable actor snapshots and before/after state, excludes
lease and credential secrets, and requires the same tracker membership as snapshots.
`shared/tracker.ts` defines the wire types; `gm schema issue batch` exposes the
CLI contract. No new D1 migration is needed: the Durable Object initializes its
own schema. Generate the new binding with `cf workers types`.

These primitives support durable agent handoffs. An autonomous hours/days-long
execution loop is not included.

### Timelines

A timeline (`TIMELINES-RESEARCH.md`) is an account-wide line of work with a
bookmark `timeline/<slug>` in each repository it touches. Records and their
events live in the tracker's Durable Object, beside the issues and leases that
landing and abandoning will change with them. Every change to either is also
logged in the tracker's event log, which the snapshot and change feed include
only with `timelines=1`, because older gm binaries fail on entity types they
don't know (gm now skips them). gm asks for timelines and keeps them in its
replica; `gm tracker status` lists them offline. `shared/timelines.ts` defines the
wire types.

| Route                                                   | Contract                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `GET /api/tracker/:owner/timelines?status=&stalled=`    | Every timeline, newest first; `stalled=true`: open, no push for the idle period, not experimental |
| `POST /api/tracker/:owner/timelines`                    | `{slug, name?, policy?, experimental?, parent?, repos?}`: write each bookmark, then the record    |
| `GET /api/tracker/:owner/timelines/:slug?after=&limit=` | The timeline and its events, oldest first; page on with `next`                                    |
| `PATCH /api/tracker/:owner/timelines/:slug`             | `{name?, experimental?, expectedVersion?}`                                                        |
| `POST /api/tracker/:owner/timelines/:slug/abandon`      | Record the abandon event with each bookmark's last commit, then delete the bookmarks              |
| `GET /api/tracker/:owner/timeline-graph`                | Every timeline, the newest 5,000 events across them, names and workspaces: the graph's data       |

- **Forking** needs tracker membership and write access to each repository,
  which must belong to the tracker's account. Each bookmark starts at the
  parent's bookmark in that repository, else the default branch's tip, unless
  `{repo, commit}` names a commit. The Worker writes bookmarks with a
  receive-pack request to Artifacts (ref commands and an empty pack); if any
  repository refuses, or the record can't be made, the bookmarks already
  written are removed.
- **The graph** (`/tracker/:owner/timelines`, linked from Issues and Release
  notes; CORE-81) draws main down the middle and a lane per timeline, newest
  first: forks, merges between timelines, landings on main, abandoned lanes
  ending with a mark and experimental lanes dashed. It centres on `?tl=<slug>`
  (the selection, its parents and what depends on it) or, with main selected,
  the ten most recently active timelines; landed timelines fold into one node
  on main, and the rest are listed by status, workspace, agent or person. The
  layout is in `src/routes/tracker/timelineGraph.ts`.
- **Experimental** (CORE-86) marks a timeline that isn't expected to land. It
  restricts nothing: any writer sets or clears it (the graph's inspector,
  `PATCH`, `gm timeline flag <slug> --experimental|--no-experimental`), its
  work merges like any other's, and it can still land. Views of stalled or
  idle work leave flagged timelines out, since stalling is expected of them
  (`isStalled` in `shared/timelines.ts`: active or idle, no push for the
  account's idle period, 7 days by default): the graph's Stalled filter, its
  status groups (quiet experiments are grouped apart), `?stalled=true` and
  `gm timeline list --stalled`.
- **Merges** are found after each push (`waitUntil`), from the push log: a
  commit on the pushed line's own first-parent chain whose other parent has
  been the tip of main or another timeline bookmark. Each is one event,
  listed in both sides' histories. Pushes also record the agents that worked
  in a timeline.
- **Abandoning** is for the timeline's accountable person, acting as
  themselves, and the agent that started it. Abandoning again retries the
  bookmarks still there and records nothing new.

**Views.** Issues have a view per timeline, projected from the one event log
(`worker/tracker/views.ts`). A mutation request with `timeline: <slug>` is
made in that timeline: its events carry `timelineId` and `view` (the entity
as the timeline saw it, before and after), and issues it creates record
`timelineId`. Main's view is the store's tables, as before: an event's
`before`/`entity` stay main's, so in a timeline main's copy changes only
shared fields (version, claim, assignee, waiting), and something only a
timeline has is absent (`entity: null`). A timeline's view
(`GET …/snapshot?timeline=<slug>`, `?tl=<slug>` in the web app, `--timeline`
or `GM_TIMELINE` in gm) is main's with the scoped fields (title, description,
acceptance, type, status, close reason, priority, parent, workspaces, labels)
and the links and comments of the timeline, its ancestors and the timelines
merged into them replayed on top in event order. `issue.next` in a timeline
picks from its view. Landing folds a timeline into main's tables as
`timeline.land` events (`TrackerStore.landTimeline`, for CORE-77 to call when it
marks the timeline landed); views then leave landed timelines out. Ended
timelines take no changes.

**Done in a timeline** (CORE-74). An issue whose status becomes `done` in a
timeline's view is done there, and in the views that include that timeline
(its descendants, and timelines it merges into). Elsewhere, main included, its
status is `done_in_timeline` with `doneIn: {id, slug}` (a shared field, like the
lease): it keeps blocking, isn't ready, and stays in `is:open`. The status is
locked wherever it shows: updates that change it, claims, completion and
release fail with `done_in_timeline` ("… is done in timeline `<slug>`; it lands
with the timeline, or reopen it there with --timeline `<slug>`"), while other
fields stay editable. Only the tracker moves it: a reopen inside the timeline,
a merge between timelines (`doneIn` moves to the timeline merged into, as
`timeline.merge` events), landing (done), and abandoning (`todo` again, leases
released, a note linking the abandoned timeline on each, unless a live
timeline that merged into it still has the work done). The web marks it with
its own icon (a branch ending in a done check, in landing green), disables the
status picker with a link to the issue in the timeline (`?tl=<slug>`), and
lists a timeline's issues in the graph's inspector (`issues` in
`GET …/timelines/:slug` and the graph's data); `gm issue show` and
`gm timeline show` say the same, and gm refuses the same changes before
queueing them. Older gm binaries treat the status as data: not ready, still
blocking.

**Ended timelines stay readable.** A landed or abandoned timeline's view
(`?tl=<slug>`, `--timeline <slug>`) still loads, read-only, with a banner that
says how it ended; changes made in it fail with `timeline_ended`. Its own
issues are left alone when it is abandoned, and its issue list keeps the
status each had in it, even after main's copies went back to do.

**The app-wide scope** (CORE-82, `src/lib/timelineScope.ts`). `?tl=<slug>`
scopes every page to main plus that timeline; no `tl` is main, and `tl=main`
names main explicitly, which is how a link leaves a timeline. The switcher in
the rail lists the account's timelines (the page's account, else the default
tracker's) and a banner above every page names the selected one and says what
the scope means there; from 640px it stays in view (`--scope-banner` offsets
page-level sticky elements and the tracker's height), and on phones the rail's
switcher carries a dot. Links carry the scope (`router.createHref` adds the
current `tl` to every href that names none), and so does every navigation, form
and redirect (a root middleware); going back, forward or reloading keeps what
the URL says. What each surface does with it:

- **Tracker**: the timeline's view (above); the timeline graph centres on it.
- **Code browser**: a repository and its history open on `timeline/<slug>` when
  the timeline touches it; a path that names a branch keeps it, and switching
  follows main's or the old bookmark to the new one.
- **CI**: runs on the bookmark (`GET …/ci?ref=`), and Run starts one there.
- **Packages**: the console's default query adds `branch:timeline/<slug>`.
- **Knowledge**: the timeline's overlay; the tab's old `?timeline=` is
  rewritten to `?tl=`.
- **Release notes** cover landed work: entries the timeline landed are marked,
  and `timeline:<slug>` (a Timelines facet) narrows to them.

A landed or abandoned timeline stays selectable: the shell banner says how it
ended and that its view is read-only, on the tracker and every other page.

## Release notes

Release notes are code-update history, not deployment records. The default view
groups the default branch's first-parent commits into **daily UTC digests**, using
Git committer timestamps. Neither authored dates nor tracker completion dates
decide which day a change belongs to. Tags remain optional named checkpoints;
successful CI alone is not treated as proof of deployment.

`GET /api/repos/:owner/:name/release-notes/range` still provides explicit Git
ranges and the tracker issues their commits mention (`shared/release-notes.ts`).
Without parameters it walks the default branch back to the nearest tagged commit;
`?to=<tag>` includes that tag's own commit, and `?from=<ref>` sets the base explicitly.
Ranges follow first-parent history and stop at 1,000 commits with `truncated: true`.

Issue keys (`TEAM-N`, e.g. `(CORE-13)` or `CORE-15:`) are parsed from commit
messages and resolved only through trackers that subscribe a workspace to the
repository and that the caller can read. Anonymous callers, non-members and
unsubscribed trackers get the commits without issues. Key-shaped words such as
`UTF-8` match no team and drop out. Each issue carries its team, completion time
(when it last became done) and evidence. The tracker also answers which issues
were completed in a time window, for team and organization views.

**Generated entries** (`worker/release-notes/generate.ts`) belong to a daily digest
(`@day:YYYY-MM-DD`) or a named tag snapshot. Colons cannot occur in Git tag names,
so the identifiers cannot collide. Daily digests cover the newest 1,000
default-branch first-parent commits, including tagged commits; empty days are not
stored. Commit dates need not follow ancestry order, so a day is a set of commits,
not a contiguous Git range. Digests outside the bounded walk drop out; truncation
is reported. Named snapshots retain the normal ten-tag regeneration window, and
previously generated older tags remain readable while those tags still exist.

An entry groups an issue's cited commits within that day or tag, or describes a
commit citing no resolved issue. The `fast` model writes its category (feature,
fix, improvement or internal), title and summary from the issue, evidence, commits
and semantic code changes; the `reason` model writes an introduction from the
non-internal entries. Prompts describe code changes without claiming deployment.
Entries retain their sources, model and inputs hash. Identical inputs reuse
existing output across days and tags; new or changed groups require generation.
Stale-entry cleanup compares persisted subjects with all current drafts, including
unfinished ones, then deletes stale IDs in batches of at most 90. Large daily
digests stay within D1's 100-parameter limit without losing pending entries.
Both summary and entry APIs expose `lastCommitAt`, the latest Git committer
timestamp in that group. Summary `kind` and entry `releaseKind` distinguish
`daily` from `tag`; tracker completion remains source evidence only.

Work runs on the `gitmatrix-jobs` queue: pushes, tracker changes to cited issues
and subscription changes mark the repository dirty and enqueue it after 20
seconds; a D1 lease allows one run per repository, and runs are capped at 40
model calls, continuing in a follow-up run. Server-side resolution uses the
repository owner's tracker plus subscriptions mirrored into
`tracker_repo_subscriptions` as they change. An introduction lists the trackers
whose issues shaped it, so readers without access to them can be shown entries
without it. Without AI bindings (automatic non-AI test environments) nothing is
scheduled.

**Stored-data upgrade** (migration 0020): repository and per-release format
versions keep legacy materialization hidden until it has been regenerated.
Reading a repository's index/detail or a related, accessible tracker feed
coalesces a lazy rebuild, including repositories with no new push after upgrade.
Previously stored older tags upgrade in batches of at most ten tag groups per
pass, within the same model-call budget; untouched historical tags are not
backfilled. Continuations finish the upgrade before publishing the new format.
Afterward, ordinary incremental updates preserve readable current-format
history while generation continues. Failed generation remains visible as a
failure and uses the existing queue retry path.

**Reading** (`worker/release-notes/read.ts`): the repository's **Releases** tab
separates daily updates from tags and defaults to the newest day with visible
entries (or the newest day if none has entries; tags are the fallback when no days
exist). It shows the selected group's introduction and entries as New, Fixed,
Improved and collapsed Internal, linking to issues and commits with model
provenance. Daily groups explicitly identify UTC commit dates, not Git ranges.
The page refreshes while generating. `gm release list` and `gm release notes`
are the CLI equivalents; `gm release notes day:2026-10-02` selects a UTC day.
Entries about issues from trackers the viewer can't read are omitted, and an introduction is
shown only to viewers who can read every tracker that shaped it.

| Route                                                       | Contract                                   |
| ----------------------------------------------------------- | ------------------------------------------ |
| `GET /api/repos/:owner/:name/release-notes`                 | `ReleaseNotesIndex`: status and releases   |
| `GET /api/repos/:owner/:name/release-notes/release?name=`   | `ReleaseNotesRelease`: intro and entries   |
| `GET /api/repos/:owner/:name/release-notes/range?to=&from=` | `ReleaseRangeResponse`: commits and issues |
| `GET /api/tracker/:owner/release-notes?q=`                  | `ReleaseFeed`: a tracker account's entries |

**Team and organization views** (`worker/release-notes/feed.ts`): a tracker
account's **Release notes** page (`/tracker/:owner/releases`, a place in the
navigation rail; `/release-notes` opens your default tracker's) defaults to daily changes in its repositories and changes citing
its teams' issues, ordered by `lastCommitAt` and grouped into UTC weeks. Named
tags do not duplicate entries in the default feed. An explicit `kind:tag` or
positive `release:` filter selects named snapshots when requested; `kind:daily`
selects daily history. An issue may have distinct updates on several days.
A team's notes use `team:KEY`. Other filters are `repo:` (name or owner/name),
`ws:`, `type:` (feature, fix, improvement, internal), `label:`,
`release:` (a literal tag or `day:YYYY-MM-DD`), `timeline:` (what landed with
`timeline/<slug>`), `since:`/`until:` (a date or `30d`,
`2w`, `12h`), search words, and `-` to exclude; unknown tokens are reported back.
Facets count the matching entries. It requires membership in the tracker
account, and also applies repository visibility and per-entry tracker access.
`gm release feed [QUERY] [--team KEY] [--owner OWNER]` is the CLI equivalent.

Real-provider coverage in `vp run agent test-ai` checks daily generation without
tags, a second commit on a different UTC committer date despite unchanged
authorship, retained earlier-day provenance, a named tag containing both changes,
and daily/tag tracker feeds without duplicate default entries. This is separate
from the non-AI readiness gate.

For the generator's local regressions, run
`vp test worker/release-notes/generate.test.ts` from `apps/website`, followed by
`vp check`. The suite covers large daily-group convergence, retention when the
model budget is exhausted, and stale-subject pruning within D1 binding limits.

## Knowledge graph and wiki

Every repository has a knowledge graph that stays current as it changes; the
wiki is one consumer of it (the Knowledge tab and `/api/repos/:o/:n/knowledge/*`
are others). Inspired by OpenDeepWiki, rebuilt around the graph and around
real-time incremental updates on Cloudflare.

AI behavior is verified on demand, not by automatic CI. Follow the repository's
[AI verification skill](../../.agents/skills/gitmatrix-ai-verification/SKILL.md)
and run `vp run agent test-ai` for real build/graph/wiki/Vectorize/AI Search evidence.
The isolated non-AI test mode omits provider bindings, suppresses background builds,
and rejects explicit rebuild/search with 503; production behavior is unchanged.

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
  hybrid keyword + semantic passage search with reranking. The reranker scores
  raw code far below prose about the same thing, so its cutoff alone hid source
  passages whenever the wiki or a README covered them; search keeps passages the
  reranker scores at 0.4 or more, then ones with vector similarity of 0.5 or more
  (`selectPassages` in `worker/knowledge/indexes.ts`).
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
- **Timeline overlays** (`worker/knowledge/overlay.ts`, CORE-83): every push to
  a `timeline/<slug>` bookmark recomputes that timeline's graph diff against
  main's indexed graph: the files it changed since its merge base with main,
  applied over main's snapshot, both graphs built from cached analyses with
  main's concepts and summaries, then diffed (`kg_overlays`,
  `kg_overlay_changes`; `GET …/knowledge/overlays` and
  `…/knowledge/overlay?ref=timeline/<slug>`; the Knowledge tab's timeline
  picker). Only blobs nothing has analyzed cost model calls, and they are cached
  for when the timeline lands; no alignment, synthesis, indexing or wiki runs,
  and main's graph, wiki and builds are untouched. A push that moves only
  timeline bookmarks starts no main build. One overlay per timeline (three per
  repository) runs at a time; main's next build recomputes them against it.
  When a bookmark disappears its last overlay is kept, read-only (CORE-139):
  `ended_reason` is `landed` or `abandoned` from the timeline's record in the
  tracker, or `ended` when the tracker did not say (rechecked for two days, on
  read). Ended overlays are never computed again, even if the bookmark is
  pushed again; only an `ended` one whose timeline the tracker still doesn't
  end comes back to life. The API reports them with `state: "ended"` and
  `ended: {reason, at}`; the Knowledge tab lists them under "Ended".

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
    if: branch == "main" # ==, !=, &&, ||, () over branch, trigger, commit, runner
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
  `gm runner --once` processes until the queue is empty (one at a time by default,
  or two in isolated agent environments; `GITMATRIX_CI_RUNNERS` overrides the
  limit at server startup). Nothing has to be left running; jobs
  queued while the dev server was down start when it comes back. Outside
  `vp dev`, `gm runner` still works by hand. `GITMATRIX_CI_RUNNER=sandbox vp dev`
  runs the container path locally with Docker. The choice is made in
  `cloudflare.config.ts`, which attaches the container only when sandboxed.
- **Local compiler reuse and evidence.** The local runner keeps Cargo outputs
  outside disposable checkouts, partitioned by server/repository/job and leased
  per concurrent job. Cargo checks freshness; every test command still executes.
  Explicit `CARGO_TARGET_DIR` keeps normal Cargo semantics and bypasses managed
  caching. `GITMATRIX_CI_ARTIFACTS_DIR` points to a private retained job directory;
  write only sanitized reports there. The harness retains allowlisted JSON, not
  credentials, raw logs or browser storage. Setup logs print cache/evidence paths.
  Checkout credentials are deleted before terminal reporting, on success or failure.
- **This repository's pipeline.** Check, test and build start independently on
  `standard-4` Sandboxes; all must pass. Non-AI E2E runs only where
  `runner == "local"` (it is too expensive per push), so `vp run ready` is its
  gate. No job consumes another's artifacts, and keeping them in one stage avoids
  a scheduler barrier. Real AI verification is an explicit agent command.
- **Both runners report the same way** (`worker/ci/jobs.ts`): batched log
  chunks, step transitions, the end. Secret values are masked server-side; a
  cancelled job is told so in the reply to its next report and kills its
  process group.
- **Agents** push, then `gm runs wait`: it blocks on the commit's run and exits
  non-zero with the failing job named; `gm runs logs --job <name>` has the output.

API: `/api/repos/:o/:n/ci` (runs, `?ref=<branch>` for one branch's, run detail,
logs with `?after=`, cancel, re-run, commit statuses, secrets) and
`/api/ci/runner` (claim, report).

### Deployments and previews

Gitmatrix deploys nothing (`TIMELINES-RESEARCH.md`, "Previews: primitives, not
hosting"): a job that deploys records where it went, and the run page and the
commit list show it. An environment is a name per repository: `production`,
`timeline/<slug>` for a timeline's previews, `branch/<name>` for any other
branch a job deploys from, or any name a project uses (`staging`). Records keep the environment, timeline, checkpoint, commit, URL,
status (`active`, `sleeping`, `expired`, `failed`), the run and job that
recorded them, the person and agent accountable, and an expiry. Expiring a
preview changes its status; the record stays. `shared/deployments.ts` defines
the wire types (`worker/deployments/`).

| Route                                                | Contract                                                                                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/repos/:o/:n/deployments`                   | Newest first; filters `environment`, `timeline`, `commit` (up to 80, comma-separated), `run`, `status`; pages with `before`, `limit` |
| `POST /api/repos/:o/:n/deployments`                  | `{url, commit?, environment?, timeline?, checkpoint?, status?, expiresAt?}`                                                          |
| `GET`, `PATCH /api/repos/:o/:n/deployments/:id`      | One record; `PATCH {status?, url?, expiresAt?}`                                                                                      |
| `GET /api/repos/:o/:n/environments`                  | `production` and each recorded environment, with its newest deployment                                                               |
| `GET`, `PATCH /api/accounts/:slug/settings/previews` | Preview retention `{endedDays, idleDays}`: 2 and 7 by default; org owners change them                                                |

- **Who records.** Anyone with write access, with a personal or agent token
  (systems outside Gitmatrix too), or a CI job with its own credential
  (`GITMATRIX_TOKEN`, `gmj_…`), which the API accepts only on these routes and
  only for the job's repository while it runs. A job's record takes its run,
  job, commit and accountable person from the run, and its environment from
  the branch: `production` on the default branch, `timeline/<slug>` on a
  timeline bookmark, `branch/<name>` on any other branch (lowercased; runs of
  characters other than letters, digits, `.`, `_` and `-` become `-`, so
  `Feature/Add login` deploys to `branch/feature/add-login`). An explicit
  `environment` always wins. A `branch/<name>` given by hand must already be
  in that form.
- **`gm deploy record --url <url>`** in a job; outside CI add `--commit`.
  `gm deploy list` and `gm deploy update <id> --status expired` read and
  change records.
- **Expiry.** A timeline preview expires after the account's idle period
  unless the recorder says otherwise; other records don't expire unless told.
  Teardown and revival follow the account's settings (CORE-79).

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
- **Only the default branch moves `latest`.** A CI job building any other
  branch still publishes its versions, with the branch in their history, but
  they never become `latest`: not npm's dist-tag, an OCI `:latest` push (the
  image is stored, the tag stays), a release, Go's `@latest`, Helm's latest
  chart, Maven's `<latest>`/`<release>`, or the newest-publish fallback the
  console and `gm pkg download …/latest` use (`publishes.off_default_branch`).
  People publishing by hand move it as before.
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
  - version links open paginated contents without losing the history query:
    generic files and release assets show sizes, checksums and downloads; npm
    shows the archive's directory tree and actual `package.json`; OCI shows
    manifests, platform choices, config and layers. Other formats expose their
    recorded distribution files and package/version metadata.

  Repositories have a Packages tab, and CI runs list what they published.

- **Feeds and proxies.** `/:owner/-/feeds` sets visibility and retention (keep
  the newest N versions, or remove them after N days; tagged versions stay),
  and adds proxies (`<owner>.<name>`, credentials sealed with `REGISTRY_KEK`)
  and virtual feeds over several of them. An hourly cron sweeps retention, and
  a GC deletes unreferenced blobs.
- **npm login** works both ways: an access token as the password, or
  `--auth-type=web`, which approves the login at `/cli-auth/npm/:id`.

Deployed, package indexes embed https://gitmatrix.fward.dev (or
`GITMATRIX_PUBLIC_URL`), and the `REGISTRY_KEK` secret seals keys. Development uses a fixed public key. `pnpm run
db:migrate` applies both databases' migrations. Account slugs must not take
the registry's path prefixes (`v2`, `npm`, `pypi`, `maven`, `cargo`, `go`,
`helm`, `apt`, `rpm`, `brew`, `generic`, `releases`) or `-`.

### Version contents

`GET /api/packages/:owner/:format/:name/contents?version=…` returns a
`PackageContents` page. Encode the package name as one API path segment.
`offset` and `limit` paginate entries; `path` selects an npm archive directory,
and `manifest` selects a manifest reachable from the selected OCI version.
The web console keeps that selection in `version`, `path`, `contentOffset` and
`manifest` URL parameters.

Each downloadable entry has a version-scoped `downloadUrl`. Downloads use the
same feed/package authorization as listings and accept the web session, so
private packages never require a public or unscoped blob URL. Responses stream
as attachments; npm archive members support HEAD and byte ranges. Homebrew
versions resolve their recorded digest rather than the current formula file.

npm's first view streams and indexes the tarball once, serialized by its
repository Durable Object. A persistent D1 index and cached uncompressed tar in
R2 serve subsequent directory pages and member ranges without decompressing
again. Index writes are batched and directory entries deduplicated. Inspection
is bounded to a 1 GiB uncompressed archive, 100,000 archive entries and 16 MiB
of indexed names. Manifest and config JSON inspection is bounded to 4 MiB.
PyPI, Cargo, Maven, Helm, Go,
APT, RPM and Homebrew use existing catalog metadata instead of unpacking
distribution archives.

Apply registry migration `0005_package_contents.sql` before running the updated
Worker. Cache rows are tied to their source blobs for registry garbage collection.

### Historical artifact storage

Generic `<artifact>/<version>/<relative-file>` uploads and release assets are
compacted automatically in R2. A lineage is one repository plus artifact/file
path, or release project/asset name; platforms and filenames never share a
version sequence.

- The newest two distinct published versions stay raw for the normal streaming
  fast path. Identical upload retries do not advance the sequence. Hotness follows
  publication history, so deleting a recent version does not make old history hot.
- Older versions use independently compressed **4 MiB frames**. Each delta
  references one immutable full snapshot directly, never another delta. A new
  full snapshot occurs by the 32nd update after its anchor, or earlier when delta
  payloads exceed 50% of an independently compressed full version. Incompressible
  frames use raw bytes instead of growing compressed payloads.
- Downloads preserve original bytes, checksums, ETags, HEAD and Range semantics.
  Historical ranges reconstruct only intersecting frames; full downloads stream
  frame by frame. Original and full-base frames use opportunistic one-hour
  Cache API entries on reads. Staging verification does not prewarm new frames.
- Queue work checkpoints after at most two frames per delivery, verifies SHA-256,
  and publishes with a fenced locator compare-and-swap. Hourly sweeps recover
  interrupted jobs. Existing data is backfilled with persistent 200-row cursors;
  recent-version tracking holds only two rows per lineage. Hot-digest lookups start
  from that bounded table and resolve publication primary keys, even when millions
  of historical versions share the same digest.
- Logical version deletion and physical generation GC are separate. Dependent
  deltas and in-flight work pin full snapshots even after their original version
  is deleted. Superseded raw objects and unused staging candidates have a 24-hour
  grace; expired abandoned builds release their pins after seven days.

Apply registry migration `0004_artifact_storage.sql` before running the updated
Worker. Existing raw locators remain readable during backfill. Compaction changes
storage only: clients and artifact URLs do not change.

The [Git LFS and Xet investigation](../../ARTIFACT-STORAGE-RESEARCH.md) records
measured comparisons, shared-chunk storage tradeoffs, and the evidence needed
before revisiting this design.

## Assistant

Ask Gitmatrix (CORE-25/26) is an assistant that reads and changes everything a
person can: code and its knowledge graph, issues, CI, packages, repository
settings. It chats in a column docked beside the page (rail button or ⌘J /
Ctrl+J), opens pages there for you, and answers `gm ask` in a terminal.

- **Where it runs.** `worker/assistant/agent.ts`: an `AIChatAgent` (Cloudflare
  Agents SDK) Durable Object per conversation, named `<userId>:<chatId>` by
  `worker/api/assistant.ts` from the signed-in actor, so nobody reaches someone
  else's chat by naming it. Transcripts persist in the object's SQLite; the
  directory is `assistant_chats` in D1 (`GET /api/assistant/chats`).
- **Who it is.** It acts as an `assistant` agent identity accountable to the
  person (created on first use, `identity.ts`), with a short-lived token, and
  calls the real JSON API in-process (`internal.ts`, `worker/app.ts`), so every
  permission check and CORE-52 attribution applies ("assistant for Ann Lee").
  It can't touch tokens, agents, SSH keys, dev endpoints or the CI runner.
- **Every turn starts with clef.** One `@cf/cloudflare/clef-flash` call
  (`plan.ts`, ~0.3–0.5 s, 2.5 s deadline) answers a dozen typed questions about
  the message: intent, which tool groups it needs, difficulty, whether it
  aggregates many items, whether it's about the page on screen, and a status
  line. The answers pick the model (`@cf/zai-org/glm-5.3-flash`, or
  `@cf/zai-org/glm-5.3` for planning and hard turns) and reasoning effort, the
  tools the model sees, the skills preloaded into its instructions, and whether
  Code Mode is offered. Chat titles come from `@cf/ibm-granite/granite-4.0-h-micro`.
- **Tools** (`tools.ts`): reads (`list_repos`, `list_files`, `read_file`,
  `list_commits`, `semantic_changes`, `search_code`, `read_wiki`, `find_issues`,
  `show_issue`, `ci_runs`, `ci_run`, `ci_logs`, `find_packages`, `api_get`) and
  writes (`create_issue`, `update_issue`, `comment_on_issue`, `link_issues`,
  `rerun_ci`, `cancel_ci`, `api_write`). On the web every write waits for an
  approval card whose wording comes from the request itself
  (`shared/assistant.ts` `describeWrite`), never the model's summary.
  `navigate` runs in the browser (the page beside the chat moves).
- **Code Mode.** When clef says a turn aggregates (count, compare, join across
  many issues or runs), the model gets `codemode`: it writes one script over the
  read tools that runs in a Dynamic Worker (`LOADER`, no network) instead of a
  dozen round trips. Writes never run there.
- **Skills** (`skills.ts`): SKILL.md-style built-ins (the API catalog, tracker,
  code, CI, packages, knowledge, navigation, repository, gm), a catalog line
  each, bodies preloaded for the turn's groups and otherwise one
  `activate_skill` away. A repository's own `.agents/skills/*/SKILL.md` join
  them when the chat is about it.
- **The web** (`src/assistant/`): page context (repository, file and lines,
  issue, run) goes with each message and shows as a removable chip; receipts
  fold finished reads into one line; typing while an approval waits declines it
  and redirects; approved writes revalidate the page.
  Approvals and browser-tool results continue through the AI SDK's automatic
  submission predicates, with the existing assistant message and page context.
  The server stream receives `originalMessages` to retain that message's identity.
  Agents SDK server-driven continuation is disabled: AI SDK 7's reconnect path
  starts an empty response for settled tool inputs and cannot attach their results.
  The version-pinned `@cloudflare/ai-chat` patch treats those submitted assistant
  tails as continuations during tool repair, streaming, persistence and recovery;
  otherwise a later step overwrites the saved tool receipts with only new prose.
- **The CLI.** `POST /api/assistant/ask` streams newline-delimited events
  (`chat`, `plan`, `status`, `tool`, `text`, `done`, `error`); `gm ask` prints
  them, or returns one JSON object to agents. It lands in the same transcript,
  so a terminal conversation continues on the web.

`vp run agent test-ai` covers a real browser approval, exactly-once issue creation,
conversation-aware follow-up, retry after an injected stream failure, redirecting
a pending approval without executing it or generating a second reply, and reload.
It retains `assistant-approval.png` and `assistant-approval.zip` with the provider
evidence. Provider stream errors also pass through the assistant's error handler
so Worker logs include their message rather than only a provider stack trace.

## Mirrors

A repository can mirror its default branch and tags on to another git host
after every push: Settings → Mirror, `gm repo mirror set <url> --token-stdin`,
or `PUT /api/repos/:o/:n/mirror`. Gitmatrix's own repository mirrors `main` to
GitHub this way, as a backup.

```
push ─▶ git proxy ─▶ queueMirror ─▶ JOBS queue (gitmatrix-jobs) ─▶ syncMirror
syncMirror: target refs (receive-pack advertisement) vs Artifacts' (ls-refs)
            ─▶ fetch exactly the missing objects from Artifacts (v2 fetch, haves = target tips)
            ─▶ stream that pack into the target's receive-pack ─▶ report-status
```

- **Default branch and tags only.** The default branch (the one HEAD names,
  falling back to `repos.default_branch`) and every tag are pushed. Other
  branches, timelines and experiments among them, stay on Gitmatrix; pushing
  one doesn't reach the target. Branches already on the target are left as
  they are.
- **One way, and safe by default.** Mirrored refs are force-pushed, so rewinds
  follow; anything pushed to them on the target directly is overwritten. A
  mirrored ref that disappears here stays on the target unless pruning is on,
  so a backup never loses data on its own. Pruning only ever deletes the
  default branch or tags, never another branch.
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
- `worker/tracker/*`: account-level authority, transactional graph store and sync API
- `worker/search/*`, `shared/search.ts`: global search providers, ranking and `/api/search`
- `shared/tracker.ts`: shared tracker entities, mutations and readiness semantics
- `src/routes/tracker/*`: issue workbench, graph and tracker administration
- `scripts/git-login.ts`: points the git CLI at Gitmatrix as a persona
- `src/`: React Router (data mode), Base UI and Tailwind, styled with MatrixKit Neo
  (`src/styles/tokens.css` is generated from the design system's tokens;
  `matrixkit.css` is its component stylesheet, vendored as is)
  `AppShell.tsx` anchors desktop navigation to both viewport edges and reserves
  its width using `--size-rail`; phones retain a sticky top bar without that
  gutter. Keeping the desktop rail out of sticky page flow prevents bottom gaps
  when document heights land on fractional CSS pixels.

## Known gaps

- No branch protection, events, or webhooks yet. `pushed_at` is set when receive-pack
  returns 200, even if git rejected a ref inside the response.
- READMEs render Markdown without raw HTML, so `<details>` and `<br>` show as text.
- In testing, imports brought over the default branch only, without tags.
- Owner slugs `signin`, `new`, `settings`, `tracker`, `api`, `cli-auth`, `-` and the registry prefixes
  collide with routes and should be reserved once accounts can be created.
- Packages: the tag facet lives in the header's tag plates rather than the side
  column; retention can't yet keep a branch's builds longer than another's.
