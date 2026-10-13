# Self-hosting Timelines on a new Cloudflare account

This guide takes you from no Cloudflare account to your own Timelines instance:
a Git host, package registry, CI service and issue tracker on a hostname of
your choosing. Setup is one command, `gm instance setup`. It does what it can
through Cloudflare's `cf` CLI and walks you through the rest. This page lists
everything that command needs, so you can prepare in advance and see what
comes next.

Plan for 30–60 minutes of your own time. Most of the wait is a new domain
becoming active, which can take a few hours.

## What you need

**Accounts and a domain**

- A **Cloudflare account**. Sign up at https://dash.cloudflare.com/sign-up and
  verify your email address.
- A **payment method** on that account. The Workers Paid plan requires one.
- A **domain you control**, such as `example.com`. The instance answers on a
  hostname in it, such as `timelines.example.com`. The domain has to move its
  DNS to Cloudflare, which means changing its nameservers at your registrar. If
  that's a problem, use a domain dedicated to this.

**On your machine** (Linux or macOS)

| Tool                                          | Version                            | Why                                                      |
| --------------------------------------------- | ---------------------------------- | -------------------------------------------------------- |
| [git](https://git-scm.com)                    | any recent                         | Cloning the source; upgrades fetch new versions with it. |
| [Node.js](https://nodejs.org)                 | 22.18 or newer                     | Runs the build and Cloudflare's `cf` CLI.                |
| [pnpm](https://pnpm.io/installation)          | any; it fetches the pinned version | Installs the dependencies.                               |
| [Rust](https://rustup.rs)                     | 1.85 or newer                      | Builds `gm`, the Timelines CLI.                          |
| [Docker](https://docs.docker.com/get-docker/) | running, usable without `sudo`     | Builds the image CI jobs run in, on every deploy.        |

You don't need to install `cf`: `pnpm install` installs the version the
repository pins.

## What it costs

- **Workers Paid**: $5 a month per account. It covers several instances.
- **Usage**, billed per use beyond each product's included amount: requests,
  D1 and R2 storage, Queues, and the Containers that CI jobs run in. A small
  instance with occasional CI stays close to the included amounts.
- **AI**, only if you turn it on during setup: Workers AI, AI Gateway, Vectorize
  and AI Search, billed per use. It powers the knowledge graph, wiki, assistant
  and release notes. Without it the app shows those features as off. You can
  add AI later with `gm instance setup <name> --ai`.

Check Cloudflare's pricing pages for current numbers.

## 1. Prepare the account

Setup checks each of these and stops with instructions when one is missing, so
you can skip this section and let it guide you. Doing them first saves waiting
in the middle of setup.

1. **Subscribe to Workers Paid.** Dashboard → **Workers & Pages** → **Plans** →
   Workers Paid.
2. **Enable R2.** Dashboard → **R2 Object Storage** → enable it. New accounts
   start with R2 off.
3. **Add your domain.** Dashboard → **Add a domain**, then follow its steps.
   Change the domain's nameservers at your registrar to the two Cloudflare
   gives you, then wait until the domain shows **Active**. That's usually minutes
   but can take a few hours. Setup can't do this part, and nothing else works
   until it's done.
4. **Create the Secrets Store.** Dashboard → **Secrets Store** (with the storage
   products) → create the store. An account has one store, which all your
   projects share. Setup keeps the instance's secrets there; `cf` can't create
   the store itself.
5. **Email Sending (optional to do now).** The instance emails sign-in codes,
   so it needs a sending domain in your zone. Setup offers to create
   `mail.<your domain>` and to add its DNS records (SPF, DKIM, DMARC). To do it
   yourself: Dashboard → your domain → **Email** → **Email Sending** → onboard a
   subdomain and let Cloudflare add its records.

## 2. Get the source and build gm

```sh
git clone https://github.com/Phoenixmatrix/timelines.git
cd timelines
pnpm install
cargo build --release --manifest-path apps/cli/Cargo.toml
```

This leaves `gm` at `apps/cli/target/release/gm`. Use that path, add the
directory to your `PATH`, or run `cargo install --path apps/cli --locked`. The
examples below assume `gm` is on your `PATH`.

Run setup from this checkout: it deploys the checkout, and later upgrades
fetch new versions from the repository you cloned.

## 3. Run setup

```sh
gm instance setup
```

Setup asks one thing at a time, offering a default in brackets where it has
one:

| Question                | What to answer                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Instance name           | A short name, such as `acme`. Every resource is named after it (`gitmatrix-acme`, `gitmatrix-acme-jobs`, …), so instances in one account never collide.           |
| Cloudflare sign-in      | Nothing: when you're signed out, setup opens Cloudflare's sign-in in your browser.                                                                                |
| Account                 | Asked only if your login can use several accounts.                                                                                                                |
| Hostname                | Where the instance answers, such as `timelines.example.com`. It must be in your active zone and must not have DNS records yet.                                    |
| Owner's email           | Your address. The owner can always sign in, becomes site administrator and can invite everyone else.                                                              |
| Organization            | The organization created for you on your first sign-in, where your repositories can live. It must differ from your username, which comes from your email address. |
| Send sign-in codes from | An address on the zone's Email Sending domain, such as `gitmatrix-acme@mail.example.com`.                                                                         |
| AI                      | Whether to provision paid AI. The default is no.                                                                                                                  |

Between questions, setup checks the account: Workers Paid, R2, the zone, the
Email Sending domain and its DNS records, the Secrets Store and Docker. When
something is missing, it prints the dashboard steps and checks again when you
press Enter. You can also stop with Ctrl-C and rerun `gm instance setup <name>`
later; it keeps your answers.

Then it shows a plan of everything it's about to create and asks you to
confirm. After that it:

1. creates two D1 databases, three R2 buckets, two queues, an Artifacts
   namespace and (with AI) an AI Gateway, a Vectorize index and an AI Search
   namespace;
2. generates the instance's two secrets into the Secrets Store;
3. applies the database migrations;
4. builds the app and the CI image and deploys the Worker, together with its
   Workflows, CI container and custom domain. Cloudflare creates the DNS record
   and certificate;
5. waits until `https://<hostname>` answers.

The deploy takes a few minutes. The first one is the slowest, because Docker
builds the CI image from scratch.

To see the checks and the plan without creating anything, add `--dry-run`. To
run without questions (scripts, agents), pass every answer as a flag:

```sh
gm instance setup acme --host timelines.example.com --owner-email you@example.com \
  --owner-org acme --email-from gitmatrix-acme@mail.example.com --no-ai --yes
```

## 4. Sign in

1. Open `https://<hostname>`, enter the owner's email, and use the code it emails
   you. Your organization is created on this first sign-in.
2. Invite people from **Settings → Invites**. Sign-in is invite-only; the owner
   can always sign in.
3. Point `gm` at the instance: `gm auth login --server https://<hostname>`.
   From there, `gm cli guide` explains the version-control workflow.

## Keeping it up to date

Your instance doesn't update itself. It changes when you upgrade it, and only to
the version you choose. Versions are commits on the upstream's `main` branch:

```sh
gm instance upgrade acme --dry-run          # what's new: commits, migrations, CI image changes
gm instance upgrade acme                    # upgrade to the latest main
gm instance upgrade acme --to 1a2b3c4d5e6f  # or to a specific version
```

Upgrade never touches your checkout. It fetches into a clone of its own,
builds that version (including its gm), and has that version deploy itself,
creating any new resources it needs. Upgrades only move forward: database
migrations can't be undone, so going back requires `--allow-downgrade`, and
the migrations stay applied.

If you change the source yourself, deploy your checkout with
`gm instance deploy acme`.

## Several instances in one account

Run `gm instance setup` again with another name and hostname. Instances share
only what the account has one of: the Workers Paid plan, the Secrets Store (each
instance's secrets are named after it), the zone (each adds its own DNS record)
and the Email Sending domain, if they use the same one. Nothing else is shared,
and nothing one instance does affects another. `gm instance list` shows the
instances set up from this machine; `gm instance show <name>` shows one
instance's resources.

## Troubleshooting

- **Setup stopped partway.** Rerun `gm instance setup <name>`. It looks up every
  resource by name before creating it, so it continues where it stopped without
  making duplicates.
- **"A Worker named … already exists" or "… already has DNS records".** That
  name or hostname is in use by something setup didn't create. Choose another.
- **The hostname doesn't load right after setup.** A new certificate can take a
  few minutes. If only your machine can't reach it, your DNS resolver may have
  cached the name as missing before the record existed; that clears within
  about 30 minutes.
- **No sign-in code arrives.** In the dashboard, check the sending domain under
  **Email** → **Email Sending**: it should be ready, with all its DNS records
  present. Check your spam folder too.
- **The deploy fails building the CI image.** Make sure `docker info` works for
  your user, then rerun setup (or `gm instance deploy <name>` once setup has
  finished).

## Removing an instance

Removal isn't automated yet:

1. Delete the instance's Worker (`gitmatrix-<name>`), with its custom domain.
   Check that the hostname's DNS record and the `gitmatrix-<name>-…` Workflows
   are gone too.
2. Delete the resources `gm instance show <name>` lists: the D1 databases, R2
   buckets (empty them first), queues, Artifacts namespace, the two secrets in
   the Secrets Store, and the AI resources if you created them.
3. Delete the instance file it shows, under `~/.config/gitmatrix/instances/`.

Keep the Email Sending domain if anything else sends from it.
