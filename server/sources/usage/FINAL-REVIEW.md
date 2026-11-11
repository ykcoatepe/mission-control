# Usage final review fix

N1: Ownership is composed against shared owner capacity banks. Stable hashed
Codex rollout identities come from Codex session metadata and the specific
Hermes `model_config.codex_thread_id` field; full configuration is never returned.
When an identity is unavailable, the fallback checks the Hermes start day and
its following calendar day. An identified different session cannot supply that
credit. A bank is consumed once across all candidates, and source caches remain
intrinsic observations. Unresolved dates are separate from intrinsic coverage;
costs, daily rows, summary windows and metadata filter them to their own window.

N6: The private per-reader cache has a 256 MiB byte-admission budget, including
scratch files, normalized records, the old manifest and its atomic replacement.
The observed stored Claude cache was 40,129,689 bytes and Codex 2,969,386 bytes;
the default leaves headroom for sorting and atomic replacement. This is logical
file-byte accounting under the existing single-writer source/lane contract, not
a kernel disk quota. Capacity failure preserves the prior index and raises
`usage_cache_capacity`; it never invents an empty usage result. A pre-existing
oversized directory cannot grow further until eligible cleanup frees space.

Startup cleanup removes only exact reserved scratch/temp filenames owned by dead
processes, or unreferenced normalized count files, after a one-hour grace period.
Referenced files, recent artifacts, live producer scratch, foreign files and
symlinks are preserved. Resolved filesystem paths keep cleanup inside data/usage.
Ordinary failed scans also remove their unpublished files in `finally`; killed
scans are recovered by the age-bounded startup cleanup.

Compatibility: the actual dependency was `server/sources/usage/compatibility.js`,
not the GBrain path in the finding. Costs now inlines only month validation and
reads the memory service. The other author removed the legacy file concurrently.
There are no remaining server or test imports of it. Active calendar projections
use a small adapter over the existing calendar-key implementation. Calendar
boundary assertions are retained; runtime source/window tests replace tests of
unused reconstruction/queue helpers.

Counter-examples and producer seam: `tests/costsFinalReview.test.js`.
Runtime period/last-good behavior: `tests/costsRuntimePeriods.test.js`.
No production deployment or independent delta acceptance is implied by this fix.
