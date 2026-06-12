# How to Verify Operator Surfaces

Use this guide to verify the GBrain, Hermes Kanban, cron, costs, and supply-chain surfaces after a change.

## Prerequisites

- Run from the repository root.
- Install root and frontend dependencies if you need a build.
- Start Mission Control with `npm start` before using `curl` against local endpoints.
- If you just merged PRs, first update and rebuild the running local app with
  [How to Update the Local Live Build](how-to-update-local-live-build.md).
- Optional live tools: `gbrain`, `hermes`, `openclaw`, `sqlite3`, and local Ollama.

## Steps

1. Run the backend test suite.

   ```bash
   npm test
   ```

   This runs every file in `tests/` via `node --test` — GBrain normalization,
   cost sanity, cron data, OpenClaw usage parsing, and the supply-chain
   advisory parser. To iterate on a single area, run one file directly:

   ```bash
   node --test tests/gbrainOverview.test.js
   ```

2. Lint and type-check the frontend if your change touches it.

   ```bash
   cd frontend
   npm run lint
   cd ..
   ```

3. Build the frontend.

   ```bash
   cd frontend
   npm run build
   cd ..
   ```

4. Start the server.

   ```bash
   npm start
   ```

   The server listens on `127.0.0.1:3333` by default. Set `PORT` to run a
   second local copy:

   ```bash
   PORT=3499 npm start
   ```

   Set the base URL for the instance you are verifying:

   ```bash
   export MC_BASE_URL=http://127.0.0.1:3333
   # or, when verifying the second local copy:
   export MC_BASE_URL=http://127.0.0.1:3499
   ```

5. Verify the server health endpoint.

   ```bash
   curl -fsS "$MC_BASE_URL/api/health"
   ```

   Expected shape:

   ```json
   {"ok":true,"status":"ok","service":"mission-control","generatedAt":"..."}
   ```

6. Verify GBrain endpoints.

   ```bash
   curl -s "$MC_BASE_URL/api/gbrain/overview"
   curl -s "$MC_BASE_URL/api/gbrain/health"
   curl -s "$MC_BASE_URL/api/gbrain/sources"
   ```

   Confirm that errors are redacted and that absolute home paths are not returned in live failure messages.

7. Verify Hermes Kanban endpoints.

   ```bash
   curl -s "$MC_BASE_URL/api/hermes-kanban"
   ```

   If the board has a task id, inspect its detail:

   ```bash
   curl -s "$MC_BASE_URL/api/hermes-kanban/tasks/TASK_ID"
   ```

8. Verify cron endpoints.

   ```bash
   curl -s "$MC_BASE_URL/api/cron"
   ```

   Check that each job has `scheduler`, `schedulerLabel`, `sourceId`, and `actions`. Hermes jobs should have `run: false`, `delete: false`, `toggle: true`, and `model: true`.

9. Verify cost endpoint behavior.

   ```bash
   curl -s "$MC_BASE_URL/api/costs?period=7d"
   ```

   Check the `meta` object. It should make source availability visible with fields such as `openclawStatus`, `hermesStatus`, `stale`, and `refreshing`.

10. Verify the Diagnostics route and legacy redirects.

   ```bash
   curl -Ls "$MC_BASE_URL/diagnostics" | head
   ```

   This confirms the SPA fallback serves the Diagnostics route. In the browser,
   `/diagnostics` should show Memory, Docs, Scout, AWS, and Skills as tabs when
   those modules are enabled. `/memory`, `/scout`, `/aws`, and `/skills` should
   redirect into the matching diagnostics tab after React Router loads.

11. Verify the supply-chain gate.

   ```bash
   node scripts/check-npm-supply-chain.mjs
   ```

   This command fetches the configured advisory and fails closed if it cannot parse npm indicators of compromise. Use it when network access is available.

## Verification

The minimum local verification before pushing is:

```bash
npm test
git diff --check
```

CI repeats these on every PR (`.github/workflows/ci.yml` runs the backend
suite plus frontend lint and build; `supply-chain.yml` runs the advisory
gate). Use the frontend build and local `curl` checks when the change affects
browser behavior or live runtime data.

## Troubleshooting

If `/api/gbrain/health` returns `ok: false`, verify that `gbrain` is on PATH and that local database connectivity works:

```bash
gbrain health --json
gbrain jobs stats --json
```

If `/api/hermes-kanban` returns an empty board with an error, verify the Hermes profile and binary:

```bash
HERMES_PROFILE=hmudur hermes --profile hmudur kanban list --status ready --json
```

If `/api/cron` does not show Hermes jobs, inspect the Hermes profile cron file for the active profile. Mission Control reads Hermes jobs from the local profile state and maps them into the same API shape as OpenClaw jobs.

If costs show stale OpenClaw data, that is intentional when the detailed OpenClaw usage command is slow or unavailable. The response should mark `stale: true` and preserve previous detailed OpenClaw data while continuing to use fresh Hermes data when possible.

If the supply-chain gate fails with no parsed indicators, check `NPM_INCIDENT_ADVISORY_URL`. The gate fails closed because an empty advisory parse is not useful evidence.
