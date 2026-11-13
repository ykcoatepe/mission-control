# server/core

Shared plumbing for every area. Binding design:
[`docs/explanation-backend-redesign.md`](../../docs/explanation-backend-redesign.md).

| Module | What it owns |
| --- | --- |
| `config.js` | `loadConfig()` reads and validates once, never writes; frozen result; `publicView()` / `publicMcView()` are an ALLOWLIST (`PUBLIC_CONFIG_SCHEMA`, `PUBLIC_MC_SCHEMA`: path → `'number'`, `'boolean'`, `'url'`, `{ $string: { max, fallback? } }`, `{ $array: shape }`, or an object naming exactly the children that may appear); anything not listed is omitted, so a new config field is private until it is added there (never add a credential-bearing field). There is no open-ended map and no bare `string`: a display string is `{ $string: { max } }` (`max` is required; control characters are stripped, it is cut to `max`, and a value that `redactString` would change becomes its `fallback`, or is omitted), every module id is listed in `PUBLIC_MODULE_IDS`, and a `url` is parsed with the WHATWG parser with userinfo stripped. An unknown `$` key is a `TypeError` at use. `redact` keeps the settings export complete with placeholders, and `redactString` is the second line of defence for free text; `createConfigStore()` is the only writer of `mc-config.json` (atomic tmp+rename). Gateway token drift is `config.gatewayTokenCheck`, not a crash. |
| `exec.js` | The one process runner: `spawn` + argv in its own process group, per-call timeout and output cap, lanes (`openclaw` 1, `gbrain` 2, `hermes` 2, `default` 4, `lookup` 2 with a bounded queue of 4), single flight by `key`, `killAll()` + `drain()` on shutdown. Timeout/shutdown signal the whole group (TERM, then KILL); a lane slot is freed only when the group is verified gone, otherwise the lane is quarantined (`lane_quarantined`, `drain()` false, `/api/health` `status: degraded`). Resolves `{ ok, code, signal, stdout, stderr, timedOut, truncated, latencyMs, queuedMs, error }`; never throws for a failed command. Typed `error.code`s include `timeout`, `shutdown`, `queue_timeout`, `lane_busy`, `lane_quarantined`, `kill_unverified`, `max_output`. Add or resize lanes without editing core: `createApp({ execLanes: { name: { concurrency, queueTimeoutMs, maxQueue } } })`. User-initiated lookups use `{ lane: 'lookup' }`. |
| `source.js` | `createSource({ id, read, ttlMs, timeoutMs, staleAfterMs })`: last-good store, single-flight refresh, envelope `{ data, meta: { ok, stale, observedAt, ageMs, error, latencyMs, source } }`. |
| `scheduler.js` | Owns every background refresh: `register(source, { intervalMs, jitterMs })`, no overlap, unref'd timers, `status()` for `/api/health`. |
| `http.js` | `asyncHandler`, `httpError`, request id + one log line per `/api` request, `classifyRequestPath` (the one path canonicalization) with `apiBoundary` / `nonApiOnly` / `apiFallthrough` (static and SPA never answer an API path; malformed target = JSON 400; API `OPTIONS` = JSON 405), JSON 404, the final error handler (`{ error: { code, message } }`), `sendEnvelope`, `listRoutes`. |
| `guard.js` | Host allowlist, exact Origin match (writes, and every API read that carries `Origin`; `Sec-Fetch-Site: cross-site` is rejected on any API request), `X-MC-Request: 1` write guard (report-only by default), fail closed; `createAuditLog` / `auditWrites`. |
| `health.js` | Event-loop lag monitor and the `/api/health` payload. |

## Contract for an area author

1. **A request never spawns a process.** Put the upstream read in a source
   under `server/sources/<system>/`. The read runs CLIs only through
   `exec.run(bin, argv, { lane, timeoutMs, key })` (or an area client built on
   it, like `services/openclawClient.js`). No `execSync`/`spawnSync`, no shell
   strings, no `child_process` import in area code.
2. **The read returns real data or throws.** Throw (with an `error.code`) when
   the upstream was not actually observed. Never return a default, an empty
   list standing in for "unknown", or a fabricated number. The source keeps the
   last good value and marks it stale; with none, `data` is `null`.
3. **Register the source with the scheduler** in `server/app.js`
   (`scheduler.register(source, { intervalMs, jitterMs })`). Nothing else sets
   intervals.
4. **The route is thin.** It reads `source.snapshot()` and answers in
   milliseconds. New endpoints send the envelope with `sendEnvelope(res, snap)`
   (200 with data, 503 with `data: null`). Existing endpoints keep their
   payload shape for the current frontend and add `meta` alongside.
5. **GET is pure.** A GET handler never writes a file. Persisted snapshots are
   written by the scheduled refresh; mutations are explicit `POST`/`PATCH`/
   `DELETE` routes.
6. **Errors** are thrown (`httpError(status, code, message)` for client errors)
   and reach the one error handler. Do not `res.status(500).json(...)` by hand
   and never put `error.message` from a child process into a response.
7. **Writes** go through the guard automatically and are audited. Config
   changes go through `configStore.persist()`.
8. **Tests**: a counter-example test per invariant you touch (failed read keeps
   last-good, no request-time spawn, GET writes nothing). Add the route to the
   pure-GET sweep in `tests/appBootSmoke.test.js` when it becomes pure, and
   update `EXPECTED_ROUTES` when the route table changes.

## Attention acknowledgements (badge rule)

`server/services/attentionAcks.js` is the one store for acknowledged and
shelved attention items (`data/attention/acks.json`, 0600, atomic, bounded, an
invalid file kept as `.corrupt-<time>`). Keys and fingerprints
(`{ rank, reasonIds, counts }`, `worseThan()`) come from
`server/sources/mloop/attention.js` (`attentionItems()`);
`needsOperator({ ..., acks })`, `loopsView(..., { acks })` and
`projectCronAcks(cron, acks)` (`sources/openclaw/automations.js`) apply it on
read. Holding is a pure function, computed on every read: **while an item is
worse than what was acknowledged it counts as new, and when it is back at the
acknowledged level or better the acknowledgement applies again.** Nothing is
scheduled and nothing about a void is stored. The only writers are
`POST /api/attention/acks` and `DELETE /api/attention/acks/:key`
(`server/routes/attentionAcks.js`), guarded and audited like every mutation;
they also collect acknowledgements whose item has been absent for 7 days.
Single-process assumption: one Mission Control process uses a data directory
(as for the calendar and config files), so the store has no cross-process
locking; one instance per file per process, synchronous atomic writes. When the
file cannot be read or written, reads treat nothing as acknowledged, envelopes
carry `acks: { available: false }` and writes answer 503, until a write
actually succeeds. An item with more than 128 reasons is never held and not
ackable (no folding).
Contract: `docs/reference-operator-surfaces.md`.

## Worked example: OpenClaw status

The status/heartbeat read is the first path converted. Files:

- `server/services/statusData.js` — the existing reader. `openclaw status` and
  `openclaw system heartbeat last --json` now run through `openclawCli` (the
  `openclaw` lane, serialized with every other OpenClaw call). With
  `refreshOnRead: false`, reads never start a refresh and never write.
  `readObservedStatus()` refreshes once and throws unless the status CLI was
  observed.
- `server/sources/openclaw/status.js` — the source:

```js
const { createSource } = require('../../core/source');

function createOpenclawStatusSource({ statusService, now = Date.now }) {
  return createSource({
    id: 'openclaw.status',
    read: () => statusService.readObservedStatus(), // throws when not observed
    ttlMs: 60_000,
    timeoutMs: 60_000,
    staleAfterMs: 3 * 60_000,
    now,
  });
}
```

- `server/app.js` — wiring:

```js
const statusSource = createOpenclawStatusSource({ statusService, now, logger });
scheduler.register(statusSource, { intervalMs: STATUS_REFRESH_INTERVAL_MS, jitterMs: 1000 });
app.use(buildStatusRouter({ statusService, statusSource }));
```

- `server/routes/status.js` — the thin route. It keeps the legacy payload for
  the current frontend and adds the envelope's `meta`:

```js
router.get('/api/status', async (req, res) => {
  const snapshot = statusSource.snapshot();
  const payload = snapshot.data || await statusService.getStatusResponse();
  return res.json({ ...payload, meta: snapshot.meta });
});
```

A new endpoint would instead be
`router.get('/api/x', (req, res) => sendEnvelope(res, xSource.snapshot()))`.

- Tests: `tests/sessionsAndStatusSources.test.js` (serialized lane, GET purity,
  last-good on CLI failure), `tests/appBootSmoke.test.js` (route table, pure
  GETs, scheduler-driven refresh).
