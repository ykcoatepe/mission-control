# Mission Control Frontend

React + TypeScript + Vite frontend for the Mission Control operator console.

The frontend is not a generic Vite template anymore. It is the live UI for the
local AI operator console at `http://127.0.0.1:3333`.

## App Shape

- Routes are registered in `src/appRoutes.tsx`.
- The sidebar is generated from route definitions where `nav !== false`.
- Pages live in `src/pages/`.
- Shared UI primitives live in `src/components/`.
- Client helpers and API hooks live in `src/lib/`.
- Production assets are generated into `dist/` and served by the Express server.

Current primary surfaces:

- Dashboard
- Conversations
- Workshop
- Hermes Kanban
- Cost Tracker
- Cron Jobs
- Calendar
- GBrain
- Diagnostics
- Ollama Monitor
- Governance Archive
- Team Structure
- Digital Office
- Agent Hub
- Settings

Diagnostics groups Memory, Docs, Scout, AWS, and Skills behind one sidebar
item. The old `/memory`, `/scout`, `/aws`, and `/skills` routes redirect to the
matching Diagnostics tab.

## Commands

```bash
npm install
npm run dev -- --host 127.0.0.1
npm run build
npm run lint
npm test
```

For normal local operation from the repository root:

```bash
cd frontend
npm run build
cd ..
npm start
```

Then open `http://127.0.0.1:3333`.

## API Contract

The frontend talks to the same-origin Express API under `/api/...`.

Important runtime endpoints include:

- `/api/health`
- `/api/status`
- `/api/sessions`
- `/api/costs`
- `/api/cron`
- `/api/office/telemetry`
- `/api/team`
- `/api/agents`
- `/api/ollama`
- `/api/councils`

Pages should render explicit fallback and stale-data states instead of implying
that a runtime source is healthy when it only timed out or returned cached data.
Cost views should preserve and label stale cached data when a background refresh
fails instead of clearing useful totals from the operator surface.

## UX Rules

- Keep the UI operator-first: compact, scan-friendly, and action-oriented.
- Prefer concrete status, timestamps, counts, and source labels over generic
  "healthy" copy.
- Normalize timestamps from API payloads before rendering relative ages. Backend
  sources may send seconds, milliseconds, numeric strings, or ISO strings.
- Keep empty or inactive systems out of primary navigation unless they help the
  operator make a decision.
- Use route-level code splitting as currently defined in `appRoutes.tsx`.
- Use lucide icons for buttons and navigation when an icon exists.
- Do not let cards become nested dashboards. Repeated items can be cards; page
  sections should stay clean and readable.

## Build Output

`dist/` is generated and gitignored. Rebuild it before running the Express server
when frontend assets change:

```bash
npm run build
```

The repository keeps source in git and leaves runtime/generated artifacts local.
