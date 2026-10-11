# Public site

The public marketing and documentation site for Timelines, served at
[timelines.fward.dev](https://timelines.fward.dev) (CORE-115). It is built with
[Astro](https://astro.build) as static pages and served by a Worker of its own,
`gitmatrix-site`, that has no code: only its assets. Nobody signs in here; the
header links to the web app at gitmatrix.fward.dev.

## Layout

- `src/pages/index.astro`: the landing page. `src/pages/404.astro`: not found.
- `src/content/docs/**/*.md`: the docs, one page per file. The frontmatter
  (`title`, `description`, `section`, `order`) is checked by
  `src/content.config.ts`; `section` and `order` place a page in the sidebar.
- `src/pages/docs/gm/index.astro`: the gm command reference, rendered from
  `src/data/gm-commands.json`, a snapshot of `gm cli commands`.
- `src/styles/tokens.css`: a copy of the web app's MatrixKit Neo tokens, and
  `public/brand/`, `public/favicon*`: copies of its brand assets. Keep them in
  step with `apps/website`.

The header pairs the exact Pounce cat with the Timelines name in the site's
existing Figtree typography. Preserve the cat paths, palette and historical
asset provenance; internal `gitmatrix` names and operational app URLs are
not product-name prose.

## Commands

```sh
vp run site#dev           # local dev server
vp run site#build         # astro build, then the Worker's build output
vp run site#test          # reference grouping, parameter labels and anchors
vp run site#typecheck
vp run site#gm-reference  # refresh the gm snapshot from this checkout's gm source
```

After changing CLI commands, flags, help or examples, run
`vp run site#gm-reference` and commit the generated snapshot.

## Deploying

Pushing to main deploys the site when anything it's built from changed
(`tools/agent/deploy.ts`, `sitePlan`): its version is tagged with the commit,
like the web app's. `cf deploy` can't build an Astro site without Astro's
server adapter, so `scripts/build-output.ts` turns `dist/` into Cloudflare's
Build Output (`.cloudflare/output`) for an assets-only Worker from
`cloudflare.config.ts`, and the deploy runs `cf deploy --prebuilt`.
