# Usage browser-QA contract additions

Existing payload fields remain. Empty observed windows still contribute zero
tokens and zero API-equivalent usage, which is a token-price estimate, not a
bill. An empty set of billing records now gives `billedUsd: null`, including
daily, period, previous-period and summary aggregates. A recorded numeric zero
bill remains zero. A mixture containing unknown billing remains unknown.

Public additions:

| Payload path | Meaning |
| --- | --- |
| costs `providers[].billingKnown` | Boolean: every selected record has explicit numeric billing, and at least one record exists. Does not imply freshness. |
| costs `providers[].hasRecords` | Boolean: selected usage rows exist, including a recorded zero-token or cost-only row. False alone does not establish the provider was read; keep checking `state`. |
| summary `data.providers[].billingKnown`, `.hasRecords` | The same flags for that provider's current-month window. |
| summary `data.today`, `.week`, `.month`: `billingKnown`, `hasRecords` | Aggregate billing is known only if all participating providers have known bills; hasRecords is true if any selected row exists. |
| costs `period.previousStart`, `.previousEnd` | Inclusive local calendar dates actually used for comparison totals. No change to the existing comparison window calculation. |
| costs `period.previousIsPartial` | Boolean: comparison evidence is incomplete, or a monthly comparison ends before the last day of its calendar month. Live month comparisons can be clipped; anchored past months use full calendar months. |
| costs `providers[].coverageReason` | `standing_gaps`, `scan_failed`, `unresolved_overlap`, `unread`, or `none`. This is diagnostic classification, not a new state ranking. A fresh successful scan with parsing gaps is not a failed scan. Stale age alone does not assert a failed scan. |
| costs `providers[].skippedLines`, `.oversizedLines` | Nonnegative scan counters, or null when the producer has not supplied them. Skipped includes oversized lines. Counters cover the producer's retained history scan, not just the selected UI window. Current incomplete tails are counted once and removed when repaired. |
| costs `byService[].isLocal`, `agents[].byService[].isLocal` | Boolean only from explicit record metadata, otherwise null; mixed or incomplete model metadata stays null. Model/provider names do not establish locality. |

Producer matrix: Claude Code and Codex supply persisted line counters, including
unchanged-file reuse, append offsets and rotation. Hermes derives a local flag
inside SQLite from recorded `billing_base_url` metadata for strict HTTP(S)
loopback authorities (localhost, 127.0.0.1, ::1); other endpoints remain unknown.
No URL or full configuration leaves the query. OpenClaw and CodexBar do not
supply those counters/locality: null is retained. All providers pass the same
whitelist/validation boundary; malformed observations cannot replace last-good.
Legacy manifests without counters are rescanned once to establish them.

Consumer sweep: Costs/ProvidersPanel and its client utilities, the status-bar
summary, and OllamaMonitor continue receiving all existing fields. No frontend
files changed. `tests/costsQaContracts.test.js` covers the producer/contract/
composition/HTTP seam with injected exec, clocks and temporary files. Its SQL
privacy check replaces the old source regex that banned mentioning the endpoint
column: only a derived boolean may now cross that boundary. The optional built-in
SQLite check runs on Node >=22; portable fake-producer tests also run on Node 20.
