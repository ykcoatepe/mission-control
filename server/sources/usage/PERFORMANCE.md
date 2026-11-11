# Usage review-fix measurements — 2026-11-11

Upstreams were read-only; measurements emitted counts and resource usage only.
The workload window was 2024-10-01 through 2026-11-11 on the same local homes.
Claude's eligible corpus was 2,970 files / 4,917,605,223 bytes. Codex's was
85–86 files / approximately 1,277,508,840 bytes. These are the actually observed
eligible corpora, rather than the earlier review's approximate corpus sizes.
They were active logs: appends and a new Codex session occurred between runs,
so this is a resource comparison, not a claim of byte-identical output totals.
Correctness/conservation is checked with controlled fixtures and unchanged-file
replays in `tests/costsIncrementalReaders.test.js`.

| Reader | Before: full scan CPU / peak RSS | Initial incremental index CPU / peak RSS | Recurring incremental refresh CPU / peak RSS |
| --- | --- | --- | --- |
| Claude Code | 12.182 s / 289.31 MiB | 22.013 s / 276.00 MiB | 3.009 s / 155.00 MiB |
| Codex | 2.974 s / 269.88 MiB | 2.561 s / 216.95 MiB | 0.201 s / 69.17 MiB |

CPU is process user+system time (`process.cpuUsage`); peak RSS is the process
high-water mark (`process.resourceUsage().maxRSS`). Cold indexing has a real
one-time CPU/write cost, especially for Claude. The recurring measurements
include cache validation, count aggregation, and any appends during the run.
Before measurements used the prior readers without caches. After measurements
use the production 96 MiB V8 old-generation budget; this is **not** a kernel RSS
limit. Raw line buffering is capped at 1 MiB, sorting batches at 1,024 count
records, merge fan-in at 24, and file metadata at the configured 20,000-file
budget. Directory enumeration is streamed. No message contents enter caches.

Readers now run every five minutes, with a fifteen-minute stale threshold.
Other providers retain their independent one-minute schedules. A newly written
file is checked on the next scheduled refresh; GET requests do not trigger I/O.

Reproduce after installing this change (first run indexes, second run measures
recurring work; upstream logs remain read-only):

```sh
node --max-old-space-size=96 server/sources/usage/benchmark.js claude 2024-10-01 2026-11-11 "$PWD/data/usage/u2-benchmark/claude-bounded"
node --max-old-space-size=96 server/sources/usage/benchmark.js codex 2024-10-01 2026-11-11 "$PWD/data/usage/u2-benchmark/codex-bounded"
```

## Producer/consumer review matrix

- Claude Code: incremental per-file request-count records; stable hashed request
  identity; earliest observed day and maximum streaming counts. No ownership
  dependency on another provider.
- Codex: incremental per-file context and usage records; intrinsic counts retain
  explicit Hermes ownership candidates. No Hermes snapshot is read by a producer.
- Hermes: read-only database aggregation counts NULL-token rows separately and
  labels known subtotals partial. Its observation timestamp precedes the query.
- OpenClaw: retains its bounded native scan; it is outside U2's two large-reader
  finding and has no Hermes ownership exclusion.
- Registry cache: persists intrinsic observations and ownership candidates;
  ownership-bearing Codex data is partial on disk. Old Codex cache identities
  are invalidated. Incremental index publication and count files are atomic.
- Costs, summary, months, CodexBar projections and Signals' summary consumer:
  consume the same pure composition of current source snapshots. Fresh, complete
  matching owner counts can remove a candidate; absent, stale, partial or older
  owner observations leave a typed unresolved overlap and partial totals.

The independent reviewer's delta recheck and deployment are coordinator gates;
these measurements and tests do not establish production activation.
