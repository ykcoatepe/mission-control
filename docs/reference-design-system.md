# Design System Reference — "Dark cockpit"

This is the binding design reference for the Mission Control frontend. It
replaces the macOS-glass and "Quiet Observatory" styles. Tokens live in
`frontend/src/styles/tokens.css`; shared components live in
`frontend/src/components/ui/`.

## 1. Idea

Mission Control borrows one rule from the Airbus flight deck: **the dark
cockpit**. When everything is normal the screen is quiet. Only an abnormal
condition lights up, and it lights up once, in one place, with the action that
resolves it next to it.

It is a modern flat tool, not a cockpit costume: no gauges, bezels, glow,
glass, gradients or blur.

Consequences that every screen must follow:

1. **One question per screen, answered above the fold.** Each page states its
   question (section 7) and the first viewport answers it.
2. **Every signal appears once.** A number or state shown in the page summary
   is not repeated in a card, a pill and a chart legend. Pick the one place.
3. **Colour means state or action, nothing else.** Green = confirmed normal,
   amber = caution, red = act now, grey = could not be read or switched off,
   cyan = you can act on this. Decorative colour is not allowed. Charts use the
   `--series-*` tokens only.
4. **Normal is quiet.** A healthy item is plain text with at most a small dot.
   Filled or tinted surfaces are reserved for warning and critical.
5. **Absence of evidence is not green.** Unread, unknown and stale values keep
   their own grey/amber treatment and say so in words. Never render a missing
   number as `0`, and never invent a fallback value.
6. **Plain words.** Say what the operator would say. See section 6.
7. **Evidence stays one click away.** Provenance, observed time, source and
   caveats live in the detail drawer of an item, not in the row.

## 2. Tokens

Use only tokens from `styles/tokens.css`. No hex, `rgb()` or `rgba()` literals
in component CSS or TSX. No inline `style` except for values computed from data
(a bar width, a chart colour taken from a `--series-*` token).

| Group | Tokens | Notes |
| --- | --- | --- |
| Surface | `--bg`, `--surface-1/2/3`, `--line`, `--line-strong`, `--scrim` | Elevation is a lightness step. No `box-shadow`, no `backdrop-filter`. |
| Text | `--text-1/2/3`, `--text-disabled` | 1 = values and titles, 2 = body, 3 = labels and metadata. |
| State | `--state-{healthy,warning,critical,unavailable,inactive}` with `-bg` and `-line` | Text/dot uses the base token; a tinted block uses `-bg` + `-line`. |
| Action | `--accent`, `--accent-hover`, `--accent-bg`, `--accent-line` | Links, primary button, selection, focus. |
| Series | `--series-1..6` | Charts only. |
| Type | `--font-sans`, `--font-mono`, `--fs-*`, `--fw-*` | Three weights only: 400, 500, 600. |
| Space | `--sp-1..12` | 4px grid. No 7/9/13px values. |
| Shape | `--r-sm/md/lg/full` | Controls `md`, panels `lg`, pills `full`. |
| Motion | `--dur-fast`, `--dur-base`, `--ease` | Opacity/transform only. No blur, no entrance animation on data. |

Typography roles:

| Role | Size / weight | Use |
| --- | --- | --- |
| Page title | `--fs-h2` / 600 | One per page, shown once in the top bar. `Page` publishes it; a page never renders its own `h1`. |
| Headline | `--fs-h1` / 600 | Only the Overview sentence. |
| Section title | `--fs-lead` / 600 | `Panel` title. |
| Body | `--fs-body` / 400 | Default. |
| Label | `--fs-small` / 500, `--text-3` | Field and column labels. Sentence case. No letter-spaced capitals. |
| Data | `--font-mono`, tabular numerals | Ids, cron expressions, counts, money, durations. |

Both themes are defined (`:root` dark, `:root[data-theme='light']`). Dark is the
default. A page is "theme-safe" only when it uses no colour literals.

## 3. State vocabulary

One vocabulary across the app, in `frontend/src/lib/state.ts`:

`UiState = 'healthy' | 'warning' | 'critical' | 'unavailable' | 'inactive'`

`toUiState(raw)` maps every legacy word: `ok, active, running, success, done,
connected, healthy, fresh` → healthy; `warning, stale, degraded, paused-by-error,
blocked, overdue` → warning; `failed, error, critical, down` → critical;
`unavailable, unknown, no-data` → unavailable; `disabled, paused, off, idle,
inactive, archived` → inactive. Unknown input maps to `unavailable`, never to a
neutral "off" look.

State is always shown as a dot **plus a word**; never colour alone.

## 4. Components (`components/ui`)

Import from `components/ui` (barrel `index.ts`). Pages do not hand-roll these.
All components use tokens only, have visible focus, and contain no entrance
animation, hover lift, shadow or blur. Props not listed in a table are the
native props of the underlying element (`Button`, `IconButton`, `TextInput`,
`Select` accept everything a `<button>`/`<input>`/`<select>` does).

### Page frame

`Page` takes the page `title` and **publishes it to the shell** through a small
context (`PageTitleProvider` in `App.tsx`; `usePageTitle()` reads it, the top bar
renders it as the single `h1`). It also sets `document.title` to
`"<title> · Mission Control"`. It then renders only: an optional description +
actions row, an optional tabs row, and the content, in a max-width frame. The
shell supplies the page padding (24/32px, 16px on mobile) and scrolling.

| `Page` prop | Type | Notes |
| --- | --- | --- |
| `title` | `string` | Required. Shown once, in the top bar. Not rendered in the page body. |
| `description` | `ReactNode` | One line: the question this page answers. |
| `actions` | `ReactNode` | Page-level buttons, right-aligned on the description row. |
| `tabs` | `ReactNode` | A `<Tabs>` row between the header row and the content. |
| `width` | `'default' \| 'narrow' \| 'full'` | 1480px frame (default), 960px, or unbounded. |
| `className` | `string` | Frame class. |

Content is a flex column with `--sp-4` gap, so siblings need no margins.

### Surfaces and readings

| Component | Props | Notes |
| --- | --- | --- |
| `Panel` | `title?`, `description?`, `actions?`, `padding?: 'md' \| 'sm' \| 'none'`, `titleAs?: 'h2' \| 'h3'`, `id?`, `className?`, `aria-label?` | Flat bordered surface; header (title row) only when `title` or `actions` is given. `padding="none"` for tables and lists. Not clickable, no hover. |
| `Stat` | `label`, `value`, `unit?`, `hint?`, `state?: UiState`, `className?` | Label above a mono value. `value` of `null`/`undefined`/`''` renders "—" with "not read" for screen readers, never `0`. `state` adds a dot before the label and colours the value for `warning`/`critical`. |
| `StatRow` | `children`, `aria-label?`, `className?` | One bordered strip of `Stat`s separated by 1px dividers; wraps with `auto-fit` (min 160px). |
| `StateDot` | `state: UiState`, `label?`, `className?` | 8px dot. `unavailable` is a hollow ring. Decorative unless `label` is given (then `role="img"`). |
| `StatePill` | `state: UiState`, `label?`, `className?` | Dot plus word (default `stateLabel(state)`). Tinted only for `warning`/`critical`. |
| `Meter` | `value: number \| null \| undefined`, `max?` (100), `label`, `state?` (`healthy`), `className?` | 6px proportion bar, `role="meter"`. A missing value draws an empty track. |
| `Notice` | `tone?: UiState \| 'info'` (`info`), `title?`, `action?`, `className?`, children | Inline message. Tinted for `warning`/`critical`; `critical` uses `role="alert"`. |
| `Kbd` | `children`, `className?` | Keyboard hint. |
| `Mono` | `children`, `muted?`, `truncate?`, `className?` | Monospace span, tabular numerals. |

### Actions and form controls

| Component | Props | Notes |
| --- | --- | --- |
| `Button` | `variant?: 'primary' \| 'secondary' \| 'ghost' \| 'danger'` (`secondary`), `size?: 'sm' \| 'md'` (`md`), `loading?`, `icon?: ReactNode`, children, native button props | `type` defaults to `button`. `loading` disables and shows a spinner, sets `aria-busy`. One `primary` per view. |
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
| `Freshness` | `observedAt`, `state?: 'fresh' \| 'stale' \| 'unknown' \| 'unavailable'`, `staleAfterMs?` (15 min), `className?` | "fresh · 1m", "stale · 3h" (amber), "not read" (missing time). A server `state` overrides the age test. |

Also exported: `cx` (class joiner), `resolveTab`, `usePageTitle`,
`usePublishPageTitle`, `PageTitleProvider`, `PageTitleContext`.

State helpers live in `lib/state.ts`: `UiState`, `toUiState`, `stateLabel`,
`worstState` (critical > warning > unavailable > healthy > inactive; an empty
list is `unavailable`). `toUiState` also accepts the legacy health colours
(`green`, `yellow`, `red`, `gray`) and a few spelling variants.

### Legacy adapters

`GlassCard`, `StatusBadge`, `PageHeader`, `StatCard`, `PageTransition`,
`LoadingSpinner` and `ui/EmptyState` keep their old props but are now thin and
flat. Do not use them in new code; replace them when a page is migrated.

- `GlassCard`: a plain bordered div (no motion; `hover`/`delay` ignored).
- `StatusBadge`: `StatePill` through `toUiState` (unknown words show as "unavailable").
- `PageHeader`: publishes its `title` to the top bar and renders only the subtitle.
- `StatCard`: a `Stat` in a flat card (`icon`, `color`, `delay` ignored).
- `PageTransition`: renders its children, no animation.

## 5. Shell

```
┌──────────┬───────────────────────────────────────────────────────────┐
│ Sidebar  │ Top bar: page title │ annunciators │ attention │ ⌘K │ age │
│ 232px    ├───────────────────────────────────────────────────────────┤
│ (56 rail)│ Page (scrolls, max width 1480, padding 24/32)              │
└──────────┴───────────────────────────────────────────────────────────┘
```

- **Sidebar.** Brand (mark + name from `/api/config`), then single-line items
  (icon + label) in groups: Overview (no label), Operate, Know, Run; Settings
  and Audit at the bottom. A count appears on an item only when something there
  is abnormal: Automations = enabled jobs whose last run failed (red), Work =
  blocked Hermes tasks (amber, only when the overview reports a number). Collapses
  to a 56px icon rail with tooltips (choice persists in `localStorage`
  `mc-sidebar-collapsed`). Under 900px it is an off-canvas drawer opened from the
  top bar's menu button (scrim, Esc, closes on navigation).
- **Top bar.** The page title is the single `h1`, taken from the `Page` title
  (fallback: the route label). Right side: system annunciators (GBrain, Hermes,
  OpenClaw: dim when healthy, lit in the state colour with the state word when
  not, each links to its `detailHref`; neutral "reading…" until the first load
  completes; a "healthy" system whose reading is stale or unread is lit as
  stale or not read), the attention pill ("2 need attention", links to `/`,
  hidden at zero), the command palette trigger, data age of the overview with a
  refresh button (refetches all on-screen API reads), theme toggle (dark/light,
  `data-theme` on `<html>`, persisted as `mc-theme`, default dark), and the
  Assistant button (dispatches the `open-chat` window event).
- **Command palette (⌘K / Ctrl+K).** Sections: Pages (all nav routes),
  Automations (`/automations?job=<id>`), Sessions (`/sessions?session=<key>`),
  Commands (Refresh data, Toggle theme, Open assistant). Substring ranking, at
  most 8 per section; automations and sessions are fetched only while it is open
  and listed only once you type.
- **Error boundary** around the routed page: a failing page shows `ErrorState`
  inside the shell (Reload page / Try again) instead of a blank app. The Suspense
  fallback is a `Skeleton`. `/setup` renders without sidebar, top bar or chat.

Navigation (order is pinned by `appRoutes.test.ts`):

| Group | Label | Path | Absorbs |
| --- | --- | --- | --- |
| — | Overview | `/` | old Brain home |
| Operate | Work | `/work` | link to legacy Workshop |
| Operate | Automations | `/automations` | Calendar as the "Schedule" view |
| Operate | Sessions | `/sessions` | |
| Know | Knowledge | `/gbrain` | Memory files and Documents views |
| Know | Usage | `/usage` | |
| Run | Agents | `/systems` | Team structure and Desks views, Skills view |
| Run | Local models | `/ollama` | |
| Utility | Settings | `/settings` | |
| Utility | Audit | `/councils` | |

Old URLs keep working through redirects. Route `section` is `'operate' | 'know' | 'run'`
(Overview has none); `description` is a plain-words subtitle used only by the
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

Each page: `Page` frame → **summary line** (the answer) → **the list or chart
that matters** → detail in a `Drawer`. Remove duplicated signals rather than
restyling them.

| Page | Question | First viewport |
| --- | --- | --- |
| Overview | Does anything need me? | Headline sentence; ranked attention list with an action per row; one strip of system tiles (GBrain, Hermes, OpenClaw, Automations, Usage, Local models); "Next up" and "Recent activity". No map. Maintenance actions are on Knowledge. |
| Work | What is running, what is stuck? | Summary strip (running, blocked, ready, done today); board columns with compact cards; task detail in a drawer. Blocked first. |
| Automations | Did my jobs run, what runs next? | Summary strip (active, paused, failed, next run); filter chips; dense table with paused rows dimmed; job detail drawer. "Schedule" view = week grid. |
| Sessions | Who is talking, where? | Session list (left) and transcript (right); one composer; state per session. |
| Knowledge | Can I trust the brain right now? | One verdict line; four readings in one `StatRow` (quality, sync, link extraction, last probe); notes list; "Maintenance" panel with Check and Change groups; sources table. Views: Health, Memory files, Documents. |
| Usage | What did I spend, am I on track? | One figure for the period with budget meter and projection; daily chart; drivers table (model/agent/source tabs). Estimate vs billed is explained once, in a note. |
| Agents | Which agents exist and are they alive? | Summary strip (live, idle, offline); roster table; agent detail drawer. Views: Roster, Structure, Desks, Skills. |
| Local models | Is Ollama OK? | Verdict line; `StatRow` (health, memory, GPU, loaded); models table with expandable detail. |
| Audit | What was decided? | Archive notice (one line); decisions table with search and filters; decision drawer. |
| Settings | — | Sections as panels: Models, Heartbeat, Budget, Appearance (theme), Connection, Backup. Real values only; a failed read shows `ErrorState`. |

## 8. Behaviour that must not change

A redesign changes presentation, hierarchy and words. It does not change:

- which endpoints are called, their polling policy, or any request payload;
- the GBrain action contract: Check actions run directly, Change actions always
  go through the confirmation dialog, and the UI stays in "verifying" until a
  newer fresh reading arrives;
- redaction and sanitising (`utils/sanitize.ts`);
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
5. No colour literals, no inline static styles, no emoji as icons.
6. Rename labels per section 6.
7. `npm --prefix frontend run lint && npm --prefix frontend test && npm --prefix frontend run build`.
