---
title: Getting started
description: Get access, install gm, sign in, create or clone a repository, push a change to trunk and wait for CI.
section: Start
order: 2
---

This page takes you from nothing to a change on trunk with a green CI run. It uses `gm`, the Timelines CLI, for every step.

## Get access

Timelines is invite-only for now. An Instance administrator invites your email address, and you sign in to the web app at [timelinesapp.fward.dev](https://timelinesapp.fward.dev) with a one-time code sent to that address. Your Account is your person identity. Organizations contain Spaces, and each Space owns its repositories, Tracker, Projects, packages and content settings. Organization membership or ownership alone does not grant private content access: ask for an explicit Space grant. A repository collaborator grant covers only that repository.

## Get gm

`gm` is a single binary, published for Linux on x86-64 and ARM64 (glibc 2.36 or newer).

1. In the web app, create a personal access token under [Settings, Access tokens](https://timelinesapp.fward.dev/settings/tokens).
2. Open the `gm` package under Packages in the `matrixorg` Space. Your inviter must give you package access there. Its page shows the latest version and the `curl` command that downloads it with your token. Verify the downloaded artifact against its published SHA-256 checksum.
3. Make the downloaded file executable and put it on your `PATH`, for example in `~/.local/bin`:

```sh
chmod +x gm && mv gm ~/.local/bin/gm
gm --version
```

Once you have a compatible CLI and have signed in below, `gm` can update itself. `gm pkg install` downloads the binary for your platform, verifies its SHA-256 checksum and replaces the installed one, even while it runs:

```sh
gm pkg install gm --space matrixorg --force
```

gm does not edit your shell configuration; add its directory to `PATH` yourself.

### Upgrading across the v4 content cutover

The Space/Project commands on this page require the v4 content-contract CLI and a compatible server. An old CLI may neither recognize `--space` nor access the v4 content API; changing its flags is not an upgrade. Wait for the coordinated v4 server activation and CLI release publication, then download the released binary through the package page above rather than invoking the old CLI's package commands. Verify its published checksum and release provenance before replacing the installed binary. Do not install an unreleased feature build into your shared `PATH`.

For an existing checkout, `apps/cli/README.md` has the checksum-verified `installGm` bootstrap procedure using `tools/preview/preview.ts` from the exact released `main` source. It uses a temporary compatible client, checks the published version against the released `apps/cli` tree ID, and pins that version for installation. Preserve legacy Tracker replicas and queued work; follow [offline recovery](/docs/concepts/issue-graph/#offline) before replaying them. These instructions describe the coordinated upgrade, not a claim that the cutover has been approved or deployed.

## Sign in

Sign `gm` in. By default it signs in through the browser: it shows a code and a link to the `/device` page, you approve it while signed in on the web, and gm exchanges that approval for a personal access token. Pass `--server` the first time; it also becomes gm's default server.

```sh
gm auth login --server https://timelinesapp.fward.dev
gm auth status
```

Other ways to sign in:

- **SSH key.** Register a key from your SSH agent or `~/.ssh` with `gm auth ssh-key add`, then sign in with `gm auth login --ssh`. gm signs a one-time challenge over HTTPS and renews its session with the key when it runs out. Keys from 1Password and other agents work.
- **Token.** `gm auth login --token gmx_…` stores an existing personal access token.

Credentials live in `~/.config/gitmatrix/gm.json`. The `GM_SERVER` and `GM_TOKEN` environment variables override them for a single run. If you also use plain `git`, `gm auth git-credential` is a credential helper that lets git use your gm sign-in.

## Create or clone a repository

Create a repository in a Space where you have an explicit grant permitting creation. `--space` is required and takes the globally unique Space handle, not an Account handle or Organization slug. The repository is private unless you pass `--public`, and `--import` copies an existing public git repository:

```sh
gm repo create demo --space orbit
gm repo create engine --space orbit --import https://github.com/lukeed/clsx
```

Clone it with the canonical `<space>/<repo>` locator. Here `orbit` is the Space handle:

```sh
gm clone orbit/demo
cd demo
```

`gm repo list` shows the repositories you can read. If you already have a plain git clone of a Timelines repository, run `gm init` inside it to start using gm there.

## Make a change and commit it

Edit files, then look at what changed:

```sh
gm status
gm diff
```

There is no staging area. Your edits are already part of the working-copy change, `@`. `gm commit` describes that change and starts a fresh one on top:

```sh
gm commit -m "Add a README"
```

Commit as often as you like; each commit is one logical step. If you get something wrong, `gm undo` reverses the last operation. [Changes and trunk](/docs/concepts/changes/) explains the model.

## Push to trunk

There are no pull requests. `gm push` lands your changes on trunk:

```sh
gm push
```

If trunk has moved since you last synced, the push stops with exit code 4 and tells you so. Rebase onto the new trunk and push in one step:

```sh
gm push --sync
```

`gm push` also refuses changes that still have conflicts or have no description.

## Watch CI

If the repository has a pipeline in `.gitmatrix/ci.yml`, each push starts a run. `gm runs wait` blocks until the run for trunk finishes. It exits 0 when the run passed and non-zero when it failed:

```sh
gm push && gm runs wait
```

When a run fails, read the failing job's output:

```sh
gm runs list
gm runs show
gm runs logs --job test
```

You can follow the same runs, with live logs, on the repository's CI tab in the web app. [CI and steps](/docs/concepts/ci/) covers the pipeline file and the other `gm runs` commands.

## Next steps

- Read the workflow on one page: `gm cli guide`.
- Find a command by describing the task: `gm cli search "undo my last commit"`.
- Set a checkout up for a coding agent: `gm agent setup`. See [Agents](/docs/concepts/agents/).
- Work through tracked issues: [The issue graph](/docs/concepts/issue-graph/).
- Every command, with its options: the [gm reference](/docs/gm/), for example [`gm push`](/docs/gm/#gm-push) and [`gm runs wait`](/docs/gm/#gm-runs-wait).
