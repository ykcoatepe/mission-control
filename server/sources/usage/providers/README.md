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
