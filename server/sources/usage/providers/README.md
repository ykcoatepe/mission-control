# Usage provider contract

A provider factory exports `createProvider(deps)` and returns:

```js
{
  id, label,
  async read({ since, until }) {
    return {
      days: [{ date, model, inputTokens, outputTokens,
        cacheReadTokens, cacheWriteTokens, billedUsd: null }],
      observedAt, coverage: 'complete', note,
    };
  },
}
```

Dates are inclusive local calendar dates (`YYYY-MM-DD`). Input excludes cache
reads; reasoning is already within output. Unknown billed spend is `null`;
estimates are computed separately, with unchanged comparison rates. Read errors
throw, and malformed observations are rejected before replacing last-good data.

Add one provider file here and one module-name line in `PROVIDER_MODULES` in
`../index.js`. Its lane is derived automatically; use that lane in core `exec.run`
with argv and a timeout. Registration automatically gives it a scheduler source,
per-provider atomic persistence, historical projections and summary membership.
Factories may supply `timeoutMs` and a non-secret producer `identity` for cache
binding. No route knows any platform-specific aggregation rules. The fake
provider registration and scheduler tests in `tests/costsRegistry.test.js`
exercise this extension seam.

Only scheduled refreshes read upstreams and write `data/usage/<id>.json`.
A successful empty scan is distinct from failure. Restored snapshots remain
stale until observed again. If a day has not been scanned yet (including the
first request after midnight), its totals stay unknown rather than zero.

API-equivalent and token aggregates sum finite known provider figures. Unknown
providers retain null numbers and appear in `missingProviders: [{id,label,reason}]`;
known partial figures remain included and retain their coverage flag. An observed empty reading is
known zero. With no known reading the aggregate is null. Billed spend remains
unknown unless every participating bill is known. Hermes uses the same unchanged
public rate cards (including the generic comparison tier); model estimates carry
`apiEquivalentEstimated` and `apiEquivalentStatus` separately from billed USD.

The legacy `/api/costs/codexbar` `stale` flag means an actual failed CodexBar
invocation is being served from its last successful scan. Partial coverage,
expired provider readings and another provider's failures do not set that flag.
`codexbarScan` records invocation state, source and attempt/success timestamps;
`lastGoodScanAgeMs` and `scanErrorClass` are separate. Scanner diagnostics survive
an identity-bound cache reload; command output and error text never enter them.

Ownership candidates are intrinsic source metadata:
`ownership: [{owner,date,model,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,billedUsd,latestUsageAt?}]`.
They must be a subset of `days`. An ownership-bearing observation is stored as
partial with `coverageReasons: ['ownership_pending']`; other producer coverage
reasons are preserved. `ownership.js` resolves from current snapshots, including
owner freshness, completeness, matching date/model counts and observation time.
An unresolved candidate remains visible with a typed reason; it is never cached
as an authoritative complete composition. Counts are not altered in source caches.

Claude/Codex indexes use path identity, size, mtime, inode, complete-line byte
offset and hashed append anchors. Only changed/new files read source bytes;
append-only files resume at the committed offset. Truncation, rotation or changed
anchors rebuild the file. Corrupt manifests/count files are ignored and rebuilt.
Count records are externally sorted and merged with fixed batches/fan-in, so
neither full transcripts nor an unbounded request-ID map is held in memory.
See `../PERFORMANCE.md` for measured cold/recurring CPU, RSS and tradeoffs.
