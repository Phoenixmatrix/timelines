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

`wrangler login` must have the `artifacts` scope. There is no local Artifacts
emulator, so dev uses the real `gitmatrix-dev` namespace (`remote: true` in
`wrangler.jsonc`); D1 stays local.

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

## Layout

- `worker/git/http.ts`: smart HTTP proxy (info/refs, upload-pack, receive-pack)
- `worker/git/pktline.ts`: pkt-line codec and the `ls-refs` client used to list branches
- `worker/api/*`: JSON API (`dev.ts` mints persona tokens and seeds sample data)
- `scripts/git-login.ts`: points the git CLI at Gitmatrix as a persona
- `src/`: React Router (data mode), Base UI and Tailwind, styled with MatrixKit Neo
  (`src/styles/tokens.css` is generated from the design system's tokens;
  `matrixkit.css` is its component stylesheet, vendored as is)

## Known gaps

- No branch protection, events, or webhooks yet. `pushed_at` is set when receive-pack
  returns 200, even if git rejected a ref inside the response.
- READMEs render Markdown without raw HTML, so `<details>` and `<br>` show as text.
- In testing, imports brought over the default branch only, without tags.
- Owner slugs `signin`, `new`, `settings` and `api` collide with app routes and should be reserved.
