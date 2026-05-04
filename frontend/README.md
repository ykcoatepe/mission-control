# Mission Control Frontend

React + TypeScript + Vite frontend for the Mission Control operator console.

The frontend is not a generic Vite template anymore. It is the live UI for the
local OpenClaw control plane at `http://127.0.0.1:3333`.

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
- Cost Tracker
- Cron Jobs
- Calendar
- Ollama Monitor
- Governance Archive
- Team Structure
- Digital Office
- Memory
- Scout
- Agent Hub
- Settings
- AWS

The Skills route still exists for direct access, but it is hidden from sidebar
navigation until it has a useful operator workflow again.

## Commands

```bash
npm install
npm run dev -- --host 127.0.0.1
npm run build
npm run lint
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

## UX Rules

- Keep the UI operator-first: compact, scan-friendly, and action-oriented.
- Prefer concrete status, timestamps, counts, and source labels over generic
  "healthy" copy.
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
