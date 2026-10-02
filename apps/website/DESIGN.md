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

## Colors

### Primary

**Amber signal** marks primary actions, selection, focus, the caret and links. Its wash distinguishes selected rows without making every container an accent surface.

### Secondary

**Ready green** identifies actionable work and completion evidence. Ready labels mix the online token with 20% ink for readable contrast in both themes; the verified light ready label measures 4.95:1 against its pane. **Claim violet** identifies exclusive agent ownership and checkpoints. These are semantic state channels, not competing brand accents. Labels accompany color.

### Neutral

Warm charcoal steps separate the stage, rail, recessed fields, detail panes and raised controls. Bright ink carries content; muted ink carries metadata; faint ink carries hints. Use the established line tokens for separators rather than introducing independent gray values.

**The State Meaning Rule.** Amber means action or selection, green means ready/evidence, violet means claim/checkpoint, and danger tokens mean blocked work or a conflict requiring attention.

## Typography

Figtree Variable is self-hosted for ordinary text, labels and headings. Geist Mono Variable is self-hosted for issue keys, code and tabular identifiers, not whole prose sections. The fixed hierarchy is defined in the frontmatter and `app.css`; ordinary Markdown has a maximum measure of 72ch. Headings balance; long identifiers and titles wrap rather than overflowing.

## Layout

The global navigation is a narrow vertical rail on desktop and a sticky horizontal rail below 640px. Shared spacing is compact within a control group and generous between sections.

The tracker-specific approved composition is recorded in `.impeccable/surfaces/src-routes-tracker-tracker-tsx.md`: capture and scope controls above a 42/58 selection/detail split, independently scrolling above 760px. The board and dependency graph remain in the selection pane. On phones the selected issue replaces the collection; filters and account actions progressively disclose. Tracker controls retain 44px touch targets through 760px, and the return link clears the sticky navigation. This split is a surface decision, not a requirement for unrelated pages.

## Elevation & Depth

Tonal layering does most of the work. Floating menus and popovers use the existing soft, offset `shadow-float` token; the dock uses `shadow-dock`. Ordinary sections use restrained separators. Selected rows and focused fields use the incumbent fine signal stroke rather than decorative shadows. Motion is limited to established short state transitions and respects reduced-motion preferences.

## Shapes

Controls have gently rounded corners, panes slightly broader corners, and tags are compact pills. Navigation uses the incumbent rounded-place shape. Keep the established radius tokens; do not introduce a separate radius scale for tracker features.

## Components

### Buttons and fields

Primary buttons use amber with dark signal ink; secondary buttons use a raised neutral surface. Ghost actions are visually subordinate. Disabled controls retain readable labels and explain invalid actions nearby. Fields are recessed, with a clear focus treatment and action-local errors. Use the existing Base UI select/combobox components and native controls rather than simulating interactions with generic elements.

### Navigation and metadata

Navigation uses links; view toggles use pressed buttons. Workspace names are underlined links in labelled metadata, while labels remain inert tags. Repeated actions name their issue, repository or workspace in accessible labels.

### Issue selection and handoff

A selected issue row uses a subtle amber wash. Readiness combines a text label and a state dot (a hollow ink ring for a claim; see "Status by shape" in the root DESIGN.md). Parent hierarchy, blockers and related links are separately labelled. Checkpoints carry the same ink ring and evidence a green dot; the latest checkpoint sits near the issue header. The list, relationship lens and Atlas are recorded in the root DESIGN.md.

### Conflict comparison

Attention styling distinguishes conflicts from selection. Compare only differing fields, with readable names and Markdown, explicit per-field choices and an explicit rebase action. Group untouched remote differences under “Changed by others” without misleading choice buttons. Labels and workspace membership compare as normalized sets. The visual affordance must match data preservation: untouched remote fields remain remote, and failed saves keep the draft.

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
