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
| `/api/signals` | GET | `{ data: { systems, attention, automations, loops, services, usage }, meta }`; `attention = { count, worst, standing, restricted, breakdown, partial, missing }` (count/worst = NEW items only, see the badge rule below); `automations = { failed, standingFailed, nextRunAt }` | `503` (no part read) |
| `/api/loops` | GET | `{ data: { projects, totals, attention, systems? }, meta }`; every attention row, pending confirmation and system carries `key`, `ackable`, `ack` | `503` |
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
| `/api/gbrain/trends` | GET | `{ enabled, since, until, entryCount, series: { quality, embeddedPercent, queue }, partial, skippedLines, meta }`; only the 24-hour tail is read (4 MiB / 5,000-line cap). `meta.ok: false` with `error.code` `gbrain_trends_too_large` (over the caps) or `gbrain_trends_corrupt` (no line readable) carries no series; `partial: true` with `skippedLines` keeps what was read | `503 gbrain_timeline_unavailable` |
| `/api/gbrain/search?q=` | GET | `{ data, meta }` | `400`, `429` (`Retry-After`), `503` |
| `/api/gbrain/pages/:slug` | GET | `{ data, meta }` | `400`, `404`, `429`, `503` |
| `/api/gbrain/graph?around=` | GET | `{ data, meta }` | `400 graph_around_required`, `429`, `503` |
| `/api/gbrain/actions` | GET | `{ ok, mode, actions }` (static allowlist) | — |
| `/api/gbrain/actions` | POST | `200` action result (`ok`, `action`, `status: completed`, `pending`, `refreshAfter`, `summary`, `payload`, `checkedAt`) | the action result with `error: { code, message }`: `400 confirmation_required`, `400 gbrain_action_rejected`, `409 gbrain_action_busy`, `502 gbrain_action_failed`, `504 gbrain_action_timed_out` (`pending` tells a cleanup still running); `503 gbrain_action_quarantined` |
| `/api/cron` | GET | `{ jobs, summary, …, meta }`; every job carries `ackKey` (`cron:<job id>`) and `ack`; `summary.failed` excludes acknowledged/shelved jobs, counted in `summary.standingFailed` | `503 automations_unavailable` |
| `/api/attention/acks` | POST | body `{ key, kind: 'ack'\|'shelve', until?: ISO\|null }` → `{ ok, key, ack: { kind, at, until } }` | `400 invalid_body` / `invalid_key` / `invalid_kind` / `invalid_until`, `404 ack_key_not_found`, `409 not_ackable` / `ack_store_full`, `503 attention_not_read` / `ack_store_unavailable` |
| `/api/attention/acks/:key` | DELETE | `{ ok, key, ack: null }` | `400 invalid_key`, `404 ack_not_found`, `503 ack_store_unavailable` |
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

### Badge rule (acknowledge / shelve)

A badge counts only NEW items: not acknowledged, not shelved, not restricted.
Countable items have stable keys: `system:<id>`, `finding:<project>:<CODE>:<12-hex hash of the complete
subject as mloop wrote it, before scrubbing or shortening>`, `confirmation:<project>:<id>` (an id that is
not a short plain id is `h<12-hex hash>` of the complete id; a confirmation finding about an id shares
its key) and `cron:<job id>`. Keys are hashes only and never carry hidden text. Restricted rows have `key: null` and are
never ackable; their counts are `attention.restricted` and never part of `count` or `worst`.

Every countable item has one fingerprint, `{ rank, reasonIds, counts }`: the severity rank (the shared
state ordering), the sorted stable ids of its reasons (machine identifiers, stored hashed; never display
text, a duration or a number that ticks) and each reason's magnitude (`counts[reasonId]`, 1 when the
reason has none). An item is worse than its acknowledgement when the rank rose, a reason id appeared
that was not acknowledged, or a count rose above its acknowledged value. A count falling or a reason
going away is never worse.

| Item | Reason ids | Count |
| --- | --- | --- |
| system (Hermes) | `hermes:blocked` | blocked tasks |
| system (Hermes) | `hermes:gateway-down`, `hermes:gateway-stale`, `hermes:gateway-unverified`, `hermes:kanban-unavailable`, `hermes:cron-unavailable`, `hermes:unavailable` | 1 |
| system (OpenClaw) | `openclaw:status-unavailable`, `openclaw:sessions-unavailable`, `openclaw:cron-unavailable`, `openclaw:session-conflict`, `openclaw:heartbeat-stale`, `openclaw:unavailable` | 1 |
| system (GBrain verdict) | `gbrain:link-extraction` | pages past the tolerance |
| system (GBrain verdict) | `gbrain:missing-embeddings` | chunks past the tolerance |
| system (GBrain verdict) | `gbrain:embed-job-probe` | chunks waiting |
| system (GBrain verdict) | `gbrain:queue` | stalled jobs |
| system (GBrain verdict) | `gbrain:gbrain-core`, `gbrain:stale-pages`, `gbrain:sources`, `gbrain:readers`, `gbrain:gbrain.<probe>`, `gbrain:<source id>`, `gbrain:<reader id>` | 1 |
| system (GBrain, legacy overview) | `gbrain:legacy-caveat:<12-hex sha256 of the caveat, lower-cased, whitespace collapsed, every run of digits replaced by '#'>` (the only producer without semantic ids: one id per distinct caveat) | 1 |
| system (GBrain, legacy overview) | `gbrain:stale-sources` | stale sources |
| system (GBrain) | `gbrain:capabilities-unavailable`, `gbrain:unavailable` | 1 |
| system (any) | `source:<source name>` (its read failed) | 1 |
| finding | `finding` | mloop's aggregated row count |
| confirmation | `confirmation` | the aggregate's count |
| cron job | `cron:failed` | 1 |

- `ack` ("seen, it will stay like this") holds while the item is not worse than its fingerprint at
  the acknowledgement. **While an item is worse than what was acknowledged it counts as new and is
  listed as new; when it is back at the acknowledged level or better, the acknowledgement applies
  again.** This is computed on every read; nothing about it is stored or scheduled. The system still
  adds at most one to the count.
- `shelve` silences until `until` (or until removed with `null`), except that a shelved item counts
  while its rank is critical.
- GETs are pure: they read the stored records and the current readings and write nothing.
- Only an item that counts now (`ackable: true`) can be acknowledged; `DELETE` removes a stored
  acknowledgement. POST and DELETE are the only writers; each also drops shelves that ran out and
  acknowledgements whose item has been absent, as seen at those writes, for 7 days.
- Store: `data/attention/acks.json` (0600, atomic temp + rename, at most 500 entries, version 3:
  `{ key, kind, at, until, id, absentSince, fingerprint }`). A file that is not valid (or is an older
  version) starts empty and is copied to `acks.json.corrupt-<time>` before the first write replaces it.
- Single writer by construction, like the app's other data files: one Mission Control process per
  data directory, one store instance per file per process, synchronous writes.
- When the store file cannot be read or written, `/api/signals`, `/api/loops` and `/api/cron` carry
  `acks: { available: false, reason }`, nothing is treated as acknowledged, and POST/DELETE answer
  `503 ack_store_unavailable` until a write succeeds again.

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
