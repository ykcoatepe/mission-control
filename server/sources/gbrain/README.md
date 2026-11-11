# GBrain read sources

`gbrain.refresh` is registered with the core scheduler every 180 seconds. It
refreshes independent last-good sources with at most two readers at once. Every
CLI uses the shared core runner's `gbrain` lane, fixed argv, 45-second execution
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
callCount and reports connection unavailable. Source sync is separate evidence.
Behind and policy exclusion remain null unless explicitly reported by the
upstream; disabled sync is inactive, and is not evidence of policy exclusion.

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
16 are retained. Graph jobs use depth=1, direction=both; the runner bounds bytes
and time. `degree` is the number of incident edges in the returned subgraph,
not global degree. Unknown title/type are null. The `around` parameter is
required; no default neighbourhood is presented as a top-N global graph.

Suggested wording for **server/core/README.md**, intentionally not edited:

> Exception: explicit user-initiated GBrain search and page lookups may run
> read-only CLI commands through the shared gbrain lane with validated bounded
> inputs, single-flight and a short per-query TTL cache. Dashboard and graph
> GETs continue to compose scheduled memory snapshots and never write files.

Search/page caches retain at most 100 keys, expire after 15 seconds and preserve
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
