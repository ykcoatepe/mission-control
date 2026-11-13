# Design System Reference — a supervisory HMI

This is the binding design reference for the Mission Control frontend. One
world for every page: a supervisory human-machine interface in the manner of a
railway signalling centre. Tokens live in `frontend/src/styles/tokens.css`;
shared components live in `frontend/src/components/ui/`. The approved Brain page
and its light theme are the visual reference
(`/Volumes/External SSD/Yordam-Agent-Work/mission-control-rehaul/hmi/`).

## 1. The HMI rules

These twelve rules are binding on every page.

1. **Normal is quiet.** A normal state has no colour: neutral grey-white marks
   and text. There is no green "OK" anywhere.
2. **Colour has exactly three jobs.** (a) Abnormal state: amber = caution, soft
   red = critical, always paired with a shape and a word. (b) Teal = what the
   operator can do (links, primary action, focus) or what is selected. (c) The
   four line colours identify the four GBrain source groups and are used only
   for that (and as chart series on the Brain page). Charts elsewhere use the
   separate `--chart-1..6` ramp. One stated exception to (b): the measured fill
   of an analog bar is teal-toned (`--bar-fill`), as in the approved reference,
   so a reading and its normal band read apart at a glance; when the reading is
   abnormal the fill takes the state colour. Nothing
   decorative is coloured.
3. **State is never colour alone.** Normal = small filled circle (neutral);
   caution = triangle (amber); critical = filled square (soft red); not read =
   hollow circle (neutral); off / intentionally inactive = short horizontal
   dash (neutral).
4. **One alarm line per page**, at the top of the work area, only when the page
   has something abnormal: state word, a plain sentence and at most one action at
   its right end. When nothing is abnormal the line is absent (not a green "all
   good" banner); the page may show one quiet sentence instead.
5. **A number with a normal range is an analog bar**: track, normal band,
   pointer and fill at the value, limits labelled, value as digits, and a
   24-hour trend line when history really exists. Never invent history; with no
   history there is no trend.
6. **Blocks, not cards.** 1px outline, small radius, header in condensed
   capitals with the count or total at the right. No shadows, gradients, glow or
   blur, no nested cards. Equal-weight card grids are not a page structure.
7. **Tables for lists.** Tabular numerals wherever numbers align. Times are real
   observed times.
8. **A reading carries where it came from only when stale or unread.** Stale =
   "as of 12:41" with a caution mark; unread = hollow circle + "not read". Fresh
   readings are not annotated.
9. **Plain English**, no engineer jargon. Sentence case in text; condensed
   capitals only in block headers and the alarm state word.
10. **Keyboard.** Every control is reachable with a visible focus ring (2px teal,
    2px offset) and is at least 24px high. `prefers-reduced-motion` is respected.
    Motion is 120–180 ms and only for state changes.
11. **375px to 1600px+**, no horizontal page scroll. The Brain diagram has a
    narrow-list fallback.
12. **Standard web controls only.** The app borrows a signalling centre's type,
    palette, density and one signature move (tracks and a line profile on Brain).
    No fake hardware, bezels or instrument costumes. Other pages do not draw
    tracks: they use the alarm line, blocks, bars, trends and tables.

Consequences that every screen must follow:

- **One question per screen, answered above the fold.** Each page states its
  question (section 7) and the first viewport answers it.
- **Every signal appears once.** Pick the one place.
- **Absence of evidence is not normal.** Unread, unknown and stale values keep
  their own treatment and say so in words. Never render a missing number as `0`
  and never invent a fallback value.
- **Evidence stays one click away.** Provenance, observed time, source and
  caveats live in the detail drawer of an item, not in the row.

## 2. Tokens

Use only tokens from `styles/tokens.css`. No hex, `rgb()` or `rgba()` literals
in component CSS or TSX. No inline `style` except for values computed from data
(a bar position, a chart colour taken from a `--chart-*` token).

Two themes: **Slate dusk** (`:root`, dark, the default) and **Soft daylight**
(`:root[data-theme='light']`).

| Group | Tokens | Notes |
| --- | --- | --- |
| Surface | `--bg`, `--rail` (side rail and top bar ground), `--surface-1/2/3`, `--line`, `--line-strong`, `--track` (neutral track and diagram line), `--control-line` (outline of an input or button), `--scrim` | Elevation is a lightness step. No `box-shadow` for depth, no `backdrop-filter`. |
| Text | `--text-1/2/3`, `--text-disabled`, `--text-on-accent` | 1 = values and titles, 2 = body, 3 = labels and metadata (12px and larger only). |
| State | `--state-normal` (neutral), `--state-warning`, `--state-critical`, `--state-unavailable`, `--state-inactive`; tints `--state-warning-bg/-line`, `--state-critical-bg/-line` | `--state-healthy*` are aliases of the neutral normal values; healthy renders neutral. New code uses `--state-normal`. |
| Action | `--accent`, `--accent-hover`, `--accent-bg`, `--accent-line` | Links, primary action, focus, selection. |
| Line colours | `--line-reference`, `--line-projects`, `--line-agent`, `--line-curated` | The four GBrain source groups. Identity only. |
| Series | `--series-1..6` | The Brain page only, where a chart needs the four group colours. Never state. |
| Chart | `--chart-1..6` | Every chart category outside the Brain page (models, platforms…). A muted ramp kept away from amber, red, the accent and the four line colours (checked by distance in `tokens.contrast.test.ts`). Never state. |
| Bars | `--band` (the normal band), `--bar-fill` | Used by `AnalogBar`. `--bar-fill` is teal-toned (3:1 or more on `surface-3`, the track); `--band` is a lighter neutral strip. The band is the full height of the track and the fill a thinner bar inside it, so both read at a glance. |
| Type | `--font-sans`, `--font-caps`, `--font-mono`, `--fs-*`, `--fw-*` | See below. |
| Space | `--sp-1..12` | 4px grid. No 7/9/13px values. |
| Shape | `--r-sm` 3px, `--r-md` 4px, `--r-lg` 6px, `--r-full` | Controls and blocks `md`. |
| Motion | `--dur-fast` 120ms, `--dur-base` 180ms, `--ease` | State changes only. No entrance animation on data. |

**Type.** Body and UI: Barlow (400, 500, 600), via `@fontsource/barlow`. Block
headers and the alarm state word: Barlow Semi Condensed 600, uppercase,
letter-spacing 0.04em, via `@fontsource/barlow-semi-condensed` (the `caps`
class in `index.css`, or `--font-caps`). Code, ids and cron expressions:
JetBrains Mono Variable. Numbers use `font-variant-numeric: tabular-nums
lining-nums` (set on `body`). Fixed scale in px: micro 12, small 13, body 14,
lead 15, h3 17, h2 21, h1 26. Line height 1.45 for body, 1.2 for headings.

| Role | Size / weight | Use |
| --- | --- | --- |
| Page title | `--fs-h2` / 600 | One per page, shown once in the top bar. `Page` publishes it; a page never renders its own `h1`. |
| Block header | `--fs-body` / 600 caps | `Block` and `Panel` title. |
| Alarm state word | `--fs-h3` / 600 caps | "CAUTION", "CRITICAL". |
| Body | `--fs-body` / 400 | Default. |
| Label | `--fs-small` / 500, `--text-2` or `--text-3` | Field and column labels. Sentence case. |
| Data | tabular numerals; `--font-mono` for ids and expressions | Counts, money, durations. |

**Contrast** is computed from the tokens by `styles/tokens.contrast.test.ts` in
both themes. Grounds: `--text-1/2` are read on bg, rail and surface-1/2/3;
`--text-3` and the state and accent colours on bg, rail, surface-1 and
surface-2 (never on surface-3), and on their own tints. Text on a selected
(teal-tinted) row uses `--text-1` or `--text-2`. Line colours carry the block
header label at 4.5:1 and show as marks at 3:1. Disabled text and the
`--state-inactive` tone are exempt: they never carry the only copy of a
message. Values adjusted from the first draft of the palette to reach the
ratios: dark `--text-3` / `--state-unavailable` #8793a3 → #8995a5, dark
`--state-critical` #e8736b → #ea8079; light `--text-3` / `--state-unavailable`
#6b6660 → #635e59, `--state-warning` #9a5f00 → #825000, `--state-critical`
#b3372f → #ac352d, `--accent` #1f6f6b → #1b615d (`--accent-hover` #144e4b).
`--control-line` is an added token (outline of controls, at least 3:1).

## 3. State vocabulary

One vocabulary across the app, in `frontend/src/lib/state.ts`:

`UiState = 'healthy' | 'warning' | 'critical' | 'unavailable' | 'inactive'`

| State | Word (`stateLabel`) | Shape (`stateShape`) | Colour |
| --- | --- | --- | --- |
| `healthy` | Normal | filled circle | neutral |
| `warning` | Caution | triangle | amber |
| `critical` | Critical | filled square | soft red |
| `unavailable` | Not read | hollow circle | neutral |
| `inactive` | Off | short dash | neutral |

`toUiState(raw)` maps every legacy word: `ok, active, running, success, done,
connected, healthy, fresh` → healthy; `warning, stale, degraded, paused-by-error,
blocked, overdue` → warning; `failed, error, critical, down` → critical;
`unavailable, unknown, no-data` → unavailable; `disabled, paused, off, idle,
inactive, archived` → inactive. Unknown input maps to `unavailable`, never to a
neutral "off" look. `worstState` ranks critical > warning > unavailable >
healthy > inactive; an empty list is `unavailable`. `isAbnormal(state)` is true
for warning and critical only: the only states that take a colour.

State is always a shape **plus a word**; never colour alone.

## 4. Components (`components/ui`)

Import from `components/ui` (barrel `index.ts`). Pages do not hand-roll these;
a page that needs something missing builds it in its own folder and reports it.
All components use tokens only, have a visible focus ring, and contain no
entrance animation, hover lift, shadow or blur. Props not listed in a table are the
native props of the underlying element (`Button`, `IconButton`, `TextInput`,
`Select` accept everything a `<button>`/`<input>`/`<select>` does).

### Page frame

`Page` takes the page `title` and **publishes it to the shell** through a small
context (`PageTitleProvider` in `App.tsx`; `usePageTitle()` reads it, the top bar
renders it as the single `h1`). It also sets `document.title` to
`"<title> · Mission Control"`. It then renders only: an optional description +
actions row, an optional tabs row, and the content, in a max-width frame. The
shell supplies the page padding (16px vertical and 24px horizontal, 16px on mobile) and scrolling.

| `Page` prop | Type | Notes |
| --- | --- | --- |
| `title` | `string` | Required. Shown once, in the top bar. Not rendered in the page body. |
| `description` | `ReactNode` | One line: the question this page answers. |
| `actions` | `ReactNode` | Page-level buttons, right-aligned on the description row. |
| `tabs` | `ReactNode` | A `<Tabs>` row between the header row and the content. |
| `width` | `'default' \| 'narrow' \| 'full'` | 1600px frame (default), 960px, or unbounded. |
| `className` | `string` | Frame class. |

Content is a flex column with `--sp-4` gap, so siblings need no margins.

### Alarm, blocks and readings

| Component | Props | Notes |
| --- | --- | --- |
| `AlarmLine` | `state: 'warning' \| 'critical'`, `title`, `detail?`, `action?: { label, onClick, busy? }`, `since?`, `className?` | Rule 4. State word in condensed capitals with its shape, the plain sentence, at most one primary action at the right end. `role="alert"` for critical, `role="status"` for caution. `since` shows a real time ("since 10:41"); an unreadable time shows nothing. Render it only when something is abnormal. |
| `Block` | `title?`, `meta?`, `actions?`, `tone?: 'reference' \| 'projects' \| 'agent' \| 'curated'`, `description?`, `padding?`, `titleAs?`, `id?`, `className?`, `aria-label?` | Rule 6. 1px outline, header in condensed capitals with `meta` (the count or total) at the right. `tone` fills the header with the GBrain source group's line colour: identity only. `padding="none"` for tables and lists. Never nest a block in a block. |
| `Panel` | same as `Block` without `tone` | The old name of `Block`, kept so existing pages compile. |
| `AnalogBar` | `label`, `value`, `min`, `max`, `band?: [lo, hi]`, `limits?`, `unit?`, `format?`, `state?`, `trend?: { t, v }[]`, `unread?`, `className?` | Rule 5. `role="meter"` with `aria-valuenow/min/max` and a text alternative ("99, normal 95 – 100, below normal"). Neutral in band; outside the band it takes caution with a triangle and "below/above normal"; `state` overrides. `unread` (or a missing value) shows a hollow circle and "not read", with no value, pointer or trend. The trend appears only with at least two real readings, with their average. Limit labels that would crowd another are dropped; the "Normal: 95 – 100" caption states the band. |
| `Trend` | `points: { t, v }[]`, `band?`, `height?`, `label?`, `className?` | Inline SVG line, no chart library. Fewer than two usable points draws nothing. |
| `Meter` | `value`, `max?`, `label`, `state?`, `band?`, `min?`, `unit?`, `format?`, `trend?` | Thin proportion bar (`role="meter"`), filled with `--bar-fill` (state colour when abnormal). With a `band` it is an `AnalogBar`. A missing value draws an empty track. |
| `StateMark` | `state: UiState`, `label?`, `className?` | The shapes of rule 3 (inline SVG, `data-shape`). Hidden from assistive tech beside a word; with `label` it is `role="img"`. |
| `StateDot` | as `StateMark` | Alias of `StateMark`. |
| `StatePill` | `state`, `label?`, `className?` | Mark plus word. Neutral for normal, not read and off; amber or red for caution and critical. |
| `NavBadge` | `count`, `state`, `word?`, `className?` | A rail badge: the count with the state's shape. Renders nothing at 0 or when the count is not a positive number. Caps the shown number at 999+. |
| `Stat` | `label`, `value`, `unit?`, `hint?`, `state?`, `className?` | Label above a value. `value` of `null`/`undefined`/`''` renders "—" with "not read" for screen readers, never `0`. `state` adds a mark and colours the value for caution and critical. |
| `StatRow` | `children`, `aria-label?`, `className?` | One outlined strip of `Stat`s separated by 1px dividers. |
| `Reading` | `label`, `value`, `hint?`, `state?` | One reading in a compact row: label and number side by side at body size, no hero numeral. `null`/`undefined`/`''` renders "—" with "not read". |
| `ReadingsRow` | `children`, `aria-label?`, `className?` | The readings of a page on one wrapping line (Automations → Jobs). |
| `Notice` | `tone?: UiState \| 'info'` (`info`), `title?`, `action?`, `className?`, children | Inline message. Tinted, with its shape, only for caution and critical (`critical` is `role="alert"`); otherwise quiet and neutral. |
| `Freshness` | `observedAt`, `state?`, `staleAfterMs?` (15 min), `className?` | Rule 8. Fresh renders nothing; stale = caution mark + "as of 12:41" (or "as of 11 Nov, 12:41"); unread = hollow circle + "not read". |
| `Kbd` | `children`, `className?` | Keyboard hint. |
| `Mono` | `children`, `muted?`, `truncate?`, `className?` | Monospace span, tabular numerals. |

### Actions and form controls

| Component | Props | Notes |
| --- | --- | --- |
| `Button` | `variant?: 'primary' \| 'secondary' \| 'ghost' \| 'danger'` (`secondary`), `size?: 'sm' \| 'md'` (`md`), `loading?`, `icon?: ReactNode`, children, native button props | `type` defaults to `button`. `primary` is a teal outline with teal text, filled only on hover and while pressed; `danger` is a red outline. `loading` disables and shows a spinner, sets `aria-busy`. One `primary` per view. |
| `IconButton` | `label` (required, becomes `aria-label` and tooltip), `icon`, `variant?: 'ghost' \| 'secondary'`, `size?: 'sm' \| 'md'`, `pressed?` (`aria-pressed`), `badge?`, native button props | Square control. Never use an unlabelled icon button. |
| `TextInput` | `invalid?`, native input props | `--control-h` high. |
| `SearchInput` | `value: string`, `onChange(value: string)`, `label?` ("Search"; accessible name and placeholder), native input props | Search icon, clear button, Esc clears. |
| `Select` | `options?: { value, label, disabled? }[]`, `invalid?`, native select props | Native `<select>` with a chevron; `<option>` children also work. |
| `Switch` | `checked`, `onChange(checked: boolean)`, `label?`, `aria-label?`, `disabled?`, `id?`, `className?` | `role="switch"`. Provide `label` or `aria-label`. |
| `Field` | `label`, `hint?`, `error?`, `children: (control) => ReactNode`, `className?` | Render prop: spread `control` (`id`, `aria-describedby`, `aria-invalid`) onto the input: `<Field label="Name">{(c) => <TextInput {...c} />}</Field>`. |

### View switching and filtering

| Component | Props | Notes |
| --- | --- | --- |
| `Tabs` | `tabs: { id, label, count?, disabled? }[]`, `ariaLabel`, `value?`, `onChange?(id)`, `queryParam?`, `defaultValue?`, `className?` | Controlled with `value`/`onChange`, or URL-synced with `queryParam="tab"` (the default tab is omitted from the URL; unknown values fall back to the default; uses `replace`). Arrow/Home/End keys. Render the tab content yourself from the active id. |
| `SegmentedControl<T>` | `options: { value: T, label, disabled? }[]`, `value: T`, `onChange(value)`, `ariaLabel`, `size?`, `className?` | Radio-group semantics, arrow keys. |
| `FilterChips` | `options: { value, label, count? }[]`, `value: string \| string[]`, `onChange(value)`, `ariaLabel`, `className?` | `aria-pressed` buttons. `onChange` gets the clicked chip; the caller selects (single) or toggles (multi). Pass only real counts. |

### Data

`DataTable<T>`: dense table with sticky header (inside a scroll area capped at
the viewport height; `maxHeight="none"` disables the cap), row hover, keyboard
rows, dimming and an empty slot. Under 700px rows stack as label/value pairs
using each column's header as the label.

| `DataTable` prop | Type | Notes |
| --- | --- | --- |
| `columns` | `DataTableColumn<T>[]` | `{ key, header, cell(row), align?: 'start' \| 'end', mono?, width?, mobileLabel?, hideOnMobile? }` |
| `rows` | `T[]` | |
| `rowKey` | `(row: T) => string` | |
| `caption` | `string` | Required accessible name (visually hidden). |
| `onRowClick` | `(row: T) => void` | Rows become focusable; Enter/Space activate. |
| `selectedKey` | `string \| null` | Highlights the matching row (and sets `aria-selected` when `onRowClick` is set). |
| `dimmed` | `(row: T) => boolean` | Paused/disabled/archived rows. |
| `empty` | `ReactNode` | Replaces the table when `rows` is empty (use `EmptyState`). |
| `maxHeight` | `string` | CSS length for the scroll area. |

### Overlays

Both are portalled to `document.body`, render nothing while closed, and share
the same behaviour: focus moves in on open (to `[data-autofocus]`, else the first
control), Tab is trapped, Esc and a scrim click call `onClose`, focus returns to
the previously focused element on close. They set `aria-modal="true"` and are
labelled by their title.

| Component | Props | Notes |
| --- | --- | --- |
| `Drawer` | `open`, `onClose`, `title`, `description?`, `footer?`, `size?: 'md' \| 'lg'` (480 / 720px), children | `role="dialog"`. Home of evidence and detail. |
| `Dialog` | `open`, `onClose`, `title`, `description?`, `actions?`, `role?: 'dialog' \| 'alertdialog'`, `size?: 'sm' \| 'md'`, children? | `actions` is the footer; put the primary/danger action last and mark the safest control `data-autofocus`. Use `alertdialog` for consequential confirmations. |

### Non-data states and feedback

| Component | Props | Notes |
| --- | --- | --- |
| `EmptyState` | `title`, `description?`, `icon?`, `action?`, `className?` (legacy `color` accepted and ignored) | Nothing to show, and why. Default export of `ui/EmptyState.tsx` is the same component. |
| `ErrorState` | `title?`, `message?`, `onRetry?`, `retryLabel?` ("Retry"), `action?`, `className?` | `role="alert"`. Say what could not be read. |
| `Skeleton` | `variant?: 'line' \| 'block'`, `lines?`, `size?: 'md' \| 'lg'` (block), `width?`, `height?`, `label?`, `className?` | Loading placeholder with `role="status"`. |
| `ToastProvider` / `useToast()` | `useToast()` returns `{ show(tone, message, { duration? }) => id, dismiss(id) }`; `tone` is `'success' \| 'error' \| 'warning' \| 'info'` | One implementation app-wide (provider is in `App.tsx`). Auto-dismiss 4s (8s for errors); at most 4 visible; polite live region. |
| `TimeAgo` | `value: string \| number \| Date \| null \| undefined`, `fallback?` ("—"), `className?` | `<time>` with relative text and exact time in the tooltip. Ticks every 15s from a shared clock (`lib/useNow`), never calls `Date.now()` in render. |

Also exported: `cx` (class joiner), `resolveTab`, `usePageTitle`,
`usePublishPageTitle`, `PageTitleProvider`, `PageTitleContext`.

State helpers live in `lib/state.ts`: `UiState`, `toUiState`, `stateLabel`,
`stateShape`, `isAbnormal`, `worstState` (section 3). `toUiState` also accepts
the legacy health colours (`green`, `yellow`, `red`, `gray`) and a few spelling
variants.

### Legacy adapters

None. `PageTransition` was removed with the Setup migration; every page is on
this kit and these tokens.

### API layer (`lib/hooks.ts`)

Pages talk to the backend through one module.

- **Reads:** `useApi(url, interval?)` returns `{ data, loading, error, failure, refetch }`;
  `error` is a readable sentence and `failure` is the typed `ApiError` (`status`, `code`,
  `message`, `retryAfterMs`) for pages that treat 429 or 503 differently.
- **Errors:** every API error is `{ error: { code, message } }` with a real status. 400 and 409
  carry a message meant for the person (validation, conflict): show it next to what it is
  about. 429 means busy: say so and honour `Retry-After` (`describeApiError`). A 503 (an
  envelope with `data: null`, or an unavailable service) is a "not available" state, never an
  empty list.
- **Writes:** `sendJson`, `postJson` and `postForm` are the only way a page writes. They add
  the header `X-MC-Request: 1` that the server's write guard requires (report-only today,
  enforced later). `lib/writeGuard.test.ts` fails when a raw `fetch` appears outside
  `lib/hooks.ts`.

## 5. Shell

```
┌──────────┬────────────────────────────────────────────────────────────┐
│ Side rail│ Top bar: page title │ GBrain · Hermes · OpenClaw │ search │ ⟳ ◐ │
│ 224px    ├────────────────────────────────────────────────────────────┤
│ (56 rail)│ Alarm line (only when abnormal) · page (scrolls, max 1600) │
└──────────┴────────────────────────────────────────────────────────────┘
```

Both the rail and the top bar sit on `--rail`.

- **Where the shell reads.** The top bar and the rail badges read `GET /api/signals`
  (30 s poll): system annunciators, the attention count and failed automations.
  The brand name and the module list come from `GET /api/config`, an allowlist of `name`,
  `subtitle`, `modules` and `aws.enabled`; nothing else exists there.
- **Side rail.** Brand (mark + name from `/api/config`), then one flat list: Brain,
  Attention, Automations, Usage, Services, Local models, then Settings and Audit
  at the bottom. The selected item is a teal tint ground with teal text and icon (no side stripe). Icons are lucide at one stroke weight. Collapses
  to a 56px icon rail with tooltips (persisted in `localStorage`
  `mc-sidebar-collapsed`). Under 900px it is an off-canvas drawer opened from the
  top bar's menu button (scrim, Esc, closes on navigation).
- **Top bar.** The page title is the single `h1` (from the `Page` title; fallback:
  the route label). Then three system signals, each `mark + name + word`
  ("GBrain caution", "Hermes normal", "OpenClaw not read"); the mark and word take a
  colour only when abnormal. Each links to its `detailHref` when that is a live
  screen and shows the server's `reason` as its tooltip; "reading…" until the first
  load completes; a "healthy" system whose reading is stale or unread is shown as
  stale or not read. Then the command palette field "Search or run…", refresh and the
  theme toggle (dark/light, `data-theme` on `<html>`, persisted as `mc-theme`, default
  dark). If the signals themselves are stale the bar says "Signals as of 12:41" with
  a caution mark (rule 8); a fresh reading is not annotated. There is **no attention
  pill** in the top bar: the rail badge and the Attention page carry it. As the bar
  narrows it yields in a fixed order: stale note, system words, names, search text,
  then one status button with a list.
- **Command palette (⌘K / Ctrl+K).** Sections: Pages (all nav routes),
  Automations (`/automations?job=<id>`), Commands (Refresh data, Toggle theme).
  Substring ranking, at most 8 per section; automations are fetched only while it is
  open and listed only once you type.
- **Error boundary** around the routed page: a failing page shows `ErrorState`
  inside the shell instead of a blank app. The Suspense fallback is a `Skeleton`.
  `/setup` renders without rail or top bar.

### Badge rule (alarm management)

A badge that stays lit for a standing condition stops meaning anything. A badge
counts only **new, actionable, unacknowledged** items.

- Restricted-project counts are never part of a badge: they are information on
  the Attention page only.
- The operator can **acknowledge** an item ("seen, it will stay like this") or
  **shelve** it (silence, forever or until a date). Both remove it from the badge.
  It stays listed on its page in a quiet "Standing" group.
- An acknowledged item that gets worse (severity rises, or its count rises) counts
  as new again. A shelved item stays silent until `until` passes or it is unshelved,
  except that a shelved item that becomes critical counts again.
- No new items: the badge is not rendered at all. A count that could not be read
  gets a hollow circle (`count not read`), never a number and never silence.

Contract (`lib/signals.ts` consumes it; the older payload still reads):

- `GET /api/signals` → `data.attention = { count, worst, standing, restricted,
  breakdown: { systems, findings, overdueConfirmations }, partial, missing }`;
  `count` and `worst` cover new items only (`worst` is `'healthy'` at 0);
  `data.automations = { failed, standingFailed, … }`.
- Rail badges: **Attention = `attention.count`**; **Automations = `automations.failed`**.
  There is no Services badge: a service that stays down is a standing condition.
- `GET /api/loops` items carry `key`, `ackable`, `ack`; `GET /api/cron` jobs carry
  `ackKey` and `ack`; `POST /api/attention/acks` and `DELETE /api/attention/acks/:key`
  write them with the `X-MC-Request: 1` header.

Navigation (order is pinned by `appRoutes.test.ts`):

| Label | Path | Notes |
| --- | --- | --- |
| Brain | `/` | home; Knowledge is a view of it (`?view=knowledge`) |
| Attention | `/attention` | |
| Automations | `/automations` | Calendar as the "Schedule" view |
| Usage | `/usage` | |
| Services | `/services` | |
| Local models | `/ollama` | |
| Settings | `/settings` | utility |
| Audit | `/councils` | utility |

`/gbrain` and `/calendar` stay routed with `nav: false`. The removed screens
(`/work`, `/sessions`, `/systems`, `/workshop`, `/office`, `/team`,
`/diagnostics`, `/kanban`, `/conversations`, `/agents`, `/memory`, `/scout`,
`/aws`, `/skills`) redirect to `/`. Route `section` is `'operate' | 'know' | 'run'`
(Brain has none); `description` is a plain-words subtitle used only by the
command palette.

## 6. Words

- Sentence case everywhere. No "Phase 1", no internal codes in labels.
- Replace jargon: "R0" → "Check", "W1" → "Change (asks first)"; "proof" /
  "evidence" → "last reading"; "caveat" → "note"; "allowlisted actions" →
  "Maintenance"; "Decision Inbox" → "Needs attention"; "Living Brain Map" is
  removed; "Cost Tracker" → "Usage"; "Councils" → "Audit".
- A state sentence names the thing and the condition: "Hermes board could not
  be read", not "Hermes evidence unavailable".
- Buttons are verbs: "Run check", "Sync sources", "Retry".
- English UI. Do not mix languages in strings.

## 7. Page blueprints

Each page: `Page` frame → **alarm line** (only when abnormal) → **summary line** (the answer) → **the list or chart
that matters** → detail in a `Drawer`. Remove duplicated signals rather than
restyling them.

| Page | Question | First viewport |
| --- | --- | --- |
| Brain | Is the brain healthy and does anything need me? | The alarm line when something is abnormal (one action at its right end); views Health and Knowledge (`?view=`). Health: the system synoptic, maintenance actions (Check and Change groups, Change asks first) and readings. Knowledge: knowledge search and the page reader. |
| Attention | What is waiting for you? | Summary strip (new items: the same number as the rail badge; standing and restricted counts are information, projects with open items, open findings, pending confirmations); tables show a finding's bounded `summary`, the drawer its full `detail`; filter chips; "Needs you" table; "Projects" table; project detail in a drawer. New items: one shared action cell (`components/AckActions`: Acknowledge then Shelve…, two small buttons in an Actions column). From two new acknowledgeable items the alarm line's single action is "Acknowledge all (N)" (after one confirmation), and the New block header keeps the same button. |
| Automations | Did my jobs run, what runs next? | One compact readings row (active, paused, failed, next run); the failed rows use the same shared Acknowledge / Shelve… cell in an Actions column, and from two new failures the Automations block header carries "Acknowledge all (N)" with the same confirmation (the alarm line keeps "Show failed"); filter chips; dense table with paused rows dimmed; job detail drawer. "Schedule" view = week grid; when the calendar read reports malformed or duplicate rows and `meta.repairAvailable`, its notice offers "Repair calendar" (a confirmation, then one guarded `POST /api/calendar/repair`). |
| Usage | What did I spend, am I on track? | One figure for the period with budget meter and projection; daily chart; drivers table (model/agent/source tabs). Estimate vs billed is explained once, in a note. |
| Services | Is everything that should be running, running? | Reachability strip (OpenClaw gateway, Hermes gateway, Ollama); the verdict and the All, Down and Unidentified chips read the server's `summary`; filter chips and search; launchd services table. |
| Local models | Is Ollama OK? | Alarm line when abnormal; readings (health, memory, GPU, loaded); models table with expandable detail. |
| Audit | What was decided? | Archive notice (one line); decisions table with search and filters; decision drawer. |
| Settings | — | Sections as panels: Models, Heartbeat, Budget, Appearance (theme), Connection, Backup. Real values only; a failed read shows `ErrorState`. |

## 8. Behaviour that must not change

A redesign changes presentation, hierarchy and words. It does not change:

- which endpoints are called, their polling policy, or any request payload;
- the GBrain action contract: Check actions run directly, Change actions always
  go through the confirmation dialog, and the UI stays in "verifying" until a
  newer fresh reading arrives;
- redaction of secrets and home paths in API payloads;
- route paths and redirects;
- pure logic in `pages/*/lib.ts` and its tests.

When a test asserts visible text that this document renames, change the text
and the assertion together, and keep every behavioural assertion.

## 9. Migration checklist for a page

1. Wrap in `Page` and pass the page `title`; delete the hand-rolled header (the title appears once, in the top bar, so do not render an `h1`).
2. Replace cards, pills, buttons, inputs, tabs, tables, modals, toasts and
   empty/error/loading blocks with `components/ui`.
3. Delete duplicated signals; apply the blueprint order.
4. CSS Module: tokens only, 4px grid, three weights, CSS media/container
   queries instead of `useIsMobile()` branching where practical.
5. No colour literals, no inline static styles, no emoji as icons. Healthy is neutral: no green.
   Colour only for abnormal state (with shape and word), the teal action colour, and the four line colours.
6. Rename labels per section 6.
7. `npm --prefix frontend run lint && npm --prefix frontend test && npm --prefix frontend run build`.
