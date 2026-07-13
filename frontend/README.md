# Mission Control frontend

The frontend is a React 19 + TypeScript application built by Vite and served by
the root Express process from `frontend/dist`.

## Commands

Run from the repository root:

```bash
npm --prefix frontend install
npm --prefix frontend run dev
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run build
```

The development server is useful for isolated UI work. Runtime-integrated QA
should use the production build through `http://127.0.0.1:3333`, because that
is the surface that exercises the Express API and SPA fallback together.

## Source map

- `src/appRoutes.tsx` is the canonical route and navigation registry.
- `src/pages/` contains routed surfaces; large pages use a typed folder beside
  their orchestrator file, as in `pages/brain/`, `pages/costs/`, and
  `pages/cron/`.
- `src/components/` contains layout and shared UI primitives.
- `src/lib/hooks.ts` contains the standard TanStack Query read helpers.
- `src/index.css` defines global tokens and shared macOS-style primitives;
  page-specific styles live in CSS Modules.

Module flags control whether destinations appear in navigation or Diagnostics;
they are not an authorization boundary and do not prevent direct route access.

See the canonical [frontend conventions](../docs/reference-frontend-conventions.md),
[operator surfaces reference](../docs/reference-operator-surfaces.md), and
[verification runbook](../docs/how-to-verify-operator-surfaces.md). Do not copy
route or API catalogs into this file; those contracts change in the root app.
