# Operator Surfaces Reference

This is the canonical inventory of Mission Control's browser routes, API
families, and action boundaries. `frontend/src/appRoutes.tsx` and
`server/routes/` remain the executable source of truth.

## Browser routes

### Primary navigation

| Label | Page title | Route | Module | Data owner |
| --- | --- | --- | --- | --- |
| Brain | Brain | `/` | `dashboard` | Operations overview + GBrain synoptic and actions |
| Attention | Attention | `/attention` | `attention` | Manager loops (`/api/loops`) |
| Automations | Automations | `/automations` | `cron` | OpenClaw + Hermes cron, calendar |
| Usage | Usage | `/usage` | `costs` | OpenClaw, Hermes, Claude Code, CodexBar |
| Services | Services | `/services` | `services` | launchd services and endpoint reachability |
| Local models | Local models | `/ollama` | `ollamaMonitor` | Read-only Ollama runtime and model telemetry; inventory may include cloud-backed models |

### Utility and direct routes

| Route | Visibility | Purpose |
| --- | --- | --- |
| `/settings` | utility navigation | Model routing, heartbeat, appearance, budget, import/export |
| `/councils` | utility navigation (label: Audit) | Governance archive of past decisions and their votes |
| `/setup` | direct | First-run configuration |
| `/gbrain` | direct | Knowledge: is the brain healthy and in sync |
| `/calendar` | direct | Schedule and local calendar entries |

Direct routes are mounted even when omitted from navigation. Module flags are
presentation controls, not authorization.

### Compatibility redirects

| Old route | Current target |
| --- | --- |
| `/cron` | `/automations` |
| `/costs` | `/usage` |
| `/work`, `/sessions`, `/systems`, `/workshop`, `/office`, `/team`, `/diagnostics`, `/kanban`, `/conversations`, `/agents`, `/memory`, `/scout`, `/aws`, `/skills` | `/` (the screens were removed) |

## Core read models

### Health

`GET /api/health` and `GET /healthz` return:

```json
{"ok":true,"status":"ok","service":"mission-control","generatedAt":"..."}
```

### Operations overview

`GET /api/operations/overview` is Brain's aggregate contract. Schema version
`1` contains independent `systems.openclaw`, `systems.hermes`, and
`systems.gbrain` objects plus `overall`, `attention`, `evidence`, and
`capabilities`. Each reader is bounded and failure-isolated. The response
redacts credentials, raw content, and absolute home paths.

State, freshness, and trust are independent. A source can report high trust and
still surface a caveat or stale evidence.

### GBrain

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/gbrain/overview` | Normalized GBrain overview and saved/live proof |
| GET | `/api/gbrain/health` | Live health and job statistics |
| GET | `/api/gbrain/sources` | Source inventory |
| GET | `/api/gbrain/version` | Runtime/version probe |
| GET | `/api/gbrain/integration-health` | Bridge and integration proof |
| GET | `/api/gbrain/actions` | Allowlisted action catalog |
| POST | `/api/gbrain/actions` | Execute one allowlisted action |
| GET | `/api/gbrain/timeline?limit=N` | Most recent evidence entries, bounded by `limit` |
| GET | `/api/gbrain/synoptic` | System synoptic read model for Brain |
| GET | `/api/gbrain/search?q=` | Knowledge search |
| GET | `/api/gbrain/pages/:slug` | One page |
| GET | `/api/gbrain/graph` | Link graph around a page |

The health reader first uses the supported call interface and job statistics,
with `gbrain health --json` as a compatibility fallback.

The action catalog contains exactly:

| ID | Safety | Confirmation |
| --- | --- | --- |
| `doctor-fast` | R0 diagnostic | no |
| `preview-sync` | R0 preview | no |
| `storage-status` | R0 diagnostic | no |
| `sync-sources` | W1 maintenance | yes |
| `retry-failed-sync` | W1 repair | yes |
| `embed-stale` | W1 maintenance | yes |
| `embed-missing` | W1 maintenance | yes |
| `check-resolvable` | R0 diagnostic | no |

Only one GBrain action runs at once. Arbitrary action names are rejected. An
HTTP success means the action finished; the UI reports it as verified only
after newer, fresh evidence is observed.

## API families

The tables below group the public application API. Endpoint path parameters use
`:name` notation.

### Signals, loops, and services

| Family | Endpoints | Notes |
| --- | --- | --- |
| Signals | `GET /api/signals` | Small fixed contract the shell polls; composed from memory, an unobserved part is `null` |
| Loops | `GET /api/loops`, `GET /api/loops/:project` | Manager-loop ledger from the scheduled mloop source |
| Services | `GET /api/services` | launchd services plus gateway and Ollama reachability; read-only |
| Hermes Kanban | `GET /api/hermes-kanban` | Read-only board; no write routes remain |

### Automations

| Family | Endpoints | Notes |
| --- | --- | --- |
| Cron | `GET /api/cron`, `POST /api/cron/create`, `POST /api/cron/:id/toggle`, `POST /api/cron/:id/run`, `PATCH /api/cron/:id/model`, `DELETE /api/cron/:id` | Hermes jobs cannot run/delete; toggle/model are allowed |
| Calendar | `GET /api/calendar`, `POST /api/calendar`, `PATCH /api/calendar/:id`, `POST /api/calendar/sync-cron` | Combines schedule data with local entries |
| Cron search | `GET /cron-search` | Standalone page (`public/cron-search.html`) that reads `/api/cron` |

### Usage, status, sessions, and models

| Family | Endpoints | Notes |
| --- | --- | --- |
| Status | `GET /api/status` | OpenClaw status snapshot; `scripts/restart_safe.sh` uses it as a fallback health probe |
| Usage | `GET /api/costs?period=7d`, `GET /api/costs/codexbar`, `GET /api/costs/months`, `GET /api/usage/summary` | Periods are normalized; metadata reports source readiness, stale state, and refresh state |
| Sessions | `GET /api/sessions` | Read-only list of visible OpenClaw sessions, used by Usage |
| AWS | `GET /api/aws/costs` | Read by Usage while the AWS module is enabled; answers a disabled payload otherwise |
| Models | `GET /api/models` | Catalog read by Settings and the automation create dialog |
| Ollama | `GET /api/ollama/telemetry`, `GET /api/ollama/telemetry/history`, `GET /api/ollama/telemetry/models` | Local model and memory telemetry; read-only |

Usage merges included/local consumption and estimated spend from multiple
sources. `meta.openclawStatus`, `meta.hermesStatus`, `meta.claudeCodeStatus`,
`meta.stale`, and `meta.refreshing` explain source reliability. A stale cached
source is not equivalent to zero usage.

### Settings

| Family | Endpoints | Notes |
| --- | --- | --- |
| Settings | `GET /api/config`, `GET|POST /api/setup`, `GET /api/settings`, `POST /api/settings/budget`, `GET|POST /api/settings/model-routing`, `GET|POST /api/settings/heartbeat`, `GET /api/settings/export`, `POST /api/settings/import` | Public config strips known gateway/Notion/Scout secrets; import accepts one config file |

### Governance

| Family | Endpoints | Notes |
| --- | --- | --- |
| Councils | `GET /api/councils/summary`, `GET /api/councils/decisions`, `GET /api/councils/governance/scorecard`, `GET /api/councils/decisions/:decisionId/timeline`, `POST /api/councils/decisions/:decisionId/action` | Action returns `410` unless explicitly enabled |

## Request boundary

The server binds to loopback by default and only accepts localhost Host values.
Its mutation Origin check uses a local-origin prefix test, not exact origin
parsing, so it is defense in depth rather than an authentication or robust CSRF
boundary. Hidden navigation, module flags, and disabled buttons do not secure
endpoints; keep the service private and treat every POST/PATCH/DELETE as a real
local side effect.

`/data/*` is deliberately blocked. The SPA fallback serves `index.html` for any
non-API route, so an HTTP 200 proves route reachability but not successful React
rendering.

## Related

- [Configuration and Runtime Reference](reference-configuration.md)
- [How to Verify Operator Surfaces](how-to-verify-operator-surfaces.md)
- [System Architecture](explanation-system-architecture.md)
- [Read-Only Evidence Design](explanation-read-only-evidence-design.md)
