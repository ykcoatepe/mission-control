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

## HTTP contract

One contract for every API route (`server/core/http.js`):

- **Errors** are `{ "error": { "code", "message" } }` with a real status.
  Only errors built with `httpError(status, code, message)` carry a
  client-facing message (any 4xx, `501`, `503`); every other error, and every
  other 5xx, answers `internal_error` / "Internal server error". Messages never
  contain a stack, child-process output, a path under a home or temp
  directory, or a bearer value. Unknown `/api/*` paths are a JSON `404`
  (`not_found`), API `OPTIONS` a JSON `405`, a malformed target a JSON `400`.
- **Readings** from a scheduled source carry `meta`
  (`{ ok, stale, observedAt, ageMs, error, latencyMs, source }`). A failed
  refresh keeps the last good reading and marks it stale; with no reading at
  all the route answers `503`. New endpoints send the envelope
  `{ data, meta }` (`503` when `data` is `null`); legacy endpoints keep their
  payload and add `meta` alongside (`/api/models`, an array, and
  `/api/settings/export`, a download, carry it in the `X-MC-Source-Meta`
  header).
- **No request starts a process and no `GET` writes.** Every write is a
  `POST`/`PATCH`/`DELETE`, carries `X-MC-Request: 1` and is audited.

Codes common to many routes: `400 invalid_json`, `413 payload_too_large`,
`403 forbidden_host` / `forbidden_origin` (guard), `500 internal_error`.

| Route | Method | Success | Error codes |
| --- | --- | --- | --- |
| `/api/health`, `/healthz` | GET | `{ ok, status: ok\|degraded, service, generatedAt, … }` (`/api/health` adds scheduler, lanes, event loop) | `500` |
| `/api/signals` | GET | `{ data: { systems, attention, automations, loops, services, usage }, meta }` | `503` (no part read) |
| `/api/loops` | GET | `{ data: { projects, totals, attention }, meta }` | `503` |
| `/api/loops/:project` | GET | `{ data: project, meta }` | `400 invalid_project`, `404 loop_project_not_found`, `503` |
| `/api/services` | GET | `{ data: { services, counts, gateways, ollama }, meta }` | `503` |
| `/api/operations/overview` | GET | overview schema `1` (`systems`, `overall`, `attention`, `evidence`, `capabilities`) + `meta` | `503 operations_unavailable` |
| `/api/hermes-kanban` | GET | board (`ok`, `profile`, `columns`, `summary`, …) + `meta` | `503 hermes_kanban_unavailable` |
| `/api/status` | GET | OpenClaw status payload + `meta` (`meta.ok` false until observed) | `500` |
| `/api/sessions` | GET | `{ count, sessions, meta }` | `503 sessions_unavailable` |
| `/api/gbrain/overview` | GET | normalized overview with `verdict` + `meta` | `500` |
| `/api/gbrain/health`, `/api/gbrain/sources`, `/api/gbrain/version` | GET | legacy reading + `meta` (last good, stale after a failed refresh) | `503 gbrain_<name>_unavailable` (with `meta`) |
| `/api/gbrain/integration-health` | GET | integration proof + `meta` | `500` |
| `/api/gbrain/synoptic` | GET | `{ data: synoptic, meta }` | `503` |
| `/api/gbrain/timeline?limit=N` | GET | `{ entries, …, meta }` | `503 gbrain_timeline_unavailable` |
| `/api/gbrain/search?q=` | GET | `{ data, meta }` | `400`, `429` (`Retry-After`), `503` |
| `/api/gbrain/pages/:slug` | GET | `{ data, meta }` | `400`, `404`, `429`, `503` |
| `/api/gbrain/graph?around=` | GET | `{ data, meta }` | `400 graph_around_required`, `429`, `503` |
| `/api/gbrain/actions` | GET | `{ ok, mode, actions }` (static allowlist) | — |
| `/api/gbrain/actions` | POST | `200` action result (`ok`, `action`, `status: completed`, `pending`, `refreshAfter`, `summary`, `payload`, `checkedAt`) | the action result with `error: { code, message }`: `400 confirmation_required`, `400 gbrain_action_rejected`, `409 gbrain_action_busy`, `502 gbrain_action_failed`, `504 gbrain_action_timed_out` (`pending` tells a cleanup still running); `503 gbrain_action_quarantined` |
| `/api/cron` | GET | `{ jobs, summary, …, meta }` | `503 automations_unavailable` |
| `/api/cron/create` | POST | `{ ok, message, job }` | `400 invalid_job` / `invalid_schedule` / `invalid_enabled` / `invalid_session` / `invalid_payload` / `invalid_model`, `500` |
| `/api/cron/:id/toggle` | POST | `{ ok, message, job? }` | `400 invalid_enabled` / `invalid_scheduler` / `cron_id_required` / `invalid_cron_id`, `404 hermes_cron_job_not_found`, `409 hermes_cron_unavailable`, `500` |
| `/api/cron/:id/run`, `/api/cron/:id` | POST, DELETE | `{ ok, message }` | `400 invalid_cron_id`, `501 hermes_cron_read_only`, `500` |
| `/api/cron/:id/model` | PATCH | `{ ok, message, job }` | `400 invalid_model` / `invalid_thinking`, `404`, `409`, `501 not_implemented`, `500` |
| `/api/calendar` | GET | `{ entries, updatedAt, lastCronSyncAt, …, meta }` | `503 calendar_unavailable` |
| `/api/calendar` | POST | `{ ok, entry, entries }` | `400 calendar_title_required` / `invalid_calendar_link`, `409 calendar_unavailable` |
| `/api/calendar/:id` | PATCH | `{ ok, entry, entries }` | `400 calendar_scheduler_owned`, `404 calendar_entry_not_found`, `409 calendar_unavailable` / `calendar_override_unavailable` |
| `/api/calendar/sync-cron` | POST | `{ ok, synced, entries, updatedAt, lastCronSyncAt }` | `503 calendar_scheduler_unavailable` (nothing written), `409 calendar_unavailable` |
| `/api/costs?period=&month=` | GET | usage payload with `meta` (`stale`, per-source status) | `400 invalid_usage_query`, `500` |
| `/api/costs/codexbar`, `/api/costs/months` | GET | CodexBar costs / month list | `400 invalid_usage_query`, `500` |
| `/api/usage/summary` | GET | `{ data, meta }` | `503` |
| `/api/aws/costs` | GET | `{ period, total, daily, services, meta }` (scheduled Cost Explorer read) | `404 aws_disabled`, `503 aws_costs_unavailable` |
| `/api/models` | GET | array of models; `meta` in `X-MC-Source-Meta` | `503 models_unavailable` |
| `/api/ollama/telemetry`, `…/history`, `…/models` | GET | telemetry payload + `meta` | `503 ollama_unavailable` |
| `/api/config` | GET | allowlisted public config (`name`, `subtitle`, `modules`, `aws.enabled`) + `meta` | `500` |
| `/api/setup` | GET | `{ needsSetup, gatewayRunning, gatewayPort, gatewayVersion, detectedConfig, meta }`; `gatewayRunning` is the scheduled reachability reading (`null` when not current) | `500` |
| `/api/setup` | POST | `{ success, config }`; accepts only `dashboardName`, `gateway { port, token }`, `modules` (known ids, booleans) | `400 invalid_setup` / `unsupported_setup_field` / `unknown_module` / `invalid_module_flag` / `invalid_gateway`, `503 settings_config_unavailable` / `config_store_unavailable` |
| `/api/settings`, `/api/settings/model-routing`, `/api/settings/heartbeat` | GET | settings reading + `meta` | `503 settings_config_unavailable` |
| `/api/settings/model-routing`, `/api/settings/heartbeat` | POST | `{ status: saved }` | `400 invalid_model` / `invalid_interval`, `503`, `500` |
| `/api/settings/budget` | POST | `{ status: saved, budget }` | `400 invalid_budget`, `503` |
| `/api/settings/export` | GET | redacted config document (download); `meta` in `X-MC-Source-Meta` | `500` |
| `/api/settings/import` | POST (multipart `config`) | `{ status: imported, message }` | `400 config_file_required` / `invalid_upload` / `invalid_config` / `redacted_identity_required` / `redacted_value_unavailable`, `413 payload_too_large`, `503` |
| `/api/councils/summary`, `/api/councils/decisions`, `/api/councils/governance/scorecard`, `/api/councils/decisions/:id/timeline` | GET | archive reads (no snapshot is persisted) | `503 councils_archive_unavailable` |
| `/api/councils/decisions/:id/action` | POST | `{ ok, decision }` | `410 council_actions_disabled` (default; with `mode`, `recommendation`), `400 decision_id_required` / `council_action_required` / `council_note_required`, `404 decision_not_found`, `503` |
| `/cron-search`, any non-API path | GET | static page / SPA shell | JSON `404 not_found` when the file is missing |

`tests/appBootSmoke.test.js` holds the route table (`EXPECTED_ROUTES`), the
pure-GET sweep, and a contract sweep that forces a failure on every route.

The GBrain action catalog contains exactly:

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

State words are one vocabulary with one ordering everywhere (server
`sources/gbrain/state.js`, Operations, frontend `lib/state.ts`):
critical > warning > unavailable > healthy > inactive. An aggregate is the
worst relevant condition; nothing read is `unavailable`, never healthy.

## Request boundary

The server binds to loopback by default and only accepts localhost Host values.
Writes, and every API read that carries an `Origin`, must match the server's
own origin exactly; `Sec-Fetch-Site: cross-site` is refused. Every mutating
request must carry `X-MC-Request: 1` (report-only by default) and is written
to the audit log. Hidden navigation, module flags, and disabled buttons do not
secure endpoints; keep the service private and treat every POST/PATCH/DELETE
as a real local side effect.

`/data/*` is deliberately blocked (JSON `404`). The SPA fallback serves
`index.html` for any non-API route, so an HTTP 200 proves route reachability
but not successful React rendering.

## Related

- [Configuration and Runtime Reference](reference-configuration.md)
- [How to Verify Operator Surfaces](how-to-verify-operator-surfaces.md)
- [System Architecture](explanation-system-architecture.md)
- [Read-Only Evidence Design](explanation-read-only-evidence-design.md)
