# Operator Surfaces Reference

This is the canonical inventory of Mission Control's browser routes, API
families, and action boundaries. `frontend/src/appRoutes.tsx` and
`server/routes/` remain the executable source of truth.

## Browser routes

### Primary navigation

| Label | Page title | Route | Module | Data owner |
| --- | --- | --- | --- | --- |
| Brain | Shared Brain | `/` | `dashboard` | Operations overview + GBrain actions |
| Work | Hermes Kanban | `/work` | `workshop` | Hermes Kanban |
| Automations | Cron Jobs | `/automations` | `cron` | OpenClaw + Hermes cron |
| Sessions | Conversations | `/sessions` | `chat` | OpenClaw sessions/chat |
| Explore | GBrain | `/gbrain` | `gbrain` | GBrain runtime and timeline |
| Usage | Cost Tracker | `/usage` | `costs` | OpenClaw, Hermes, Claude Code, CodexBar |
| Systems | Agent Hub | `/systems` | `agents` | agents, sessions, models |

The title differences for Sessions/Conversations, Usage/Cost Tracker, and
Systems/Agent Hub are intentional: navigation names describe the operator
destination while the page retains its established product title.

### Utility and direct routes

| Route | Visibility | Purpose |
| --- | --- | --- |
| `/settings` | utility navigation | Setup, routing, heartbeat, budget, import/export |
| `/councils` | utility navigation | Governance archive and open-approval alarm |
| `/setup` | direct | First-run configuration |
| `/workshop` | direct | Local/OpenClaw task board and execution |
| `/calendar` | direct | Schedule and local calendar entries |
| `/office` | direct | Digital Office telemetry and triage |
| `/team` | direct | Team structure and bootstrap suggestions |
| `/ollama` | primary System navigation | Read-only Ollama runtime and model telemetry; inventory may include cloud-backed models |
| `/diagnostics` | direct | Memory, Docs, Scout, AWS, and Skills tabs |

Direct routes are mounted even when omitted from navigation. Module flags are
presentation controls, not authorization.

### Compatibility redirects

| Old route | Current target |
| --- | --- |
| `/kanban` | `/work` |
| `/cron` | `/automations` |
| `/conversations` | `/sessions` |
| `/costs` | `/usage` |
| `/agents` | `/systems` |
| `/memory` | `/diagnostics?tab=memory` |
| `/scout` | `/diagnostics?tab=scout` |
| `/aws` | `/diagnostics?tab=aws` |
| `/skills` | `/diagnostics?tab=skills` |

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

### Work, automations, and sessions

| Family | Endpoints | Notes |
| --- | --- | --- |
| Hermes Kanban | `GET /api/hermes-kanban`, `GET /api/hermes-kanban/tasks/:taskId`, `POST /api/hermes-kanban/actions` | Named actions and flag-safe argument validation |
| Cron | `GET /api/cron`, `POST /api/cron/create`, `POST /api/cron/:id/toggle`, `POST /api/cron/:id/run`, `PATCH /api/cron/:id/model`, `DELETE /api/cron/:id` | Hermes jobs cannot run/delete; toggle/model are allowed |
| Calendar | `GET /api/calendar`, `POST /api/calendar`, `PATCH /api/calendar/:id`, `POST /api/calendar/sync-cron` | Combines schedule data with local entries |
| Tasks | `GET /api/activity`, `GET /api/tasks`, `GET /api/tasks/board`, `GET /api/tasks/:taskId`, `POST /api/tasks`, `POST /api/tasks/add`, `POST /api/tasks/assistant`, `PATCH /api/tasks/:taskId`, `DELETE /api/tasks/:taskId`, `POST /api/tasks/:taskId/execute` | Execute dispatches real OpenClaw work; list/board may reconcile and persist state |
| Sessions | `GET /api/sessions`, `GET /api/sessions/:sessionKey/history`, `POST /api/sessions/:sessionKey/send`, `DELETE /api/sessions/:key/close` | `close` hides locally; it does not terminate OpenClaw |
| Chat | `POST /api/chat` | Gateway/SSE proxy with abort handling |

### Usage, systems, and models

| Family | Endpoints | Notes |
| --- | --- | --- |
| Status | `GET /api/status` | Dashboard/runtime status snapshot |
| Usage | `GET /api/costs?period=7d`, `GET /api/costs/codexbar` | Periods are normalized; metadata reports source readiness, stale state, and refresh state |
| Agents | `GET /api/agents`, `POST /api/agents/create`, `POST /api/agents/:agentId/model` | Registry, live sessions, custom agents, model override |
| Team/Office | `GET /api/team/structure`, `POST /api/team/structure/bootstrap`, `GET /api/office/telemetry` | Bootstrap produces suggested structure; office is live telemetry |
| Models | `GET /api/models`, `GET /api/model`, `POST /api/model` | Catalog and OpenClaw default model |
| Ollama | `GET /api/ollama/telemetry`, `GET /api/ollama/telemetry/history`, `GET /api/ollama/telemetry/models`, `POST /api/ollama/optimization` | Local model and memory telemetry |

Usage merges included/local consumption and estimated spend from multiple
sources. `meta.openclawStatus`, `meta.hermesStatus`, `meta.claudeCodeStatus`,
`meta.stale`, and `meta.refreshing` explain source reliability. A stale cached
source is not equivalent to zero usage.

### Settings and diagnostics

| Family | Endpoints | Notes |
| --- | --- | --- |
| Settings | `GET /api/config`, `GET|POST /api/setup`, `GET /api/settings`, `POST /api/settings/budget`, `GET|POST /api/settings/model-routing`, `GET|POST /api/settings/heartbeat`, `GET /api/settings/export`, `POST /api/settings/import` | Public config strips known gateway/Notion/Scout secrets; import accepts one config file |
| Memory | `GET /api/memory` | Local memory projection |
| Docs | `GET /api/docs`, `POST /api/docs/upload`, `GET /cron-search` | Upload limit is 20 files; settings imports and document uploads have separate temporary paths |
| Skills | `GET /api/skills`, `POST /api/skills/:name/toggle`, `POST /api/skills/:name/install`, `POST /api/skills/:name/uninstall` | Install/uninstall currently acknowledge but do not implement package changes |
| Scout | `GET /api/scout`, `GET /api/scout/status`, `POST /api/scout/scan`, `POST /api/scout/deploy`, `POST /api/scout/dismiss` | Optional Brave Search-backed workflow |
| AWS | `GET /api/aws/services`, `GET /api/aws/bedrock-models`, `POST /api/aws/generate-image`, `GET /api/aws/image/:id`, `GET /api/aws/gallery`, `GET /api/aws/s3-image/:key`, `GET /api/aws/costs` | Optional Bedrock/S3 integration |

### Governance and operator actions

| Family | Endpoints | Notes |
| --- | --- | --- |
| Councils | `GET /api/councils/summary`, `GET /api/councils/decisions`, `GET /api/councils/agents`, `GET /api/councils/governance/scorecard`, `GET /api/councils/decisions/:decisionId/timeline`, `POST /api/councils/decisions/:decisionId/action` | Action returns `410` unless explicitly enabled |
| Ops | `GET /api/ops/events`, `POST /api/ops/openclaw/self-heal` | Local event history and a real OpenClaw recovery action |
| Quick | `POST /api/heartbeat/run`, `POST /api/quick/emails`, `POST /api/quick/schedule` | OpenClaw gateway actions |

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
