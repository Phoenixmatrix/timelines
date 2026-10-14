# Attributions

Timelines is released under the [MIT License](LICENSE). It includes or builds on
the work below; each keeps its own license. The lists name direct dependencies;
their own dependencies are listed in `pnpm-lock.yaml` and `apps/cli/Cargo.lock`,
with each package's license in its published metadata.

## Included in this repository

| Work                                                                                                                             | Where                                                            | License                                                  |
| -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| [Figtree](https://github.com/erikdkennedy/figtree) by Erik Kennedy                                                               | `apps/website/src/styles/fonts/`, `apps/site/src/styles/fonts/`  | [SIL Open Font License 1.1](https://openfontlicense.org) |
| [Geist Mono](https://github.com/vercel/geist-font) by Vercel                                                                     | `apps/website/src/styles/fonts/`, `apps/site/src/styles/fonts/`  | [SIL Open Font License 1.1](https://openfontlicense.org) |
| MatrixKit Neo, the design system the web app is drawn in, made with Claude Design                                                | `apps/website/src/styles/{tokens,matrixkit}.css`, `Monogram.tsx` | Part of this project                                     |
| The `.xz` decoder follows [XZ Embedded](https://tukaani.org/xz/embedded.html) and the [LZMA SDK](https://www.7-zip.org/sdk.html) | `packages/formats/src/xz/`                                       | Public domain (both)                                     |
| Patches to `@cloudflare/ai-chat`, `cf` and `miniflare`                                                                           | `patches/`                                                       | Each package's own license (MIT, or MIT OR Apache-2.0)   |

The Timelines and Gitmatrix marks in `apps/*/public/brand/` were generated with
OpenAI's image model through the Codex CLI and traced to SVG; they are part of
this project.

The knowledge wiki was inspired by [OpenDeepWiki](https://github.com/AIDotNet/OpenDeepWiki);
no code is taken from it.

## Platform

Timelines runs on [Cloudflare](https://www.cloudflare.com): Workers, D1, R2,
Durable Objects, Queues, Workflows, Containers and Sandbox, Artifacts, Secrets
Store, Email Sending and, optionally, Workers AI, AI Gateway, Vectorize and AI
Search. It is built and tested with [Vite+](https://viteplus.dev) (Vite,
Rolldown, Vitest, Oxlint and Oxfmt) and deployed with Cloudflare's
[`cf`](https://github.com/cloudflare/cf) CLI.

## JavaScript and TypeScript

| Package                                                                                                             | Used for                         | License           |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ----------------- |
| [React](https://react.dev) and React DOM                                                                            | The web app                      | MIT               |
| [React Router](https://reactrouter.com)                                                                             | Routing                          | MIT               |
| [Base UI](https://base-ui.com)                                                                                      | Accessible UI primitives         | MIT               |
| [Phosphor Icons](https://phosphoricons.com)                                                                         | Icons                            | MIT               |
| [Tailwind CSS](https://tailwindcss.com)                                                                             | Styling                          | MIT               |
| [Lezer](https://lezer.codemirror.net) parsers and highlighter                                                       | Syntax highlighting              | MIT               |
| [Mermaid](https://mermaid.js.org)                                                                                   | Diagrams in rendered Markdown    | MIT               |
| [react-markdown](https://github.com/remarkjs/react-markdown), [remark-gfm](https://github.com/remarkjs/remark-gfm)  | Markdown rendering               | MIT               |
| [jsdiff](https://github.com/kpdecker/jsdiff)                                                                        | Diffs                            | BSD-3-Clause      |
| [docx](https://docx.js.org)                                                                                         | Exporting release notes to Word  | MIT               |
| [Hono](https://hono.dev)                                                                                            | The Worker's HTTP routing        | MIT               |
| [Kysely](https://kysely.dev), [kysely-d1](https://github.com/aidenwallis/kysely-d1)                                 | SQL on D1                        | MIT               |
| [Better Auth](https://better-auth.com)                                                                              | Sign-in                          | MIT               |
| [jose](https://github.com/panva/jose)                                                                               | Tokens and signatures            | MIT               |
| [Zod](https://zod.dev)                                                                                              | Validation                       | MIT               |
| [yaml](https://eemeli.org/yaml/)                                                                                    | YAML parsing                     | ISC               |
| [AI SDK](https://ai-sdk.dev) (`ai`, `@ai-sdk/react`)                                                                | The assistant                    | Apache-2.0        |
| [Cloudflare Agents](https://github.com/cloudflare/agents) (`agents`, `@cloudflare/ai-chat`, `@cloudflare/codemode`) | The assistant                    | MIT               |
| [workers-ai-provider](https://github.com/cloudflare/ai)                                                             | Workers AI models                | MIT               |
| [fflate](https://github.com/101arrowz/fflate), [fzstd](https://github.com/101arrowz/fzstd)                          | Compression in package formats   | MIT               |
| [OpenPGP.js](https://openpgpjs.org)                                                                                 | Signing APT and RPM repositories | LGPL-3.0-or-later |
| [node-semver](https://github.com/npm/node-semver)                                                                   | Version ranges                   | ISC               |
| [Astro](https://astro.build)                                                                                        | The public site                  | MIT               |
| [Playwright](https://playwright.dev)                                                                                | Browser and end-to-end tests     | Apache-2.0        |
| [TypeScript](https://www.typescriptlang.org)                                                                        | Type checking                    | Apache-2.0        |
| [Cloudflare Vite plugin, Wrangler and config tools](https://github.com/cloudflare/workers-sdk)                      | Building and running the Worker  | MIT OR Apache-2.0 |

## Rust (the `gm` CLI)

| Crate                                                                                                                                                                                                                                                                                                                                                                  | Used for                                 | License                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------- |
| [clap](https://github.com/clap-rs/clap)                                                                                                                                                                                                                                                                                                                                | Command-line parsing                     | MIT OR Apache-2.0                                              |
| [git2](https://github.com/rust-lang/git2-rs), with [libgit2](https://libgit2.org)                                                                                                                                                                                                                                                                                      | Git                                      | MIT OR Apache-2.0; libgit2 is GPL-2.0 with a linking exception |
| [rusqlite](https://github.com/rusqlite/rusqlite), with bundled [SQLite](https://sqlite.org)                                                                                                                                                                                                                                                                            | Local state                              | MIT; SQLite is public domain                                   |
| [serde](https://serde.rs), [serde_json](https://github.com/serde-rs/json), [serde_yaml_ng](https://github.com/acatton/serde-yaml-ng)                                                                                                                                                                                                                                   | Serialization                            | MIT OR Apache-2.0; serde_yaml_ng is MIT                        |
| [schemars](https://github.com/GREsau/schemars)                                                                                                                                                                                                                                                                                                                         | JSON schemas for commands                | MIT                                                            |
| [ureq](https://github.com/algesten/ureq)                                                                                                                                                                                                                                                                                                                               | HTTP                                     | MIT OR Apache-2.0                                              |
| [ssh-key](https://github.com/RustCrypto/SSH), [sha2](https://github.com/RustCrypto/hashes)                                                                                                                                                                                                                                                                             | SSH-key sign-in, checksums               | Apache-2.0 OR MIT                                              |
| [ignore](https://github.com/BurntSushi/ripgrep/tree/master/crates/ignore)                                                                                                                                                                                                                                                                                              | Ignore files                             | Unlicense OR MIT                                               |
| [cap-std](https://github.com/bytecodealliance/cap-std)                                                                                                                                                                                                                                                                                                                 | Confined file access for worktree copies | Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT            |
| [chrono](https://github.com/chronotope/chrono)                                                                                                                                                                                                                                                                                                                         | Dates                                    | MIT OR Apache-2.0                                              |
| [indexmap](https://github.com/indexmap-rs/indexmap), [parking_lot](https://github.com/Amanieu/parking_lot), [rand](https://github.com/rust-random/rand), [tempfile](https://github.com/Stebalien/tempfile), [thiserror](https://github.com/dtolnay/thiserror), [fd-lock](https://github.com/yoshuawuyts/fd-lock), [signal-hook](https://github.com/vorner/signal-hook) | Internals                                | MIT OR Apache-2.0                                              |
| [owo-colors](https://github.com/owo-colors/owo-colors), [sysinfo](https://github.com/GuillaumeGomez/sysinfo)                                                                                                                                                                                                                                                           | Terminal colors, process information     | MIT                                                            |
| [rpassword](https://github.com/conradkleinespel/rpassword)                                                                                                                                                                                                                                                                                                             | Password prompts                         | Apache-2.0                                                     |
