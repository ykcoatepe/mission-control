---
name: Mission Control
description: A supervisory HMI in the manner of a railway signalling centre; quiet slate ground, colour only for abnormal state, the action, and four source lines.
colors:
  slate-ground: "#1a2029"
  rail-ground: "#161b23"
  surface-1: "#1f2632"
  surface-2: "#242c3a"
  surface-3: "#2b3444"
  hairline: "#303a4a"
  hairline-strong: "#45526a"
  neutral-track: "#7d8aa0"
  text-1: "#dde3ea"
  text-2: "#a9b4c2"
  text-3: "#8995a5"
  text-disabled: "#56617a"
  text-on-accent: "#0f1d1c"
  state-normal: "#c2ccd8"
  state-inactive: "#56617a"
  caution-amber: "#e0b060"
  caution-tint: "rgba(224, 176, 96, 0.1)"
  caution-line: "rgba(224, 176, 96, 0.45)"
  critical-soft-red: "#ea8079"
  critical-tint: "rgba(232, 115, 107, 0.11)"
  critical-line: "rgba(232, 115, 107, 0.45)"
  action-teal: "#5fb8b0"
  action-teal-hover: "#7ccbc4"
  action-tint: "rgba(95, 184, 176, 0.12)"
  action-line: "rgba(95, 184, 176, 0.45)"
  normal-band: "rgba(95, 184, 176, 0.28)"
  line-reference: "#6fb1e0"
  line-projects: "#7fc49a"
  line-agent: "#a99be8"
  line-curated: "#e08fb0"
typography:
  page-title:
    fontFamily: "Barlow, ui-sans-serif, -apple-system, BlinkMacSystemFont, Helvetica Neue, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 600
    lineHeight: 1.2
  alarm-word:
    fontFamily: "Barlow Semi Condensed, Barlow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.04em"
  block-header:
    fontFamily: "Barlow Semi Condensed, Barlow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "0.04em"
  stat-value:
    fontFamily: "Barlow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "Barlow, ui-sans-serif, -apple-system, BlinkMacSystemFont, Helvetica Neue, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    fontFeature: "tnum, lnum"
  lead:
    fontFamily: "Barlow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.45
  label:
    fontFamily: "Barlow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.45
  micro:
    fontFamily: "Barlow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.45
  data-mono:
    fontFamily: "JetBrains Mono Variable, JetBrains Mono, ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.92em"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  sm: "3px"
  md: "4px"
  lg: "6px"
  full: "999px"
spacing:
  sp-1: "4px"
  sp-2: "8px"
  sp-3: "12px"
  sp-4: "16px"
  sp-5: "20px"
  sp-6: "24px"
  sp-8: "32px"
  sp-12: "48px"
components:
  block:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.md}"
    padding: "16px"
  block-header:
    backgroundColor: "{colors.surface-1}"
    textColor: "{colors.text-1}"
    typography: "{typography.block-header}"
    padding: "4px 12px"
    height: "32px"
  block-header-source-group:
    backgroundColor: "{colors.line-reference}"
    textColor: "{colors.text-on-accent}"
    typography: "{typography.block-header}"
    padding: "4px 12px"
    height: "32px"
  alarm-line-caution:
    backgroundColor: "{colors.caution-tint}"
    textColor: "{colors.text-1}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "44px"
  alarm-line-critical:
    backgroundColor: "{colors.critical-tint}"
    textColor: "{colors.text-1}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    height: "44px"
  button-primary:
    backgroundColor: "transparent"
    textColor: "{colors.action-teal}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-primary-hover:
    backgroundColor: "{colors.action-teal}"
    textColor: "{colors.text-on-accent}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text-1}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  button-secondary-hover:
    backgroundColor: "{colors.surface-3}"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.critical-soft-red}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  input:
    backgroundColor: "{colors.slate-ground}"
    textColor: "{colors.text-1}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "32px"
  filter-chip:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "26px"
  filter-chip-selected:
    backgroundColor: "{colors.action-tint}"
    textColor: "{colors.action-teal}"
  nav-item:
    backgroundColor: "{colors.rail-ground}"
    textColor: "{colors.text-2}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "36px"
  nav-item-active:
    backgroundColor: "{colors.action-tint}"
    textColor: "{colors.action-teal}"
  top-bar:
    backgroundColor: "{colors.rail-ground}"
    textColor: "{colors.text-1}"
    height: "48px"
    padding: "0 16px"
  data-table-header:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-2}"
    typography: "{typography.label}"
    padding: "8px 12px"
  dialog:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.text-1}"
    rounded: "{rounded.md}"
    padding: "20px"
  toast:
    backgroundColor: "{colors.surface-3}"
    textColor: "{colors.text-1}"
    rounded: "{rounded.md}"
    padding: "8px 8px 8px 12px"
---

# Design System: Mission Control

## Overview

**Creative North Star: "The Signalling Centre"**

Mission Control is a supervisory human-machine interface in the manner of a railway signalling centre. The brain is a station fed by four coloured lines, and the whole app, not only the Brain page, speaks that language: a deep blue-grey slate ground, soft off-white lettering, hairline outlines, and no shadows. It is built to sit open on a second screen all day and be read out of the corner of the eye: if nothing is coloured, nothing needs the operator.

The system is deliberately quiet. A normal state has no colour at all; it is a neutral grey-white mark. Colour is rationed to exactly three jobs: abnormal state (amber caution, soft red critical), the action colour teal (what can be done, what is selected, focus), and four line colours that identify the four GBrain source groups. Nothing else is coloured. Structure comes from 1px outlines, steps of lightness between grounds, condensed capitals in block headers, and tabular numerals that align.

Depth is lightness, not light: there are no shadows, gradients, glow or blur. Standard web controls only; the world borrows a signalling centre's type, palette, density and one signature move (sources drawn as coloured tracks into a core, plus a to-scale line profile) and builds no fake hardware, bezels or instrument costumes. It rejects the stack of equal-weight admin cards and the dashboard that is always lit.

**Key Characteristics:**
- Normal is quiet: neutral grey-white, never green.
- Colour has three jobs only: abnormal state, action/selection, source-group identity.
- State is a shape plus a word, never colour alone.
- Hairline-outlined blocks with condensed-capital headers; no cards, no shadows.
- Tabular numerals; analog bars with a marked normal band; real observed times only.
- Two themes from one token set: Slate dusk (dark, default) and Soft daylight (light).

## Colors

A cool slate palette where the only chroma on screen belongs to something abnormal, something actionable, or one of four source lines. Frontmatter values are Slate dusk (dark, the default). Every colour is a CSS custom property in `frontend/src/styles/tokens.css`; components use tokens only, never literals.

### Primary
- **Action Teal** (#5fb8b0): links, the primary button outline and text, focus rings, the selected rail item, selected chips, selected rows. Also the 2px bar at the left edge of the active nav item. Hover lifts to a lighter teal (#7ccbc4). Its tint (12% teal) is the selected ground; its 45% line is the selected border.

### Secondary
- **Source Lines** (identity only): **Reference Blue** (#6fb1e0), **Projects Green** (#7fc49a), **Agent Violet** (#a99be8), **Curated Rose** (#e08fb0). They colour a source group's block header, track, tick marks and line-profile stroke, and serve as chart series 1-4. They never carry state. The green is a group identity, not an "OK" signal.

### Tertiary
- **Caution Amber** (#e0b060): caution state only. Always accompanied by the triangle mark and the word "Caution". Has a 10% tint ground and a 45% line.
- **Critical Soft Red** (#ea8079): critical state only. Always accompanied by the filled square and the word "Critical". Has an 11% tint ground and a 45% line. A soft red, lifted so critical text passes 4.5:1 on its own tint.

### Neutral
- **Slate Ground** (#1a2029): the page ground and the input fill.
- **Rail Ground** (#161b23): the side rail and the top bar, one step darker than the page.
- **Surface 1 / 2 / 3** (#1f2632, #242c3a, #2b3444): blocks, then raised panels and dialogs, then toasts and table hover. Elevation is a step in lightness.
- **Hairline / Hairline Strong** (#303a4a, #45526a): inner dividers; block, table-header and card outlines.
- **Neutral Track** (#7d8aa0): the neutral diagram line, and the outline of inputs and buttons (`--control-line`, same value, held at 3:1 or better against the grounds).
- **Text 1 / 2 / 3** (#dde3ea, #a9b4c2, #8995a5): values and titles; body; labels and metadata (12px and larger only, never on surface-3). **Disabled** (#56617a) and **Inactive** (#56617a) are exempt from contrast because they never carry the only copy of a message.
- **State Normal** (#c2ccd8): the neutral mark of a healthy reading. **Normal Band** (teal at 28%) marks the acceptable range on an analog bar.
- **Text on Accent** (#0f1d1c): the dark ink on teal fills and on source-group header fills.

### Soft daylight (light theme)
The same tokens, redefined under `:root[data-theme='light']` on a warm paper ground: ground #e7e5e0, rail #dcd9d3, surface-1 #f0eee9, surface-2 #e9e6e0, surface-3 #dedad3, hairline #cfcac2, hairline-strong #a9a39a, text #2a2826 / #55504a / #635e59, caution #825000, critical #ac352d, action teal #1b615d, lines #2b76b0 / #2f8558 / #6a55c8 / #b0477a, text on accent #ffffff. Values were darkened from a first draft to reach 4.5:1 on the rail and on their own tints. Full light ramps are in the sidecar.

### Named Rules
**The Quiet Normal Rule.** A normal reading has no colour. Neutral grey-white mark, neutral text. There is no green "OK" anywhere. If the whole screen is neutral, nothing is wrong.

**The Three Jobs Rule.** Colour does exactly three things: abnormal state, action/selection, source-group identity. A colour that does none of the three is a defect.

**The Shape Plus Word Rule.** State is never colour alone. Every state is a shape and a word: normal a small filled circle ("Normal"), caution a triangle ("Caution"), critical a filled square ("Critical"), not read a hollow circle ("Not read"), off a short dash ("Off").

**The Line Colour Identity Rule.** The four line colours name which source group something belongs to and nothing else. They are not state, not decoration, not a second accent.

## Typography

**Display Font:** none; there is no display face. The largest text is a 26px h1 token used on the Setup and Usage pages.
**Body Font:** Barlow (400, 500, 600) with system sans fallbacks
**Label/Mono Font:** Barlow Semi Condensed 600 (uppercase, headings only); JetBrains Mono Variable for ids, slugs and cron expressions

**Character:** Barlow is a friendly-technical grotesque with signage lineage; Barlow Semi Condensed in capitals gives block headers the stamped, panel-label voice of a control room. Numbers are tabular and lining everywhere so columns and readings align.

### Hierarchy
- **Page title** (600, 21px, 1.2): the single `h1`, shown once in the top bar; pages never render their own.
- **Alarm word** (Semi Condensed 600, 17px, 0.04em, uppercase): "CAUTION" / "CRITICAL" in the alarm line.
- **Block header** (Semi Condensed 600, 14px, 0.04em, uppercase): block titles; the count or total at the right uses the same family at 14px/600 in text-2.
- **Stat value** (600, 21px, 1.2): the figure in a stat strip.
- **Lead** (600, 15px): alarm sentence, analog-bar value, nav item label (400).
- **Body** (400, 14px, 1.45): default text, table cells, buttons (500).
- **Label** (500, 13px): field and column labels, chips; sentence case, text-2 or text-3.
- **Micro** (400, 12px): scale limits, trend ends, line-profile labels.
- **Data** (JetBrains Mono, 0.92em): ids and expressions; ligatures off so text reads exactly as stored.

### Named Rules
**The Capitals Are Panel Labels Rule.** Condensed capitals appear in block headers, the alarm state word and the diagram's block labels, nowhere else. Everything else is sentence case.

**The Tabular Numerals Rule.** Tabular lining numerals are set on `body`; any number that aligns in a column or a bar stays tabular.

**The Three Weights Rule.** Weights are 400, 500, 600 only. No bold, no light.

## Layout

A fixed two-column shell: side rail (224px, collapsing to a 56px icon rail with tooltips; an off-canvas drawer under 900px) and a workspace of a 48px top bar over a scrolling main area. Page content is a flex column with a 16px gap, capped at 1600px wide (a 960px "narrow" frame exists), with 16px by 24px padding (16px on mobile). Spacing is a 4px grid: 4, 8, 12, 16, 20, 24, 32, 48. No 7/9/13px values.

Each page follows one blueprint: alarm line (only when abnormal), summary line, the list or chart that matters, detail in a drawer. The Brain page answers its question above the fold: a two-column top where the track diagram takes the remaining width and a fixed 320px column holds three analog bars (stacked under 1100px, where the bars sit side by side), then the to-scale line profile, then the readings table. Responsive behaviour is by container query where the part owns its width: the track diagram becomes a list under 760px of room, the line profile lies its lines down under 900px, and the top bar yields in a fixed order (stale note, state words, names, search text, then one status button). Tables stack as label/value pairs under 700px. Target range 375px to 1600px+, no horizontal page scroll.

Density is control-room dense: 32px controls (26px small), 36px nav rows, 44px minimum alarm line, rows around 28 to 36px. Hairline rules, not whitespace, separate siblings inside a block.

## Elevation & Depth

Flat. There are no shadows, gradients, glow or blur anywhere in the build; the one `box-shadow` in the source is a `none` override on the Recharts tooltip. Depth is a step in lightness: rail ground below page ground below surface-1 (blocks) below surface-2 (dialogs, table headers, panels) below surface-3 (toasts, hover). Overlays use a flat scrim (60% dark in dusk, 32% in daylight) and a 1px outline, not a drop shadow. Z-layers are tokens (sticky 10, drawer 40, overlay 60, palette 80, toast 100).

### Named Rules
**The Lightness Step Rule.** Raise a thing by making its ground one step lighter and giving it a 1px outline, never by shadowing it.

**The Never Nested Rule.** A block never sits inside a block. Inside, use hairline dividers.

## Shapes

Small, square-shouldered, outlined. Corners are 3px (rows, nav items, kbd, segments), 4px (blocks, buttons, inputs, chips, dialogs, alarm line, toasts) and 6px (the command palette and period controls). The full pill is reserved for the Switch track, spinner and scrollbar thumb. Every container is defined by a 1px hairline-strong outline; the selected item is defined by a teal outline or a teal 2px bar. Source-group blocks take their line colour as the outline and as a filled header. State marks are 12px glyphs on a 12x12 grid (20px in the alarm line). The diagram uses rails (2.5px stroke) with a dotted sleeper pattern, bumper stops, and a squared core frame.

## Components

Standard web controls, restyled by tokens; nothing mimics hardware.

### Buttons
- **Shape:** 4px radius, 32px high (26px small), 12px side padding, 14px/500.
- **Primary:** transparent with a teal outline and teal text; filled teal with dark ink only on hover and while pressed. One primary per view.
- **Secondary:** transparent with a neutral-track outline and text-1; surface-3 on hover. **Ghost:** no outline, text-2, surface-2 on hover. **Danger:** a soft-red outline and text, tinted on hover.
- **Focus:** 2px teal outline, 2px offset. Disabled drops to text-disabled with a hairline border. Loading shows a 12px spinner and `aria-busy`.

### Chips and segmented control
- **Filter chip:** 26px high, outlined in the neutral track, label 13px/500 text-2; selected is the action tint with a teal 45% line and teal text. Counts are real counts only.
- **Segmented control:** an outlined group of radio segments; the selected segment takes the same action tint.

### Blocks (cards replaced)
- **Corner / border:** 4px radius, 1px hairline-strong outline, surface-1 ground, 16px padding (12px small, none for tables).
- **Header:** 32px, hairline underneath, title in condensed capitals at the left, count or total at the right, optional small actions.
- **Source-group tone:** the outline and the whole header fill take the group's line colour; header text is the dark on-accent ink. Identity only.
- **Shadow:** none.

### Alarm line
One per page, only when something is abnormal, absent otherwise (never a green "all good" banner). A tinted strip (44px minimum) with the state mark at 20px and the state word in condensed capitals at 17px, a divider, the plain sentence (15px/600) with detail (13px text-2), and at most one primary action at the right end. `role="alert"` for critical, `role="status"` for caution.

### Analog bar (signature)
For any number with a normal range: a 10px track with a marked normal band (teal at 28%), a fill (neutral, 55% opacity), a 2px pointer taller than the track, labelled limits underneath at 12px, the value as digits, and a 24-hour trend line when two or more real readings exist. Outside the band it turns amber with a triangle and "below normal / above normal". Unread shows a hollow circle and "not read", with no value, pointer or trend. The thin `Meter` (6px) is the band-less variant.

### Inputs / Fields
- **Style:** 32px, slate-ground fill, 1px neutral-track outline, 4px radius, 14px text-1; hover brightens the outline to text-3.
- **Focus:** teal outline plus teal border. **Error:** soft-red border (`aria-invalid`). **Disabled:** surface-1 fill, hairline border, disabled text.
- Search input carries a leading icon and a clear control; Esc clears.

### Navigation
- **Side rail:** a flat list of 36px rows at 15px, text-2, hairline-free; hover lifts to surface-1; the selected row is a teal tint ground, teal text and icon, weight 500, and a 2px teal bar at the left edge. Lucide icons at one stroke weight. Collapsed, labels hide and tooltips appear on hover and focus; badges sit at the corner in a small outlined chip.
- **Nav badge:** the state's mark plus the count (caps at 999+), neutral, amber or soft red. Renders nothing at zero. A count that could not be read is a hollow circle, never a number. It counts only new, actionable, unacknowledged items.
- **Top bar:** 48px on the rail ground, page title at 21px/600, then three annunciators (mark + name + state word), the command-palette field (280px, "Search or run..."), refresh and theme toggle.
- **Tabs:** 36px, text-2, selected text-1 with a 2px teal underline.

### Annunciators
A system reading: 12px state mark, name in 600, state word. The mark and word take colour only when caution or critical; unread shows a hollow circle and "not read". Yields to marks only and then to one status button as the bar narrows.

### Tables
Dense, sticky header on surface-2 with a hairline-strong underline, 13px/600 text-2 column labels, 14px cells with 8px by 12px padding, hairline row dividers, tabular numerals, row hover to surface-2, selected row in the action tint, dimmed rows by colour (never opacity). Under 700px rows stack.

### Track diagram (signature)
The Brain page's centre: four source-group blocks (header in the line colour, rows of sources with their counts), four coloured tracks (2.5px rails with sleeper dots and a bumper) running into a squared GBRAIN CORE block (surface-2, 2px text-2 outline, 21px caps title) with its readings, an embedding-queue siding below drawn as numbered unit cells (active units filled text-2), and four reader blocks in hairline outlines. The selected element takes a 2px teal outline. Under 760px of room the same readings become a list.

### Line profile (signature)
All sources drawn to scale as 3px vertical lines in their group colour on one baseline, counts above, full source ids standing beneath reading upward; a source with sync off is the same line dashed. Under 900px the lines lie down as 2px bars, one row per source.

### Overlays and feedback
- **Dialog:** surface-2, 1px outline, 4px radius, 20px padding, 420px wide (600 for md), flat scrim; consequential confirmations use `alertdialog`, safest control autofocused. **Drawer** (480 / 720px) holds evidence and detail.
- **Notice:** quiet surface-1 outline; tinted with its mark only for caution and critical.
- **Toast:** surface-3 with an outline, bottom right, tone marked by shape.
- **Freshness:** a fresh reading is not annotated; stale is a caution mark and "as of 12:41"; unread is a hollow circle and "not read".
- **Skeleton:** static, no shimmer.

### Motion
Motion is a state-change cue only: 120ms (fast) for hover, colour and border, 180ms (base) for bar position and drawer slide, easing `cubic-bezier(0.2, 0, 0, 1)`. No entrance animation on data, no hover lift. Spinners rotate at 800ms. `prefers-reduced-motion` collapses all durations.

## Do's and Don'ts

### Do:
- **Do** leave a normal reading neutral (state-normal, grey-white mark, text-2); let abnormal alone take colour.
- **Do** pair every state with its shape and its word; use a hollow circle and "not read" when a value was not observed, never `0` or a guess.
- **Do** use one alarm line per page, only when abnormal, with at most one action at its right end.
- **Do** show numbers that have a normal range as analog bars with the band marked, and draw the 24-hour trend only when two real readings exist.
- **Do** use `Block` with a 1px hairline-strong outline, 4px radius and a condensed-capital header; put counts at the header's right.
- **Do** raise surfaces by a lightness step plus an outline; express selection and action in teal (outline, tint, 2px bar).
- **Do** use only tokens from `tokens.css`; set numbers in tabular lining numerals; keep spacing on the 4px grid and weights at 400/500/600.
- **Do** give every control a visible 2px teal focus ring with a 2px offset, and at least 24px of height.
- **Do** annotate a reading with where it came from only when it is stale or unread.

### Don't:
- **Don't** use green for "OK" or any colour for normal state; the project green is a source-group line colour only.
- **Don't** use a line colour for state, decoration or a second accent, and don't use teal for state.
- **Don't** use shadows, gradients, glow, blur, entrance animation or hover lift.
- **Don't** convey state by colour alone, and don't put text-3 on surface-3.
- **Don't** nest a block in a block, or build a page as a stack of equal-weight cards.
- **Don't** use condensed capitals outside block headers, the alarm word and diagram block labels.
- **Don't** draw fake hardware: no bezels, LEDs, knobs, skeuomorphic gauges or instrument costumes. Other pages do not draw tracks; tracks belong to the Brain page.
- **Don't** put a green "all good" banner or an always-lit dashboard on the screen; absence of an alarm is the message.
- **Don't** show restricted project content or invent history, times or counts the server did not read.
