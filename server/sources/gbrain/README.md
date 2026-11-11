# GBrain read sources

`gbrain.refresh` is registered with the core scheduler every 180 seconds. It
refreshes independent last-good sources with at most two readers at once. Every
scheduled CLI uses the shared core runner's `gbrain` lane, fixed argv, 45-second execution
and 10-second lane-wait budgets, and a 2 MiB output cap. The source itself times
out at 60 seconds. Heavy reads do not run on HTTP requests. Evidence becomes
stale after 360 seconds; failure immediately marks it unavailable without losing
last-good values. Error responses never include process stdout/stderr.

The producer matrix is health (`call get_health`), source sync inventory
(`call get_status_snapshot`), counts (`stats --source __all__ --json`), queue
(`jobs stats --json`), version, tool discovery, feature recommendations, provider
readiness, Hermes proxy health and whitelisted local integration metadata.
Consumers are the six legacy dashboard endpoints, the Operations
`readSnapshot().overview` contract, and the new synoptic. A scheduler refresh
captures timeline changes/heartbeats using the existing JSONL ledger and then
refreshes its memory source; GET never captures or reads that file.

`contract.d.ts` defines the v1 synoptic envelope. Legacy payloads retain their
presentation fields and add `meta`; legacy warning/inactive colors continue to
work. The synoptic uses the full healthy/warning/critical/unavailable/inactive
vocabulary through `deriveState`. Unknown metrics are null, historical audit
numbers are removed, reader calls are never inferred from tool discovery.

Local reader evidence inspected on 2026-11-11: Hermes profile MCP YAML, Codex MCP
TOML, Claude Code MCP JSON and OpenClaw MCP JSON all expose configuration.
These establish configuration, not a successful connection. No per-reader
last-call time/count is available from these sources. GBrain search telemetry is
aggregate and best-effort rather than attributable per reader; raw session or
transcript bodies are not used. The synoptic therefore omits lastCallAt and
callCount and the entire reader connection object. A top-level `readersNote`
says `connection telemetry is not observable locally`. Unobservable telemetry
has no effect on reader state or the aggregate synoptic state. Reader state is
the integration reading's state: fresh, configured integration is healthy;
not configured is inactive; a failed integration read is unavailable (including
when the source retains a previously configured last-good value). Stale
integration evidence remains warning. An unavailable reading means a read was
attempted and failed, not that a telemetry source does not exist.

Reader edges carry integration state, the label `configured`, and its observed
at time, with no measurement or unit. The edge contract distinguishes these
configuration edges from measured source/queue edges. The reader producer is
`readReaders` (the four whitelisted local configuration files); the runtime
source holds that metadata and the synoptic composes it. Legacy Operations
consumes its existing overview contract, not reader edges. Source sync is
separate evidence.
Behind remains null unless explicitly reported by the upstream. `excludedByPolicy`
now describes exclusion from freshness scoring: disabled or non-sync-tracked
sources are inactive, excludedByPolicy=true, with reason `sync disabled` or
`not sync-tracked`. This uses the existing isSyncTrackedSource policy, preserved
as a boolean after local paths are discarded. Tracked sources expose ageHours
and thresholdHours; an absent sync time is warning with reason `never synced`.
A timestamp beyond its existing per-source threshold is warning. No threshold
was changed and zero pages never establishes exclusion.

Measured CLI latencies, sequential reads against the local ~63k-page brain on
2026-11-11 (milliseconds): `--help` 314, tools 348, health 1914, status snapshot
1161, jobs 892, stats 1060, features 3702, providers 414, sources list 486,
sources status 1178, keyword search (2) 577, page read 408, depth-1 bidirectional
traversal 1834, outgoing links (100) 427. Source status returned ~304 KiB;
status snapshot supplies the lighter sync shape used here. No global degree
ranking is offered by the advertised read tools; health's `most_connected` was
empty. Scanning ~63k pages with per-page link reads is unsuitable, so graph
supports neighbourhoods only and makes no claim to globally top-linked pages.

`GET /api/gbrain/graph?around=projects%2Fmission-control&limit=100` registers
bounded interest in memory and returns an envelope. On a cold key it returns
503/gbrain_graph_pending until the next scheduler pass (within two minutes when
the lane is available). Each neighbourhood source has a 15-minute TTL; at most
16 primary entries plus at most 6 staging entries are retained. Graph jobs use depth=1, direction=both; the runner bounds bytes
and time. `degree` is the number of incident edges in the returned subgraph,
not global degree. Unknown title/type are null. The `around` parameter is
required; no default neighbourhood is presented as a top-N global graph.

Suggested wording for **server/core/README.md**, intentionally not edited:

> Exception: explicit user-initiated GBrain search and page lookups may run
> read-only CLI commands through the bounded lookup lane with validated bounded
> inputs, single-flight and a short per-query TTL cache. Dashboard and graph
> GETs continue to compose scheduled memory snapshots and never write files.

Search/page caches retain at most 100 primary keys plus 6 staging keys, expire after 15 seconds and preserve
last-good results with stale/error metadata if refresh fails. A page slug must
match `[A-Za-z0-9][A-Za-z0-9_-]*(/[A-Za-z0-9][A-Za-z0-9_-]*)*`, at most 240
characters; encode embedded slashes in the route parameter. Search requires
1–300 printable characters and limit 1–100. Page bodies use the first bounded 40 KB window;
large responses can be marked truncated. Transcript/session records are
withheld and only whitelisted public fields leave a reader. This API currently
does not expose page-window pagination.

Action definitions and commandRunner remain unchanged. Confirmation is also
enforced by the executor before taking its existing single-flight lock. W1
requires the exact boolean true; caller-supplied argv never enter execution.

Worktree-only HTTP verification on port 3401, 2026-11-11T08:03Z: overview
16.84ms (first HTTP connection; previous warm reading 2.50ms), health 2.25ms,
sources 0.94ms, version 0.83ms, integration-health 1.28ms, timeline 1.27ms,
synoptic 1.77ms; these GETs started zero CLI commands. Search: 575.56ms cold /
1.07ms cached. Encoded-slug page window: 466.68ms cold / 0.83ms cached,
content observed. Graph: 1.00ms warm, 9 nodes / 12 links. Both test-server runs
were stopped. Scheduler jobs were exercised with core scheduler.runNow; the
full production scheduler and port 3333 were not started or changed.

The initial page-read smoke failed because include_content cannot be combined
with body:auto in this CLI. The corrected request uses body:window and a fixed
40 KB byte range, with a fake seam asserting those exact fields.

Validation: 14 new behavior/counter-example tests cover executor confirmation,
state derivation, failed-read retention, no request-time probes, lane/caps, null
counters, bounded lookups, privacy/redaction, graph scheduling, reader metadata,
pure HTTP reads, timeline scheduling and the Operations contract. Existing
fixture-only expectations were replaced with unavailable/null expectations;
action catalog/argv, stale-page/embed-lag and ledger-format tests still apply.
Independent review was not run: parent mloop preflight for mission-control-rehaul
/ gbrain-reviewer returned NOT_INITIALIZED; no participant or project was created.
Production activation and useful-live confirmation remain with the coordinator.

## Shared operational verdict

`verdict.js:buildGBrainVerdict` alone produces `{state,reasons:[{elementId,state,text}]}`.
The synoptic state and the overview's state/trust status are that verdict state;
overview caveats are exactly its warning/critical/unavailable reason texts.
Inactive exclusion reasons are visible in the verdict and do not degrade health.
Operations consumes this same verdict and caveat projection, including when a
probe has failed and the metrics still contain a last-good value. Its GBrain
source projects the GBrain service's current in-memory overview; it does not
cache another verdict for 60 seconds. Signals consumes that Operations result.
The legacy presentation helper's compatibility path remains for older callers
without a verdict; every mounted GBrain endpoint supplies the shared verdict.

A declared embed-job probe failure is an **unavailable reason**, not an omitted
note: `embed-job-probe` / `Embed-job probe unavailable; the missing-embedding
verdict uses embedding age only.` This exact reason and state appear in both
contracts; it cannot silently leave Operations healthy. Failed scheduled probes
also have unavailable reasons. Unobservable reader connection telemetry remains
the existing readersNote and does not degrade health.

Producer/consumer seam: scheduled probe snapshots -> source freshness classifier
+ shared verdict -> synoptic and overview -> Operations memory projection ->
signals. No HTTP consumer starts a probe. Injected fixtures cover agreement for
healthy, stale source, failed probe and excluded sources, and cover a subsequent
failure without refreshing an Operations cache.

Real-data inspection on 2026-11-11: pdfquickfix was sync-enabled, sync-tracked
and fresh (last_sync_at 2026-11-11T09:03:40.616Z, 24h threshold); the earlier null
timestamp was not the current observation. tk-omc-ain had sync_enabled=false,
and was not applicable/inactive regardless of its last sync timestamp. No source
was manually exempted and no source configuration was changed.

## Review-fix round 1 (G1-G4)

- G1: `safeText` uses core `redactString` for all page/search string fields,
  plus page-specific short API secrets, database URLs and JSON-encoded examples.
  Valid encoded string literals are re-encoded only if a credential was redacted.
  Redaction runs before truncating the 40,000-byte page window. Ordinary prose,
  slugs, numeric counters and credential-free URLs are negative controls.
- G2: search, page and scheduled graph traversal use core lane `lookup` (2
  running, 4 waiting). Scheduled probes stay on `gbrain`. `lane_busy` becomes
  HTTP 429 `{error:{code,message}}` with Retry-After; quarantine becomes 503.
  Cache staging is bounded. A new empty/failed result cannot evict last-good
  useful data; replacement of a good primary entry requires another useful
  result to have finished. Empty/failed entries are the first eviction targets.
- G3: actions use the app's shared core runner on `gbrain-action`, concurrency
  1, no waiting queue, including when the read service is overridden. The
  existing application lock excludes all concurrent actions. It releases when
  the core settles on verified exit, timeout or quarantine; the native lane
  remains closed on quarantine. Action quarantine is a central-contract 503.
  Shutdown uses the same runner's process-group TERM/KILL path. Fixed argument
  arrays, action IDs, R0/W1 classes, strict confirmation and definition timeouts
  are unchanged; constants.js and commandRunner.js have empty diffs.
- G4: an unreadable ledger throws `gbrain_timeline_unavailable`; absence alone
  establishes an empty history. A failed capture still refreshes the timeline
  source error via finally, and that error is a shared unavailable verdict
  reason. Timeline HTTP errors use the central 503 contract. Health/version
  tiles use the shared verdict; the static action catalog tile is inactive
  (readiness not probed). Legacy Operations state calls buildGBrainVerdict
  rather than implementing another decision rule.

`server/sources/usage/compatibility.js` is not GBrain-owned or test-only:
`server/routes/costs.js` imports it (line 3), calls parseMonthAnchor (line 16),
and re-exports its helpers. It was retained; no usage-area files were edited.

`tests/gbrainReviewFix.test.js` contains the finding counter-examples and
regression controls, including a 150-query flood, useful-cache retention, a
TERM-ignoring action, kill quarantine, shutdown and app runner binding. Original
finding triggers were seen failing before their fixes. Process behavior is
tested through injected children, not real GBrain actions. The separate author
bypass/regression pass also reproduced and closed JSON-encoded page secrets and
the failed-capture path. A new child review could not be dispatched: mloop
preflight returned NOT_INITIALIZED and the session has no participant binding.
The coordinator's independent review remains the external review channel.
