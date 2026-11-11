# Backend Redesign — proposal

Status: proposal, not implemented. Companion to
[Design System Reference](reference-design-system.md). Evidence for every
claim is in the 2026-11-11 backend map (kept outside the repo).

## Why

Mission Control is a composition layer: it reads other systems and exposes a
few bounded writes. Today almost every request does that reading itself, by
shelling out to a CLI while the browser waits.

| Symptom (measured on the live instance, 2026-11-11) | Cause |
| --- | --- |
| `/api/operations/overview` ~10 s, `/api/gbrain/health` 21 s, `/api/gbrain/overview` > 40 s, `/api/calendar` 16 s, `/api/models` 14 s, `/api/ollama/telemetry` 22 s, `/api/skills` 500 after 22 s | A request runs CLI probes inline; GBrain has no cache and a 285 s timeout |
| OpenClaw shown as "unavailable", `/api/sessions` returns an empty list | Concurrent OpenClaw CLI calls collide; the failed read is cached as an authoritative empty list |
| The whole server stalls for seconds | `execSync` in the status refresh blocks the event loop |
| Numbers that are not real | Hard-coded fallbacks returned as data (46 memory files, 225 chunks, a "main" agent, 15,713 pages, model lists) |
| `GET` requests that write | Calendar sync, task reconcile, status snapshot, GBrain timeline ledger |
| Three error contracts | `500 {error}`, `200 {status:'error'}`, `200` with an empty or invented body |
| One 861-line `server.js` | Config load, a sessions service, 22 hand-wired routers, no error middleware, no shutdown |

## Shape

```
server/
  index.js            listen, signals, graceful shutdown
  app.js              createApp(deps) — testable without a port
  core/
    config.js         validate once, frozen, redacted view; ConfigStore = the one atomic writer
    exec.js           the one async runner: execFile + argv, timeout, per-tool lane
    source.js         createSource({ id, read, ttl, timeout }) → last-good store
    scheduler.js      owns every background refresh; nothing else sets intervals
    http.js           asyncHandler, JSON 404 for /api/*, one error handler
    guard.js          Host/Origin (exact), write guard, audit event for every write
  sources/            one module per upstream: read + parse + typed result, no HTTP
    gbrain/ hermes/ openclaw/ ollama/ usage/ mloop/ codex/ claude-code/ launchd/
  routes/             thin: compose from sources, never spawn
```

Rules:

1. **A request never spawns a process.** Sources are refreshed by the
   scheduler into an in-memory last-good store; routes compose from memory and
   answer in milliseconds.
2. **Every reading carries its own truth.** One envelope everywhere:
   `{ data, meta: { ok, stale, observedAt, ageMs, error, latencyMs, source } }`.
   A failed read keeps the last good data and marks it stale; with no good data
   the value is `null`, never a default.
3. **One runner, with lanes.** `core/exec.js` is the only place a child process
   starts. Each tool has a lane (`openclaw` concurrency 1 — it corrupts under
   parallel calls; `gbrain` 2; `hermes` 2). No `execSync`, no shell strings; a
   lint rule enforces both.
4. **`GET` is pure.** Sync, reconcile, snapshot and ledger writes move to the
   scheduler or to explicit `POST` actions.
5. **One error contract.** Real status codes with
   `{ error: { code, message } }`. Unknown `/api/*` returns JSON 404.
6. **Writes are few, guarded and logged.** Exact-origin check, fail closed, a
   required request header on every mutating route, an audit event per write.
   The GBrain action model (static allowlist, fixed arguments, Check vs Change,
   `confirmed === true`, single flight) is preserved verbatim and its
   confirmation gate moves into the executor. Long Change actions become jobs
   (`202` + poll).
7. **No fabricated data, no upstream leftovers.** Remove the stub
   `/api/quick/*` routes, the duplicate config loader, the duplicate Notion
   code, and the Scout and AWS modules (disabled here, written for another
   operator).

## New endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/signals` | Small fixed contract for the shell: per-system state and age, attention count, failed automations, usage today vs budget. Replaces three 30 s polls of heavy payloads. |
| `GET /api/health` | Liveness plus dependency state and event-loop lag. |
| `GET /api/gbrain/search?q=` , `GET /api/gbrain/pages/:slug` | Read-only brain search and page read. |
| `GET /api/usage/summary` | ~1 KB derived from the cached usage data. |
| `GET /api/loops`, `GET /api/loops/:project` | Manager-loop ledger: projects, open findings, pending live confirmations with deadlines. |
| `GET /api/agent-sessions` | One roster across Claude Code, Codex, Hermes and OpenClaw (metadata only, no message content). |
| `GET /api/services` | launchd services, cron ticker age, gateway reachability. |

## Navigation after the redesign

| Group | Item | Path | Source |
| --- | --- | --- | --- |
| — | Brain (home) | `/` | GBrain health first; "Knowledge" view = search and pages |
| Operate | Attention | `/attention` | manager loops: findings and pending confirmations |
| Operate | Work | `/work` | Hermes board |
| Operate | Automations | `/automations` | Hermes and OpenClaw schedules |
| Operate | Sessions | `/sessions` | all hosts |
| Know | Usage | `/usage` | |
| Run | Services | `/services` | new |
| Run | Agents | `/systems` | |
| Run | Local models | `/ollama` | |
| Utility | Settings, Audit | | |

## Order of work

1. Safety net first: convert the tests that assert on source text into
   behaviour tests through `createApp(deps)`; add a boot smoke test asserting
   the route table and that no `GET` writes.
2. `core/` (app factory, config, exec, source, scheduler, http, guard).
3. Sources and routes, one area per author: operations and signals; GBrain
   (with search); Hermes and automations; sessions and agent roster; usage;
   Ollama; loops and services; settings.
4. Frontend pages against the new contracts.
5. Independent review of the write paths and guards before any deployment.
