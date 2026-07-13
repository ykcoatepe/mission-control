# Frontend Conventions

This reference describes the current frontend structure and the rules expected
for new work. It distinguishes enforced contracts from migration targets in
legacy pages.

## Route registry

`frontend/src/appRoutes.tsx` is the only browser-route registry.

| Field | Meaning |
| --- | --- |
| `path` | Browser path |
| `label` | Navigation label |
| `component` | Lazy-loaded page component |
| `module` | Presentation flag in `mc-config.json` |
| `icon` | Navigation icon when the route is eligible for navigation |
| `nav` | `false` marks a hidden/direct route or redirect |
| `navPlacement` | `primary` or `utility`; required for sidebar placement |
| `anyModule` | Show a grouped surface when any listed module is enabled |
| `section`, `description` | Navigation metadata |

The tested primary order is `/`, `/work`, `/automations`, `/sessions`,
`/gbrain`, `/usage`, `/systems`. Utility navigation is `/settings`, then
`/councils`. Direct pages and compatibility redirects are listed in the
[Operator Surfaces Reference](reference-operator-surfaces.md).

Only explicit `false` disables an eligible navigation item. All registry
entries are still mounted by `App.tsx`; module flags are not authorization.
Diagnostics applies its own tab filtering, with `docs` currently owning both
Memory and Docs.

Add or change route behavior together with assertions in
`src/appRoutes.test.ts`. Do not duplicate the route table in page-level docs.

## Data access

The standard read layer is `frontend/src/lib/hooks.ts`:

| Export | Purpose |
| --- | --- |
| `fetchJson<T>(url, init?)` | JSON fetch wrapper with non-2xx/non-JSON errors |
| `apiQueryOptions<T>(url, interval?)` | Stable TanStack Query options and optional polling |
| `useApi<T>(url, interval?)` | Page read helper returning data/loading/error/refetch |

New and migrated pages should use TanStack Query for server state, `useApi` for
ordinary reads, and `useMutation` for writes. Polling belongs in Query options,
not hand-written `setInterval` effects. Conditional refresh can use a
`refetchInterval` callback, as Usage does while data is stale or refreshing.

Several older pages still call `fetch` directly. That is current implementation
debt, not the preferred template. Do not refactor an unrelated page solely to
make it conform.

Brain reads `/api/operations/overview` and invokes only the allowlisted
`/api/gbrain/actions` contract. It must keep state, freshness, provenance, and
caveats separate, and it must wait for newer proof before marking a repair
verified.

## Styling

There is no utility CSS framework. Use:

1. global tokens and shared macOS-style primitives from `src/index.css`;
2. a colocated CSS Module for page/component-specific layout and styling.

Static values belong in classes. Inline style is appropriate only for values
computed from data, responsive branches that cannot be expressed cleanly, SVG
or chart geometry, and content rendered through third-party portals. Prefer a
typed CSS custom property when a class needs one dynamic value.

Use the paired `.name` / `.nameMobile` pattern with `useIsMobile()` where the
existing design requires explicit mobile variants.

## Shared components

Reusable primitives live in `src/components/`:

| Component | Purpose |
| --- | --- |
| `ui/PageHeader` | Page title, icon, and subtitle |
| `ui/StatCard` | Label/value KPI card |
| `ui/EmptyState` | Empty or unavailable state |
| `GlassCard` | Frosted panel wrapper |
| `StatusBadge` | State pill and dot |
| `AnimatedCounter` | Animated numeric value |
| `PageTransition` | Route/page transition |

Reuse a primitive when it preserves the established hierarchy and behavior.
User-visible status surfaces need loading, empty, stale, unavailable, and error
states appropriate to the API contract.

## Large-page organization

`pages/brain/`, `pages/costs/`, and `pages/cron/` are current templates:

```text
pages/Feature.tsx                 # queries, state, top-level composition
pages/feature/types.ts            # payload and view-model types
pages/feature/lib.ts              # pure derivations and formatting
pages/feature/lib.test.ts         # behavior tests for pure logic
pages/feature/Section.tsx         # focused rendered section
pages/feature/Section.module.css  # section styles
```

The orchestrator owns server state and mutations. Sections receive typed props
and should remain render-focused. Extract pure behavior only when it reduces
real complexity; cover it with colocated Vitest tests.

## Lint and React rules

ESLint treats React Hooks compiler rules as errors. Important constraints:

- do not mirror props/query data into state from an effect when it can be
  derived during render;
- memoize arrays/objects used as dependencies;
- do not call impure time functions during render—store a ticking time value;
- describe the fields a page reads instead of using explicit `any`;
- use a targeted disable only for a documented rule false positive.

## Checks

```bash
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build
```

CI runs all three. UI changes also need an integrated check against the
Express-served production bundle, not only Vite or source inspection.

## Related

- [System Architecture](explanation-system-architecture.md)
- [How to Verify Operator Surfaces](how-to-verify-operator-surfaces.md)
- [Configuration and Runtime Reference](reference-configuration.md)
