# Mission Control

Mission Control is a local operations console for the AI stack on this
machine. It brings OpenClaw, Hermes, GBrain, Ollama, Claude Code, CodexBar, and
supporting local services into one evidence-first interface at
`http://127.0.0.1:3333`.

The current product is organized around seven operator destinations:

| Destination | Route | What it answers |
| --- | --- | --- |
| Brain | `/` | What needs attention across GBrain, Hermes, and OpenClaw? |
| Work | `/work` | What is queued, running, blocked, or ready in Hermes? |
| Automations | `/automations` | Which OpenClaw and Hermes jobs are scheduled or failing? |
| Sessions | `/sessions` | Which conversations and handoffs are active? |
| Explore | `/gbrain` | What is the detailed GBrain health, source, queue, and evidence state? |
| Usage | `/usage` | What are OpenClaw, Hermes, Claude Code, and CodexBar using or costing? |
| Systems | `/systems` | Which agents, sessions, models, and runtimes are present? |

Settings and the governance archive are utility destinations. Calendar,
Workshop, Digital Office, Team Structure, Ollama, Setup, and Diagnostics remain
directly reachable without appearing in primary navigation.

## Quick start

Requirements: Node.js 20.19+ in the Node 20 line, or Node.js 22.12+. OpenClaw,
Hermes, GBrain, Ollama, CodexBar, AWS, Notion, and Brave Search are optional
integrations; unavailable sources render as explicit empty, stale, warning, or
unavailable states.

```bash
git clone https://github.com/ykcoatepe/mission-control.git
cd mission-control
npm install
npm --prefix frontend install
cp mc-config.default.json mc-config.json
npm run build
npm start
```

Open `http://127.0.0.1:3333`. Mission Control binds to loopback by default and
does not provide application authentication. Do not expose it on a network by
changing `MISSION_CONTROL_HOST` unless you add an appropriate trusted access
boundary.

Local configuration and runtime data are intentionally gitignored, including
`mc-config.json`, `data/`, `documents/`, `tasks.json`, logs, generated frontend
assets, and installed dependencies. Never commit tokens, local transcripts, or
personal runtime data.

## Documentation

Start with the [documentation map](docs/README.md), which separates learning,
operational procedures, exact contracts, and design rationale.

- [First operator check](docs/tutorial-first-operator-check.md) — learn the
  current workflow from Brain to source evidence.
- [Verification runbook](docs/how-to-verify-operator-surfaces.md) — test code,
  APIs, routes, and the served build.
- [Local live update](docs/how-to-update-local-live-build.md) — rebuild and
  restart the machine's running instance after a merge.
- [Operator surfaces reference](docs/reference-operator-surfaces.md) — browser
  routes, API families, mutations, and safety boundaries.
- [Configuration reference](docs/reference-configuration.md) — config keys,
  environment variables, runtime paths, and dependencies.
- [System architecture](docs/explanation-system-architecture.md) — how the
  frontend, Express API, readers, caches, and local systems fit together.
- [Frontend conventions](docs/reference-frontend-conventions.md) — route,
  query, styling, and test conventions for UI work.

## Repository map

```text
mission-control/
├── server.js                 # Express composition root and SPA server
├── server/routes/            # HTTP route families
├── server/services/          # Readers, normalization, caches, and persistence
├── scripts/                  # Usage summaries and operational helpers
├── tests/                    # Node test suite
├── frontend/src/
│   ├── appRoutes.tsx         # Canonical browser-route/navigation registry
│   ├── pages/                # Operator surfaces
│   ├── components/           # Layout and reusable UI
│   └── lib/                  # Query and client helpers
├── mc-config.default.json    # Safe local configuration template
└── docs/                     # Diataxis documentation and design history
```

Stack: Express 5, React 19, TypeScript 5.9, Vite 7, TanStack Query, Framer
Motion, Recharts, Vitest, and Node's built-in test runner. Styling uses global
design tokens plus CSS Modules; there is no utility CSS framework.

## Validation

```bash
npm test
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build
git diff --check
```

CI runs the backend suite plus frontend lint, unit tests, and production build.
The separate supply-chain workflow checks lockfiles, registry signatures, and
the configured npm incident advisory.

## License

[Business Source License 1.1](LICENSE). The licensed work converts to MIT on
2030-02-07.
