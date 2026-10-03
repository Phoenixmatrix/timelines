---
name: Gitmatrix
description: A git host for agent-driven development, drawn in MatrixKit Neo; warm charcoal panes and one amber signal.
colors:
  surface: "oklch(0.235 0.007 70)"
  sunken: "oklch(0.19 0.006 70)"
  rail: "oklch(0.175 0.006 70)"
  pane: "oklch(0.205 0.006 70)"
  raised: "oklch(0.275 0.008 70)"
  pressed: "oklch(0.32 0.009 70)"
  line: "oklch(0.32 0.008 70)"
  line-soft: "oklch(0.27 0.007 70)"
  ink: "oklch(0.945 0.008 80)"
  ink-muted: "oklch(0.76 0.012 75)"
  ink-faint: "oklch(0.64 0.012 75)"
  brand: "#91f5be"
  signal: "oklch(0.81 0.145 76)"
  signal-hover: "oklch(0.85 0.13 80)"
  signal-ink: "oklch(0.23 0.035 65)"
  signal-line: "oklch(0.81 0.145 76)"
  signal-wash: "oklch(0.81 0.145 76 / 0.14)"
  danger: "oklch(0.54 0.19 25)"
  danger-hover: "oklch(0.49 0.18 25)"
  danger-ink: "oklch(0.99 0 0)"
  danger-text: "oklch(0.72 0.16 25)"
  danger-wash: "oklch(0.64 0.19 25 / 0.16)"
  online: "oklch(0.74 0.14 155)"
  backdrop: "oklch(0.08 0.01 70 / 0.6)"
  data-teal: "oklch(0.78 0.1 200)"
  data-teal-wash: "oklch(0.78 0.1 200 / 0.18)"
  data-berry: "oklch(0.66 0.12 350)"
  data-berry-wash: "oklch(0.66 0.12 350 / 0.22)"
typography:
  headline:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: "1.9rem"
    letterSpacing: "-0.015em"
    fontFeature: '"ss01", "cv11"'
  title-lg:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: "1.65rem"
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 700
    lineHeight: "1.5rem"
  body:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: "1.45rem"
    fontFeature: '"ss01", "cv11"'
  body-sm:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: "1.25rem"
  label:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: "1.1rem"
  micro:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 400
    lineHeight: "1rem"
  mono:
    fontFamily: "Geist Mono Variable, ui-monospace, SF Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1.1rem"
    fontFeature: '"tnum"'
rounded:
  plate: "6px"
  control: "8px"
  pane: "12px"
  squircle: "30%"
  full: "9999px"
spacing:
  hair: "4px"
  xs: "6px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  section: "48px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-primary-hover:
    backgroundColor: "{colors.signal-hover}"
  button-default:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-default-hover:
    backgroundColor: "{colors.pressed}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-ghost-hover:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.danger-ink}"
    rounded: "{rounded.control}"
    padding: "0 16px"
    height: "40px"
  button-danger-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.danger-text}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  button-sm:
    typography: "{typography.body-sm}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "44px"
  input-focus:
    backgroundColor: "{colors.rail}"
  chip:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
    padding: "0 12px"
    height: "28px"
  chip-pressed:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
  chip-tag:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink-muted}"
    typography: "{typography.micro}"
    rounded: "{rounded.full}"
    padding: "0 8px"
    height: "20px"
  card:
    backgroundColor: "{colors.pane}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pane}"
    padding: "20px"
  list-row:
    textColor: "{colors.ink}"
    padding: "12px 16px"
  list-row-hover:
    backgroundColor: "{colors.raised}"
  strip:
    backgroundColor: "{colors.signal-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pane}"
    padding: "8px 8px 8px 14px"
  popup:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pane}"
    padding: "6px"
  dialog:
    backgroundColor: "{colors.pane}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pane}"
    padding: "24px"
    width: "min(28rem, calc(100vw - 2rem))"
  nav-rail:
    backgroundColor: "{colors.rail}"
    width: "72px"
  nav-place:
    backgroundColor: "{colors.pane}"
    textColor: "{colors.ink-muted}"
    rounded: "24px"
    size: "48px"
  nav-place-current:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "16px"
  tab:
    textColor: "{colors.ink-muted}"
    typography: "{typography.body}"
    padding: "0 4px 10px"
  tab-current:
    textColor: "{colors.ink}"
---

# Design System: Gitmatrix

## Overview

**Creative North Star: "The Night Shift Console"**

Gitmatrix is read by people checking on work their agents did while they weren't looking: what landed, what CI said, what a commit published, what the knowledge graph now believes. The system is a dark, warm, quiet console for that review. Charcoal panes with a faint warm cast (hue 70) sit on a slightly lighter page; text is warm off-white in three strengths; one amber signal marks what is selected, current or the next thing to press. Outside status/data colors and the Pounce brand mark, surfaces stay neutral, so a person scanning a long table sees the amber and nothing competing with it.

Density is that of a working tool, not a marketing page. Lists are single panes with hairline-divided rows; numbers line up in tabular figures; versions, hashes, commands and counts are set in Geist Mono and words in Figtree. The densest surface (the package console: query bar, saved views, publish-rate strip, virtualized version table, facet column) and the sparsest (the sign-in ledger) are built from the same handful of pieces. MatrixKit Neo is the incumbent system, vendored from Claude Design as is; Gitmatrix composes it with Tailwind utilities and adds almost no CSS of its own.

Dark is the home theme (`data-theme="dark"` on `<html>`); a light theme redefines every token under `data-theme="light"` and is chosen from the account menu. Both themes share the same roles, so code names roles, never values.

**Key Characteristics:**

- Warm charcoal tonal stack; depth by tone, not borders or shadows.
- One amber signal, for selection, current place and primary action only.
- Figtree for words, Geist Mono for machine strings, tabular numerals wherever numbers align.
- Panes of hairline-divided rows as the default container for anything listed.
- Shadows only on what floats: popups, toasts, dialogs, the bulk-selection bar.
- Tailwind utilities on the kit's role names; `mk-*` classes for kit components; CSS only where utilities can't reach.
- Phones lift every control to a 44px touch floor.

## Brand identity

**Pounce** is the user-approved Gitmatrix identity: a flowing cat silhouette whose paths separate and rejoin, suggesting nimble, parallel agent work. Preserve the selected artwork, not the former G lettermark. The logo alone uses the `brand` role: mint `#91f5be` in dark and deep forest `#10251c` in light. Its outlined Figtree wordmark uses `ink`; the interface's amber action signal does not change.

Use `GitmatrixLogo` for the full lockup on Home and authentication pages and the mark alone in the rail. The master SVG, matching favicon family, generation provenance and cache-version convention are documented in [the website brand specification](apps/website/DESIGN.md#brand-identity).

## Colors

A near-monochrome warm charcoal palette with a single amber action accent, a red reserved for danger and failure, a green for success, and data hues used only inside charts. The Pounce logo has its own brand-only mint/forest role. Tokens live in `apps/website/src/styles/tokens.css` and are mapped to Tailwind color utilities in `app.css` (`bg-pane`, `text-ink-muted`, `border-line-soft`, `bg-signal-wash`, and so on). The `@theme` block resets `--color-*` first, so Tailwind's default palette does not exist in this project: only the kit's roles do.

### Primary

- **Amber Signal** (signal): primary buttons (Clone, Run, Create), pressed filter chips and saved views, the rail's current-place pip, the current repository tab's underline, the focus ring, text caret and selection highlight, the hover and brushed state of the publish-rate bars, and the switch's on state. Text on it is always **Signal Ink**, a dark warm brown, never white.
- **Amber Hover** (signal-hover): the primary button's hover fill.
- **Signal Line** (signal-line): the same amber as a line or mark: focus outlines, tab underlines, link underlines in running text, radio dots, select checks, running-CI spinners. In light it deepens to keep contrast against pale panes.
- **Amber Wash** (signal-wash): a 14% amber tint for selected rows in the version table, pressed facet bars, the brushed span of the rate strip, and info strips (`mk-strip`, only for something that needs you now). It marks "this is chosen" without shouting. Never on tags, statuses or data marks.

### Secondary

- **Ember Red** (danger, danger-hover, danger-ink): the filled destructive button in confirm dialogs, nothing else.
- **Red Text** (danger-text) and **Red Wash** (danger-wash): form errors, failed-CI icons, exit codes, the failed-job banner, and ghost destructive buttons (Delete, Yank, Revoke) whose hover fills with the wash.

### Tertiary

- **Online Green** (online): succeeded CI runs, a ready knowledge graph, a completed npm login. Status only; never a fill for controls. This is a deliberate extension: the kit keeps `online` for a connection-is-live dot, and a git host needs pass/fail to read at a glance.
- **Teal** (data-teal): the publishes measure: active publishes in the rate strip, and the 24-hour activity bars in package lists. One measure, one hue, everywhere it appears.
- **Berry** (data-berry): the retired part of a rate-strip bar (versions yanked, deprecated or deleted since). Violet is free for the next measure.

### Neutral

- **Surface** (surface): the page background (`body` and `.mk-root`).
- **Sunken** (sunken): wells below the page: inputs, code blocks, log output, the segmented control's track, inline `code` in prose.
- **Rail** (rail): the navigation rail and everything that floats (popups, menus, toasts, tooltips, the sticky selection bar); inputs also brighten to it on focus.
- **Pane** (pane): cards, list panes, the version table, the rate strip, the CI job panels, the persona cards.
- **Raised** (raised): default buttons, chips and tags, row hover, the current CI job, facet count bars.
- **Pressed** (pressed): default-button and chip hover, the switch track.
- **Line** (line): the empty-state dashed border, blockquote rule, scrollbar thumb, link underline in tables, axis ticks.
- **Line Soft** (line-soft): row dividers inside panes, the hairline ring on inputs and floating surfaces, the tab bar's baseline.
- **Ink** (ink), **Ink Muted** (ink-muted), **Ink Faint** (ink-faint): primary text; secondary text, labels and inactive tabs; metadata, timestamps, placeholders, and icons beside text.
- **Backdrop** (backdrop): the dimming layer behind dialogs.

### Named Rules

**The One Amber Rule.** Amber means selected, current, or the primary action on the screen. Nothing decorative is amber, no status is amber (success is green, failure is red, waiting is faint ink), and a screen has at most one filled amber button.

**The Roles-Not-Values Rule.** Code names a role (`bg-pane`, `text-ink-faint`, `var(--signal-line)`), never an OKLCH literal and never a Tailwind palette color. The light theme only works because every surface is a role.

**The Chart-Hue Rule.** Data hues (teal, violet, berry, in that order; one per measure) appear only inside charts and their legend keys. They identify a measure and never judge it, and data is never drawn in amber: hover gets a `raised` backdrop, a brushed selection an amber wash behind the marks. Columns round 4px at the top; axis labels are faint mono micro; hatching is for estimates only.

## Typography

**Display Font:** Figtree Variable (with ui-sans-serif, system-ui)
**Body Font:** Figtree Variable (with ui-sans-serif, system-ui)
**Label/Mono Font:** Geist Mono Variable (with ui-monospace, SF Mono)

**Character:** Figtree is a friendly geometric grotesk with the `ss01` and `cv11` alternates switched on at the root; it does every word, from page titles to table headers. Geist Mono carries everything a machine produced or will consume: versions, commit hashes, install commands, clone URLs, paths, run numbers and counts. The pairing reads as "a person's tool for looking at machine output".

### Hierarchy

- **Headline** (700, 1.5rem/1.9rem, -0.015em): the one page title: the repository's `owner / name` (owner in normal weight and muted), the package name, "Packages", "Choose a persona".
- **Title Large** (700, 1.25rem/1.65rem, -0.01em): a single focused object inside a page: a CI run's title, a knowledge node's name, a standalone card title such as the npm login confirmation. Dialog titles use the same size.
- **Title** (700, 1.0625rem/1.5rem): section and pane headings ("Runs", "Published", "Narrow it down", job names), card titles and popover titles.
- **Body** (400, 0.9375rem/1.45rem): default text, list-row primary lines (set semibold), buttons (600) and inputs. Explanatory copy caps at 48ch (`max-w-[48ch]`, the kit's 28 to 48ch); rendered Markdown caps at 72ch).
- **Body Small** (400, 0.8125rem/1.25rem): the workhorse: row metadata, table cells, captions, hints, form errors, field labels (600), descriptions. It is the most used size in the app by a wide margin.
- **Label** (600, 0.75rem/1.1rem): column headers and facet group titles, in sentence case and ink-muted or ink-faint.
- **Micro** (400, 0.6875rem/1rem): tags, timestamps at the end of rows, axis labels, legend text, publish counts.
- **Mono** (Geist Mono 400, 0.75rem/1.1rem, tabular): hashes, counts, log lines and code blocks; inline `mk-mono` spans inherit the surrounding size.

### Named Rules

**The Mono-for-Machines Rule.** If a machine wrote it or will parse it (a version, hash, command, URL, path, query, exit code, run number), it is Geist Mono. If a person reads it as language, it is Figtree.

**The Lined-Up Numbers Rule.** Any number that sits in a column or updates in place uses tabular figures (`mk-tabular`, `tabular-nums`, or Geist Mono).

**The Sentence-Case Rule.** Headings, labels, column headers and buttons are sentence case. Nothing is set in uppercase with tracking.

## Layout

The app shell is a fixed 72px navigation rail on the left (it becomes a horizontal bar across the top under 640px) beside a scrolling main column. Pages sit in a centered column with 16px side gutters on phones and 32px from 640px, 28px top and bottom padding: `max-w-4xl` (56rem) for reading and settings pages, `max-w-6xl` (72rem, "wide") for repositories, CI and packages.

Spacing follows the kit's scale (4, 6, 8, 12, 16, 24, 48px), expressed through Tailwind's 4px steps. Inside components the rhythm is 8 to 12px (`gap-2`, `gap-3`); between stacked blocks 16px (`gap-4`); between page sections 24 to 32px (`mt-6`, `mt-8`). Rows inside panes pad 12px by 16px; compact rows (file trees, logs) use a fixed 40px height.

Breakpoints come from Tailwind's defaults and are used consistently by role:

- **Under 640px (sm):** the kit's phone rule lifts buttons, inputs, segments, chips and menu items to 44px; the rail turns horizontal; secondary metadata hides (`max-sm:hidden`).
- **Under 768px (md):** wide tables re-flow into two-line rows (the version table goes from one 40px line to a 60px two-line grid); extra columns in package lists drop out.
- **From 1024px (lg):** side columns appear: the package console's 17rem facet column (sticky), the Atlas's map and inspector. Below lg the facets fold into a `<details>` pane above the table.

Repository pages share a header (title, visibility and role tags, description, Clone popover on the right) over an underlined tab bar (Code, Commits, CI, Packages, Issues, Wiki, Knowledge, Settings) that scrolls horizontally on narrow screens and keeps the current tab in view.

Page width follows the job. `Page` has three columns: reading (`max-w-4xl`) for account settings and forms, wide (`max-w-6xl`) for the package console, and full (`max-w-[120rem]`) for every repository tab, so the repository header and tabs never move between tabs. Inside a full page, content that reads better narrow constrains itself: repository settings are cards in one 48rem column that become two columns from `xl`. Full-width pages earn the space with a side rail from `xl` (1280px): the code tree's About rail (knowledge summary, recent CI as status squares), the file view's "in the knowledge graph" rail (summary, defined symbols linking to `#L` anchors, uses and used-by), the wiki's contents and sources rail. Reading text keeps its measure (about 72ch) inside a full page; empty states cap at 44rem and sit left with the content. Full-height workspaces (the tracker, the Atlas) fill the viewport height and scroll inside their panes, not the page.

### Named Rules

**The Room Rule.** A wide screen is for more columns of the same work (a rail, an inspector, more log columns), never for stretching one column of text or an empty card across it.

**The Pane List Rule.** Anything listed (repositories, commits, runs, files, packages, versions, published artifacts) is one `pane` with `rounded-pane`, rows divided by `line-soft` hairlines, and `raised` on row hover. Not a stack of separate cards.

## Elevation & Depth

Gitmatrix is flat. Depth is carried by the tonal stack: sunken wells below the page, panes a step darker than the page surface and set off by tone alone, raised and pressed for interactive fills. Panes have no borders and no shadows. Shadows exist only on surfaces that float above content and can be dismissed or scrolled past, and they are always paired with a 1px `line-soft` ring so the edge holds in both themes. Inputs use the same idea at rest: a 1px `line-soft` ring drawn with box-shadow rather than a border, stepping to `line` on hover and a 2px `signal-line` ring on focus.

### Shadow Vocabulary

- **Float** (`box-shadow: var(--shadow-float), 0 0 0 1px var(--line-soft)`; `--shadow-float` is `0 8px 24px -6px` plus `0 2px 6px` in a dark warm tint): popups, select lists, menus, popovers, toasts, dialogs, tooltips (without the ring).
- **Dock** (`--shadow-dock`): reserved by the kit for lifting a large framed composition off a marketing page. The app doesn't use it; the sticky bulk-selection bar floats, so it takes the float shadow and ring.

### Named Rules

**The Float-Only Shadow Rule.** A shadow means "this is above the page and will go away". Cards, panes, tables and the rail never cast one.

## Shapes

Corners are gently rounded in four steps that scale with the size of the thing: 6px (`plate`) for small inner items (menu options, segments, facet rows, small icon buttons, inline code); 8px (`control`) for buttons, inputs, code blocks and the CI job list items; 12px (`pane`) for every container (cards, panes, popups, dialogs, toasts, strips, empty states); full pills for chips, tags and badges. Avatars are circles for people and 30% squircles for organizations. The rail's places are the one animated shape: a 48px tile that tightens from a 24px radius to 16px when hovered or current.

Edges are drawn with tone, not strokes. The only visible borders are the hairline row dividers inside panes, the 2px tab underline, the dashed `line` border of empty states, and the blockquote rule in rendered Markdown.

## Components

The kit's classes (`mk-btn`, `mk-input`, `mk-chip`, `mk-card`, `mk-popup`…) are the components; Tailwind utilities adjust and compose them. Interactive primitives come from Base UI (Dialog, Menu, Popover, Select, Toast, Tooltip), and icons from Phosphor (bold weight inside buttons and chips, fill for the current rail place and status icons).

### Buttons

- **Shape:** gently rounded (8px), 40px tall, 16px side padding, Figtree semibold body size; 32px tall and body-small in the small size, which is the default inside panes and toolbars.
- **Primary:** amber fill with signal-ink text. One per view (Clone, New repository, Create token, Save changes, the query bar's Run, the confirm inside a popover). On settings pages each card that saves on its own (General, Mirror) gets its own primary, so every save reads as one.
- **Default:** raised fill with ink text, stepping to pressed on hover. Used for secondary actions (Check again, Tag, Deprecate, Feeds and proxies).
- **Ghost:** transparent with muted text, raised fill on hover; for low-stakes actions (Keep it, Select all, clearing a range).
- **Danger:** filled red only as the confirming button inside a destructive dialog. Elsewhere destructive actions are **danger-ghost**: red text, red wash on hover.
- **Hover / Focus / Active:** 150ms color transitions; pressing nudges the button down 1px (not ghosts); focus shows the global 2px signal-line outline at 2px offset. Disabled drops to faint ink (primary falls back to the raised fill).
- **Busy:** a button whose request is running stays lit (`aria-busy`, still disabled for clicks) and swaps its label for a spinning CircleNotch and a present-participle (Saving…, Adding…, Syncing…), so a slow save never looks like nothing happened.
- **Icon-only:** square (40px, or 32px with a 6px radius when small), always wrapped in a tooltip and given an aria-label.

### Chips

- **Filter chip:** 28px pill, raised fill, muted body-small text; pressed state (`aria-pressed`) turns amber with signal-ink semibold text. Saved views and format filters are rows of these.
- **Tag:** a 20px non-interactive pill in micro text for labels: visibility, role, package format, status, short commit hashes (with mono). Tags stay 20px on phones (the one override `app.css` makes to the kit). Tags are read-only: at most three, then a faint "+N" (dist-tags in the version table). To filter by a tag, the package header shows each tag as a filter chip.

### Cards / Containers

- **Corner Style:** 12px.
- **Background:** pane on the page surface.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** none; inner sections are split by `line-soft` hairlines with a title row (`px-4 py-3`, title size).
- **Internal Padding:** 20px for `mk-card` (title, description, then a 20px-gap body); 16px horizontal for list panes.
- **Empty states:** either a card that teaches the next step (title, a 48ch description naming the command, often a sunken code block with the exact snippet), or the dashed `mk-empty` box for "no results match".
- **Strip:** a 12px-radius amber-wash bar with an amber dot, for in-progress notices with an action on the right (still importing, no CI runner, seed personas).

### Inputs / Fields

- **Style:** 44px tall, sunken fill, 8px radius, 14px padding, a 1px line-soft ring drawn with box-shadow; placeholders in faint ink. Code-like inputs (`mk-input--code`) switch to Geist Mono with slight tracking. Fields stack label (body-small semibold, muted), input and hint (body-small, faint) with 6px gaps; the hint is linked by `aria-describedby`.
- **Focus:** the fill brightens to rail and the ring becomes 2px signal-line.
- **Error / Disabled:** `aria-invalid` turns the ring red; the message sits below in red body-small (`mk-error`, `role="alert"`).
- **Search:** a magnifier inside the left padding. The package console's query bar is a mono search input whose submit button appears inside it only when the draft differs from the running query, with live help text below that turns red on a parse error.
- **Selects, segmented controls, radio cards:** Base UI Select on the input style with a float popup; `mk-segmented` (sunken track, raised current segment) for two to four exclusive choices; `mk-radio-card` rows for choices that need a description. Checkboxes are native, 16px, with `accent-signal`.

### Navigation

- **Rail:** 72px column on the rail tone. Places are 48px tiles (pane, muted icon at 22px) with a tooltip to the right; hover and current tighten the radius and lift to raised, and a 4px amber pip grows on the left edge (hidden on phones). Places, top to bottom: Home (the Pounce mark), search, Issue tracker, **Timelines**, Release notes, Needs you, Packages, Access tokens. Timelines is a first-class place with its own full-color mark (below) rather than a Phosphor glyph; Issue tracker, Timelines and Release notes keep you in the tracker you're viewing, and otherwise open your default one. Organizations appear as squircle monograms; the account sits at the foot as a circular monogram that opens a menu (profile, tokens, SSH keys, switch persona, theme radio, sign out). Under 640px the rail is a horizontal top bar.
- **Repository tabs:** semibold muted text with a 2px transparent bottom border on a `line-soft` baseline; the current tab turns ink with a signal-line underline. A tab stays current for all of its sub-pages.
- **Breadcrumbs:** body-small muted links separated by a faint slash.
- **Links:** in running text, ink with a 1px signal-line underline that thickens to 2px on hover (`link`); the same style in tables; there is no second link style. Links that are whole rows or titles carry no underline and change tone instead.

### Monograms

Initials on a low-chroma tint whose hue is hashed from the name (`oklch(0.36 0.05 hue)` with `oklch(0.92 0.04 hue)` text in dark; a pale plate with deep text in light), so people and orgs are recognizable without competing with amber. Circles for people, squircles for places.

### Floating surfaces

Popups, menus and popovers use the rail tone, 12px radius and the float shadow; options are 36px rows (44px on phones) with a 6px radius and a raised highlight. Dialogs are 28rem panes with a 24px pad; destructive confirms name the thing and the consequence, with a ghost "Keep it" on the left and the filled danger button on the right. Toasts stack top-right under the header.

### Motion

State changes are 150ms color transitions. Popups scale from 95% and fade in 150ms; dialogs scale from 97% in 200ms on the expo ease (`cubic-bezier(0.16, 1, 0.3, 1)`); backdrops fade in 200ms; toasts slide 12px in 250ms. New list rows and the selection bar rise 6px in 260ms (`mk-enter-up`). Navigation in progress dims the main column to 70% opacity rather than showing a spinner. Reduced motion keeps every fade and color change and drops all movement.

### Query console (signature component)

The package version explorer: a mono query bar with filter help, a row of saved-view chips, the publish-rate strip (a pane of teal columns with berry for retired versions, a raised backdrop on hover and an amber wash behind a brushed span; dragging across bars scopes the query to that time range), a virtualized version table in one pane (sticky label-size header, 40px rows, amber-wash selected rows, read-only tags and commit-hash chips, source and run as links, branch as a filter), and a sticky facet column of count bars (raised bars scaled to the largest count, amber wash when pressed). The header shows dist-tags as filter chips. Selecting rows raises a floating bar for bulk tag, deprecate, yank and delete. It is the reference for any future "lots of machine-made records" view: CI runs and commits should grow toward it, not away from it.

### Event log (tracker list)

The issue tracker's list is the query console's sibling at a larger scale: a mono query bar (syntax hint only while focused or when a token doesn't parse, and unknown tokens are named as ignored beside the count), saved-view chips, the brushable activity strip (teal opened, berry closed, the shared `ActivityStrip` component), then one 32px row per issue in a single virtualized pane. Columns join by container width so the title keeps its room first: state, key, title and age always; team and priority at 42rem; type at 56rem; assignee at 64rem. State reads as a dot alone when the words would repeat (an issue is open beside the log, or the query pins one state); the word stays in the tooltip and for screen readers. The 17rem facet column (count rows with a thin bar under each, amber wash when pressed) becomes the issue inspector when a row opens; on phones the facets, the count and the strip fold into one "Narrow it down" pane.

### Sign-in ledger

Signing in and approving `gm auth login` (`/signin`, `/device`) are their own pages: the app shell steps aside, leaving the darkest stage tone edge to edge, the Gitmatrix mark and wordmark top left, the host in mono top right, and one 30rem column. The flow is a **ledger** of three steps joined by a thread (`Step` in `AuthFrame.tsx`): the active step has an amber ring with an amber dot and opens to its content; a finished step settles into one row (a green check, its value, its time in tabular mono, a quiet Change) and greens the thread below it; a waiting step is a hollow ring in faint ink with its title alone. Email, then Code, then Signed in, which settles as "as <name>" for a moment before the redirect; a visitor who is already signed in sees all three settled with Continue, Sign out and Use another account. The code is six cells over one real input (`CodeCells`), so paste and the mail client's one-time-code autofill work and the sixth digit submits; the cell to type next takes the signal ring, a wrong code clears them with red rings and one error line. `/device` is the same ledger from gm's side: the code from your terminal (marked as a one-time code so password managers leave it alone), Approve or Deny, gm is signed in. In development, personas sit below a hairline as a compact list, never as the page.

### Board and the backlog digest

The board keeps one lane per status, each virtualized; Done and Canceled fold to a vertical count until opened. A backlog of thousands is groomed, not read, so the Backlog lane is a digest rather than a card stack: its total, one line on staleness ("N% untouched for 90+ days"), a group-by segmented control (priority, team, label, age), and count rows with a thin bar each. One group opens at a time to show its twelve most important issues (priority, then longest waiting) as one-line rows with their age, and "All N in the list" opens the same filter in the event log. To do stays a queue: its header splits ready from blocked, and ready work leads.

### Relationship lens

The tracker's graph view never draws the whole graph. One issue sits at the centre (raised card, amber ring); what blocks it fans out in columns to the left, one column per step up the chain (1 to 3, limited by width), what it blocks to the right; its parent trail sits above it and sub-issues (with a done/total bar) and related issues below. Every column is a plain list of cards, so nothing overlaps at any size; SVG connectors run only between neighbouring columns, red while the blocker is still open and `line` once resolved, and hovering a card dims every connector but its own. Clicking any card re-centres the lens with a view transition (cards that stay on screen glide 320ms on the expo ease; reduced motion cuts straight), and a trail of visited keys leads back. With nothing chosen it opens on where to start: find an issue, Bottlenecks (open issues blocking the most open work) and Furthest from ready (longest chains of blockers). The inspector opens beside the lens only on Details. Issues outside the current query still appear, at 60% opacity.

### Atlas (signature component)

The Knowledge tab is the Semantic Code Atlas: the repository as capability territory on one canvas, read from a bounded API, never the whole graph. Capabilities are regions in stable slots of a grid (a region keeps its place between builds while its identity holds), sized by a power-of-two bucket of the files that live there: area means "how many files", not importance. Structural groups (unclassified, concepts, folders) sit in a dashed band below. Opening a region nests its areas and files inside it, one page at a time; semantic zoom draws children and labels only once their cell reads on screen. The selection has an amber outline; regions changed in the latest build carry a berry dot. The inspector at right says what the selection is, why its members are grouped, what it uses and what uses it (a one-hop lens with honest caveats), and its source at immutable commits; the outline beside the map holds the same regions as an accessible list. The address holds the view (selection, snapshot, lens, lookup), so a copied link reopens the same place. States the map can't show are said in words above it (a build running, failed or behind, partial analysis, summaries off or paused) rather than drawn as empty. Across repositories, the workspace Atlas (`/:owner/-/atlas`) gives each repository its own column.

### Status by shape

When a state can't take a status hue, it takes a shape. A claimed issue (an agent holds a lease) uses a filled ink flag; an inherited lease uses an outlined faint-ink flag. In progress remains a filled ink dot, ready green, blocked red, waiting faint ink; agent checkpoints use the same filled flag. The shared claim mark appears in lists, boards, the relationship lens, legends and issue details. Compact state columns reserve 12px for icons, and hidden state words and tooltips retain ownership context. Data hues never mark a status.

## Do's and Don'ts

### Do:

- **Do** use Tailwind utilities on the kit's role names (`bg-pane`, `text-ink-faint`, `rounded-pane`, `text-body-sm`) and the `mk-*` component classes; reach for CSS only where utilities can't (rendered Markdown in `.gm-prose`, scrollbar theming, the phone override that keeps tags at 20px), and put it in `app.css`.
- **Do** keep `matrixkit.css` and `tokens.css` vendored as is; adjust the kit from `app.css` or with utilities, which win because the kit is imported into the components layer.
- **Do** list things in a single pane with `line-soft` hairline rows, 12px by 16px row padding and a `raised` hover.
- **Do** reserve amber for the primary action, the current place and what is selected or brushed (The One Amber Rule).
- **Do** set versions, hashes, commands, URLs and counts in Geist Mono, and use tabular figures for every number that lines up.
- **Do** give every icon-only control a tooltip and an aria-label, and every input a visible label.
- **Do** teach in empty states: say what will appear here and show the exact command or config that makes it appear.
- **Do** keep controls at 44px on phones (the kit's phone rule) and re-flow wide tables into two-line rows under 768px rather than scrolling them sideways.
- **Do** check both themes; anything built from roles will already work.
- **Do** give canvas views the kit's tonal stack (sunken, pane, surface, raised) for structure, and draw labels whole or not at all.
- **Do** explore relationships one hop at a time around a focus (the relationship lens), and let wide screens add columns of the same work.

### Don't:

- **Don't** use Tailwind's default palette or OKLCH literals in components; the default palette is deliberately reset away.
- **Don't** put borders or shadows on panes, cards or tables; separate them by tone and spacing.
- **Don't** put a shadow on anything that doesn't float (The Float-Only Shadow Rule).
- **Don't** use amber to mean warning or status; failure is red, success is green, waiting is faint ink.
- **Don't** use the data hues outside charts and their legend keys, and never for a status (a claim is an ink flag, not violet).
- **Don't** draw a whole dependency graph as a hairball, a force layout or a flame-graph mosaic; centre an issue and show its neighbours as lists.
- **Don't** stack separate cards for list items, or nest a card inside a card.
- **Don't** set text in uppercase with letter-spacing, or add small labels above headings; headings stand on their own.
- **Don't** step off the type scale with Tailwind's stock sizes (`text-xs`, `text-sm`); use `text-micro`, `text-body-sm` and the rest.
