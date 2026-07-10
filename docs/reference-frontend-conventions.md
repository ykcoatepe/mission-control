# Frontend Conventions

This reference describes how the Mission Control frontend is structured and the
conventions every page change is expected to follow: route registration, the
data layer, the styling system, the UI kit, module folders, and lint rules.

## Route registry

All routes live in `frontend/src/appRoutes.tsx` as `AppRouteDefinition` entries:

| Field | Type | Meaning |
| --- | --- | --- |
| `path` | string | Browser route (e.g. `/costs`) |
| `label` | string | Sidebar label |
| `module` | string | `mc-config.json` module flag that gates visibility |
| `component` | lazy component | Page component, loaded via `React.lazy` |
| `icon` | LucideIcon | Sidebar icon; routes without one are hidden from nav |
| `nav` | boolean | `false` keeps the route reachable but out of the sidebar |
| `navPlacement` | string | `primary` or `utility`; omitted routes stay out of navigation |
| `section` | string | Route grouping metadata such as `core`, `intelligence`, or `system` |
| `description` | string | Secondary line under the sidebar label |

The sidebar (`components/Sidebar.tsx`) renders exactly seven primary routes and
two utility routes when their module flags are enabled:

| Surface | Route | Purpose |
| --- | --- | --- |
| Brain | `/` | Shared GBrain, Hermes, and OpenClaw evidence, decisions, and safe GBrain triggers |
| Work | `/work` | Hermes work in Phase 1; cross-system merge follows in Phase 2 |
| Automations | `/automations` | Cron list in Phase 1; schedule view follows in Phase 2 |
| Sessions | `/sessions` | OpenClaw sessions and handoffs |
| Explore | `/gbrain` | GBrain health, sources, memory, triggers, and timeline |
| Usage | `/usage` | Spend and model mix |
| Systems | `/systems` | Live agents and system inventory |

The utility routes are `/settings` and `/councils`. The sidebar also reads
`/api/operations/overview` to show independent GBrain, Hermes, and OpenClaw
state and freshness; it must not collapse them into one averaged status.

Diagnostics is the one grouped route. `/diagnostics` is visible when at least
one diagnostic module (`docs`, `scout`, `aws`, or `skills`) is not explicitly
disabled; `settings` alone does not keep the grouped route visible. Old direct
routes stay reachable as redirect shims:

| Legacy route | Redirect target |
| --- | --- |
| `/memory` | `/diagnostics?tab=memory` |
| `/scout` | `/diagnostics?tab=scout` |
| `/aws` | `/diagnostics?tab=aws` |
| `/skills` | `/diagnostics?tab=skills` |

Those legacy routes stay out of the sidebar with `nav: false`. Phase 1 also
keeps `/workshop`, `/calendar`, `/office`, `/team`, `/ollama`, and
`/diagnostics` directly reachable for Phase 2 work while hiding them from
navigation. Compatibility aliases redirect `/kanban`, `/cron`,
`/conversations`, `/costs`, and `/agents` to `/work`, `/automations`,
`/sessions`, `/usage`, and `/systems` respectively.

## Data layer

All API access goes through `frontend/src/lib/hooks.ts`, which wraps TanStack
Query:

| Export | Use |
| --- | --- |
| `fetchJson<T>(url, init?)` | Fetch wrapper; rejects non-2xx and non-JSON payloads |
| `apiQueryOptions<T>(url, interval?)` | Query options with key `['api', url]` and optional polling interval (ms) |
| `useApi<T>(url, interval?)` | The standard page hook; returns `{ data, loading, error, refetch }` |

Current scope:

- Core operator pages use page-level CSS Modules: Dashboard, Cron, Calendar,
  Hermes Kanban, Digital Office, Agents, AWS, Scout, Docs, Memory, Skills,
  Settings, Setup, Team Structure, Workshop, Councils, Ollama Monitor, GBrain,
  Costs, and Diagnostics.
- `pages/BrainHome.tsx` composes the Shared Brain from the typed
  `pages/brain/` components. Reads use `/api/operations/overview`; GBrain writes
  continue through the existing allowlisted `/api/gbrain/actions` endpoint.
- Brain treats system state and evidence freshness as separate fields. It keeps
  GBrain caveats and stale-source warnings visible even when trust is `100/100`.
- Capability metadata drives action safety: R0 runs directly, W1 requires
  scoped confirmation, and W2 is not rendered. A completed action becomes
  `verified` only when refreshed GBrain proof is newer and fresh.
- `pages/Chat.tsx` still carries some local inline layout while using
  `Chat.module.css`; treat it as the remaining exception, not the template.
- `pages/costs/` and `pages/cron/` use section-level CSS Modules because those
  pages are split into typed subcomponents.

Rules:

- Pages do not hand-roll `fetch().then()` chains inside effects. Use `useApi`
  for reads, `useMutation` for writes.
- Polling is expressed as the `interval` argument (e.g.
  `useApi('/api/status', 30000)`), not `setInterval`.
- Conditional retry-while-stale uses a `refetchInterval` callback. Example:
  `pages/Costs.tsx` re-polls `/api/costs` every 2.5s while the payload reports
  `source === 'sessions.fast_fallback'`, `meta.refreshing`, or `meta.stale`.
- `refetchOnWindowFocus` stays off; the console is a long-lived operator surface.

## Styling system

Two layers, no utility framework (Tailwind was removed; only its preflight
reset survives as a small base-reset block in `index.css`):

1. **Global classes** in `frontend/src/index.css` — the macOS design language:
   `macos-panel`, `macos-button`, `macos-input`, `macos-badge`, text hierarchy
   (`text-title`, `text-body`, `text-label`), status dots, and the `:root`
   color/vibrancy variables.
2. **CSS Modules** per page or component (`X.module.css` next to `X.tsx`) for
   everything else.

Rules:

- Static values belong in module classes, not inline `style={{}}`.
- Inline styles are reserved for values computed from data at runtime
  (per-item accent colors, percentage widths, responsive branches). Prefer the
  CSS-variable pattern when a class needs one dynamic value:
  `style={{ '--accent': color } as CSSProperties}` with `var(--accent)` in the
  module class.
- Styles rendered into Recharts-portalled DOM (custom tooltips, legend
  formatters) stay inline — module scoping does not reach those nodes.
- Mobile variants follow the paired-class pattern: `.foo` / `.fooMobile`
  toggled by `useIsMobile()`.

## UI kit

Shared primitives live in `frontend/src/components/`:

| Component | Purpose |
| --- | --- |
| `ui/PageHeader` | Icon + title + subtitle block at the top of a page |
| `ui/StatCard` | KPI card: uppercase label, large tabular-nums value, optional icon/accent |
| `ui/EmptyState` | Centered icon-in-circle + title + description placeholder |
| `GlassCard` | Frosted panel wrapper with entrance delay |
| `StatusBadge` | Status pill with colored dot (`active`, `idle`, `failed`, ...) |
| `AnimatedCounter` | Number that counts up on mount |
| `PageTransition` | Page-level enter/exit animation wrapper |

Adopt a kit component only when the rendered output stays identical to the
local markup it replaces; pixel fidelity wins over reuse.

## Module-folder pattern for large pages

When a page outgrows a single file, it becomes a folder. `pages/costs/` and
`pages/cron/` are the templates:

```text
pages/Costs.tsx              # orchestrator: state, queries, composition
pages/costs/types.ts         # payload interfaces
pages/costs/lib.ts           # pure helpers (formatters, color mapping)
pages/costs/<Section>.tsx    # one component per page section
pages/costs/<Section>.module.css

pages/Cron.tsx               # orchestrator: filters, mutations, composition
pages/cron/types.ts          # cron payload and view-model interfaces
pages/cron/lib.ts            # model options, overlap markers, fetch helper
pages/cron/lib.test.ts       # vitest coverage for pure cron logic
pages/cron/<Section>.tsx     # table, card list, modal, dialog, badges
pages/cron/<Section>.module.css
```

The orchestrator owns data fetching and top-level derivations; sections receive
typed props and own only the memoization that serves them.

Pure logic extracted into `lib.ts` gets vitest coverage in the sibling
`lib.test.ts`. Keep network writes in the orchestrator or a small local fetch
helper so sections stay render-focused.

## Lint rules that shape code

ESLint runs with the react-hooks compiler rules as errors. The ones that
require specific patterns:

- `react-hooks/set-state-in-effect` — do not mirror props/data into state from
  a `useEffect`. Initialize form state with a render-phase sentinel (see
  `EntryModal` in `pages/Calendar.tsx`) or derive during render.
- `react-hooks/exhaustive-deps` — wrap derived arrays/objects in `useMemo`
  before using them as hook dependencies.
- `react-hooks/purity` — no `Date.now()` during render; use a ticking
  `useState(() => Date.now())` + interval (see `pages/Calendar.tsx`).
- `@typescript-eslint/no-explicit-any` — API payloads get a small interface
  describing only the fields the page reads.

Targeted `eslint-disable-next-line` comments are allowed only with a reason
comment for genuine rule false positives; two such sites exist today
(URL-param sync in `pages/Workshop.tsx`, mount fetch in
`pages/TeamStructure.tsx`).

## Checks

```bash
cd frontend
npm run lint     # ESLint, errors block CI
npm test         # vitest unit suite
npm run build    # tsc -b + vite build
```

Both run on every PR via `.github/workflows/ci.yml`.

## Related

- [Operator Surfaces Reference](reference-operator-surfaces.md)
- [How to Verify Operator Surfaces](how-to-verify-operator-surfaces.md)
- [Read-Only Evidence Design](explanation-read-only-evidence-design.md)
