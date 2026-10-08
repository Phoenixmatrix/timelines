---
name: Gitmatrix — MatrixKit Neo
description: Warm charcoal work surfaces, readable engineering context and one amber action signal.
colors:
  stage: "oklch(0.145 0.005 70)"
  rail: "oklch(0.175 0.006 70)"
  sunken: "oklch(0.19 0.006 70)"
  pane: "oklch(0.205 0.006 70)"
  surface: "oklch(0.235 0.007 70)"
  raised: "oklch(0.275 0.008 70)"
  line: "oklch(0.32 0.008 70)"
  ink: "oklch(0.945 0.008 80)"
  ink-muted: "oklch(0.76 0.012 75)"
  ink-faint: "oklch(0.64 0.012 75)"
  brand: "#91f5be"
  signal: "oklch(0.81 0.145 76)"
  signal-ink: "oklch(0.23 0.035 65)"
  danger-text: "oklch(0.72 0.16 25)"
  online: "oklch(0.74 0.14 155)"
  data-violet: "oklch(0.8 0.1 290)"
typography:
  display:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: "2.25rem"
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: "1.9rem"
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 700
    lineHeight: "1.5rem"
  body:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.9375rem"
    lineHeight: "1.45rem"
  field-label:
    fontFamily: "Figtree Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: "1.25rem"
rounded:
  plate: "6px"
  control: "8px"
  pane: "12px"
  tile: "14px"
spacing:
  hair: "4px"
  small: "8px"
  medium: "12px"
  large: "16px"
  extra-large: "24px"
  section: "48px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.signal-ink}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 16px"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "40px"
    padding: "0 16px"
  input:
    backgroundColor: "{colors.sunken}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "44px"
    padding: "0 14px"
---

# Design System: Gitmatrix

## Overview

**Creative North Star: "MatrixKit Neo"**

Preserve the incumbent Gitmatrix identity: warm charcoal panes, Figtree text, Geist Mono identifiers and restrained amber actions. The product is a working environment for humans and agents, not a marketing dashboard. Hierarchy comes from readable content, tonal surfaces and explicit state.

**Key Characteristics:**

- Compact, readable engineering interfaces.
- Tonal depth with amber selection and primary actions.
- Persistent context and visible recovery from uncertainty.

This is an extraction of the approved existing system, not a new visual direction. Runtime tokens live in `src/styles/tokens.css`; shared components in `src/styles/matrixkit.css`, `src/styles/app.css` and `src/components/ui.tsx`. The frontmatter records the dark home theme. The existing light-theme overrides remain authoritative; components consume semantic variables rather than copying dark values.

The tracker received a dual-assessor Claude CLI / Impeccable re-review with a **SHIP** verdict and no P0/P1 findings. Remaining P2/P3 findings were corrected and verified in the live browser: semantic conflict comparisons, closed-work recovery, opt-in shortcuts, immutable administration metadata, compact graph overview, and responsive controls. Review captures are local verification evidence, not production assets.

## Brand identity

The approved **Pounce** identity is a nimble cat formed from flowing paths that separate and rejoin: cats, parallel agents and fast development, without a generic lettermark. The user selected this generated silhouette as “perfect”; preserve it rather than redesigning or replacing the cat. It replaces the former angular G.

`public/brand/gitmatrix.svg` is the scalable source, with separate `mark` and `wordmark` groups. `src/components/GitmatrixLogo.tsx` references those groups: the mark uses `brand` (mint `#91f5be` in dark, deep forest `#10251c` in light), and the lettering uses `ink`. Brand color is confined to the identity; amber actions and existing status colors remain unchanged. Use the full lockup on Home and in the shared authentication frame (SignIn and device authorization); use only the mark in the compact navigation rail. Preserve its aspect ratio and the existing accessible navigation labels.

The cat was generated with `openai-codex/gpt-image-2-codex` and vector-traced from the approved artwork. The lowercase wordmark preserves the selected viewer pairing: the existing Figtree Variable font at weight 730 with -0.03em tracking, shaped and outlined so no font loading is needed to render the logo. SVG metadata preserves the generation prompt, approval and lettering provenance; do not substitute a stock symbol or retype the outlined wordmark.

`public/favicon.svg` uses the same Pounce paths in mint (`#91f5be`) on a deep-forest (`#10251c`) rounded tile. Paths are embedded rather than externally referenced so the favicon works independently. Derive the 32px PNG, 180px Apple touch icon and 16/32/48px ICO from this favicon artwork; the PNGs also carry generation provenance. The component and `index.html` version every logo/icon URL with `v=pounce` so cached G artwork is replaced in SVG, raster and touch-icon consumers.

### Timelines mark

Timelines are a first-class place, so they get a mark of their own in the rail instead of a Phosphor glyph: a mint trunk forks into amber, violet and sky lines that run in parallel and merge back into mint (fork, work alongside, land). It was generated with `openai-codex/gpt-image-2-codex` through the Codex CLI. Eight candidates over two rounds; the second round asked for a compact, square composition with heavy ribbons so every color reads at 28px. The selected artwork was snapped to its four flat colors and vector-traced (cutout mode, no white shapes), not redrawn.

`public/brand/timelines.svg` holds the paths in a `mark` group, with the generation prompt, selection and conversion in its metadata; `TimelinesMark` in `src/components/GitmatrixLogo.tsx` references it at 28px in the 48px rail tile. Its fills read the `--timelines-mint/amber/violet/sky` tokens: the generated pastels on dark, and deeper shades on light (each at least 3:1 against the rail) the way the Pounce cat switches to forest. Like `--brand`, these colors belong to the mark alone and never style interface state. Bump `?v=` on the reference when the artwork changes.

The rail has one Timelines control (CORE-218): its branded mark opens quick scope switching and the timeline graph, instead of separate switcher and graph buttons. The tile marks the graph as the current place; the amber dot still marks a selected timeline on other pages. Search, ended timelines and the scope banner remain available. The graph action stays reachable while the list loads or fails, using the current account or the default-tracker route when no account is resolved.

Settings retain the account named by `?owner=` when opening timelines, even when another tracker is the user's default. Preferences also retains its `?tracker=` context when no `owner` is supplied.

## Colors

### Primary

**Amber signal** marks primary actions, selection, focus, the caret and links. Its wash distinguishes selected rows without making every container an accent surface.

### Secondary

**Ready green** identifies actionable work and completion evidence. Ready labels mix the online token with 20% ink for readable contrast in both themes; the verified light ready label measures 4.95:1 against its pane. Claims and checkpoints use neutral ink flags rather than a separate status hue. Labels accompany state marks.

### Neutral

Warm charcoal steps separate the stage, rail, recessed fields, detail panes and raised controls. Bright ink carries content; muted ink carries metadata; faint ink carries hints. Use the established line tokens for separators rather than introducing independent gray values.

**The State Meaning Rule.** Amber means action or selection, green means ready/evidence, neutral flags mean claim/checkpoint, a neutral hollow square means work waiting in sub-issues (a container), and danger tokens mean blocked work or a conflict requiring attention.

## Typography

Figtree Variable is self-hosted for ordinary text, labels and headings. Geist Mono Variable is self-hosted for issue keys, code and tabular identifiers, not whole prose sections. The fixed hierarchy is defined in the frontmatter and `app.css`; ordinary Markdown has a maximum measure of 72ch. Headings balance; long identifiers and titles wrap rather than overflowing.

## Layout

The global navigation is a narrow vertical rail on desktop and a sticky horizontal rail below 640px. Shared spacing is compact within a control group and generous between sections.

The tracker-specific approved composition is recorded in `.impeccable/surfaces/src-routes-tracker-tracker-tsx.md`: capture and scope controls above a 42/58 selection/detail split, independently scrolling above 760px. The board and dependency graph remain in the selection pane. On phones the selected issue replaces the collection; filters and account actions progressively disclose. Tracker controls retain 44px touch targets through 760px, and the return link clears the sticky navigation. This split is a surface decision, not a requirement for unrelated pages.

The assistant reserves a 26rem desktop dock from 1280px upward. Expanding it overlays the page with a wider panel, capped at 72rem, without changing that reserved column or shrinking the underlying page further. Collapse preserves the conversation and draft; Escape collapses the expanded panel first. Below the docking breakpoint it floats, and below 640px it already fills the screen.

## Elevation & Depth

Tonal layering does most of the work. Floating menus and popovers use the existing soft, offset `shadow-float` token; the dock uses `shadow-dock`. Ordinary sections use restrained separators. Selected rows and focused fields use the incumbent fine signal stroke rather than decorative shadows. Motion is limited to established short state transitions and respects reduced-motion preferences.

## Shapes

Controls have gently rounded corners, panes slightly broader corners, and tags are compact pills. Navigation uses the incumbent rounded-place shape. Keep the established radius tokens; do not introduce a separate radius scale for tracker features.

## Components

### Buttons and fields

Primary buttons use amber with dark signal ink; secondary buttons use a raised neutral surface. Ghost actions are visually subordinate. Disabled controls retain readable labels and explain invalid actions nearby. Fields are recessed, with a clear focus treatment and action-local errors. Use the existing Base UI select/combobox components and native controls rather than simulating interactions with generic elements.

Tracker capture is a split action: **Create** remains the default submission, with a compact issue-type selector; the adjacent arrow reveals **Add details**, carrying the parsed title, tags, type, team and workspace scope into the dialog. Leading `(tag)` prefixes resolve against the shared catalog; unknown names require explicit inline definition before creation. Tags use a searchable Base UI combobox with keyboard selection, inline creation, and removable selections in both creation and editing. Keep the expanded path subordinate rather than presenting two competing primary buttons.

Pickup is separate from issue status: **Anyone**, **Not ready**, or **Human only**.
Use the shared select in creation details and the autosaving editor, with a
screen-reader-associated explanation. Restricted pickup has a neutral state
mark and explicit text, never the green Ready mark. Capability and assignment
explanations must not imply they bypass pickup restrictions.

The assistant composer starts at one row for short prompts, grows to a capped height and scrolls longer drafts within the field. Its containing form can scroll in short viewports without taking over conversation scrolling. **In context:** names the page included with the next message; removing it changes the label to **Not in context:** and the control to a plus for re-inclusion. This affects subsequent messages, not context already sent.

### Navigation and metadata

Navigation uses links; view toggles use pressed buttons. Workspace names are underlined links in labelled metadata, while issue tags stay inert chips. Repeated actions name their issue, repository or workspace in accessible labels.

Same-origin absolute links in tracker Markdown use client-side navigation; external links, modified clicks, relative links and fragments retain browser behavior. Tracker search treats bare numbers and full issue keys as exact ticket lookups, even when quoted; other words and quoted phrases search keys, titles and tags. Keep filter and exclusion semantics intact.

### Issue selection and handoff

A selected issue row uses a subtle amber wash. Readiness combines a text label and a state mark: a filled ink flag for a direct claim, an outlined faint-ink flag for an inherited lease, a hollow muted-ink square for a container whose work is in its open sub-issues (see "Status by shape" in the root DESIGN.md). Issue details say why an issue isn't ready in one line. Parent hierarchy, blockers and related links are separately labelled. Checkpoints carry the same filled flag and evidence a green dot; the latest checkpoint sits near the issue header. The list, relationship lens and Atlas are recorded in the root DESIGN.md.

### Conflict comparison

Attention styling distinguishes conflicts from selection. Compare only differing fields, with readable names and Markdown, explicit per-field choices and an explicit rebase action. Group untouched remote differences under “Changed by others” without misleading choice buttons. Tags and workspace membership compare as normalized sets. The visual affordance must match data preservation: untouched remote fields remain remote, and failed saves keep the draft.

## Do's and Don'ts

### Do:

- **Do** reuse semantic runtime tokens and existing component states.
- **Do** preserve visible keyboard focus, readable labels and explicit disabled-action explanations.
- **Do** keep long-form context readable and mobile controls reachable.
- **Do** distinguish navigation, inert metadata and mutation actions.

### Don't:

- **Don't** rebrand this extension or substitute a new visual world.
- **Don't** use color alone to communicate ownership, readiness or conflict.
- **Don't** hide uncertain writes or discard a draft to make the interface look successful.
- **Don't** invent product claims, decorative charts or production demonstration records.
