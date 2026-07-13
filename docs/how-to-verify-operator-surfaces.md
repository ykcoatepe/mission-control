# How to Verify Operator Surfaces

Use this runbook after backend, frontend, route, integration, or documentation
changes. It separates repository checks from live-runtime proof.

## 1. Run repository checks

From the repository root:

```bash
npm test
npm --prefix frontend run lint
npm --prefix frontend test
npm --prefix frontend run build
git diff --check
```

The same core checks run in CI: the backend Node suite, frontend ESLint,
frontend Vitest, and the type-checked Vite production build.

For a focused shared-Brain pass:

```bash
node --test \
  tests/operationsOverview.test.js \
  tests/operationsRoute.test.js \
  tests/gbrainOverview.test.js \
  tests/hermesKanbanData.test.js \
  tests/cronData.test.js \
  tests/cronRoute.test.js

npm --prefix frontend test -- \
  src/appRoutes.test.ts \
  src/pages/brain/lib.test.ts \
  src/pages/brain/components.test.ts
```

## 2. Start the production surface

Build first because Express serves `frontend/dist`:

```bash
npm run build
```

Then choose one start command and keep that first terminal running:

```bash
# default instance
npm start

# or an isolated instance
PORT=3499 npm start
```

Open a second terminal at the repository root for the remaining checks. Point
it at the instance you started:

```bash
# isolated instance
export MC_BASE_URL=http://127.0.0.1:3499

# or the default instance
export MC_BASE_URL=http://127.0.0.1:3333
```

## 3. Verify health and the shared read model

```bash
curl -fsS "$MC_BASE_URL/api/health"
curl -fsS "$MC_BASE_URL/api/operations/overview" | jq \
  '{schemaVersion,mode,overall,systems,
    attentionCount:(.attention|length),
    evidenceCount:(.evidence|length),
    capabilities:(.capabilities|map({id,safetyClass,requiresConfirmation}))}'
```

Confirm:

- health reports `ok: true`;
- Operations schema is `"1"` and mode is `live-read-first`;
- OpenClaw, Hermes, and GBrain are present independently;
- exactly eight allowlisted GBrain capabilities are present;
- stale state and caveats remain visible even when another score is healthy;
- responses do not contain tokens, raw messages/task bodies, or absolute home
  paths.

## 4. Verify source readers

These calls are read-oriented and safe for a normal smoke:

```bash
curl -fsS "$MC_BASE_URL/api/gbrain/overview" | jq '{ok,live,trust,caveats}'
curl -fsS "$MC_BASE_URL/api/gbrain/timeline?limit=20" | jq \
  '{count:(.entries|length),retainedEntryCount,truncated,warnings}'
curl -fsS "$MC_BASE_URL/api/hermes-kanban" | jq '{profile,summary,error}'
curl -fsS "$MC_BASE_URL/api/cron" | jq '{count:(.jobs|length),error}'
curl -fsS "$MC_BASE_URL/api/costs?period=7d" | jq \
  '{period,summary,meta,agents:(.agents|map({key,source,status,trackedUsd:.summary.periodUsd,apiEquivalentUsd:.summary.periodApiEquivalentUsd}))}'
if codexbar_payload=$(curl -fsS "$MC_BASE_URL/api/costs/codexbar"); then
  printf '%s\n' "$codexbar_payload" | jq \
    '{source,provider,updatedAt,totals,dailyCount:(.daily|length)}'
else
  echo "SKIP: optional CodexBar data is unavailable"
fi
```

Payload shapes can be partial when a local dependency is absent. Cron jobs
should identify scheduler ownership; Hermes job actions must keep `run` and
`delete` disabled while allowing `toggle` and `model`. Usage metadata should
expose OpenClaw, Hermes, and Claude Code source status plus `stale` and
`refreshing` state. The direct CodexBar route returns HTTP 500 when its optional
CLI is missing, its command fails, or no Codex/Claude reports exist. The guarded
request treats any of those non-success responses as an optional skip instead
of failing the entire smoke.

For subscription-backed sources, `periodUsd` remains zero and services report
`costStatus: included`. Their comparison value lives in
`periodApiEquivalentUsd` and per-model `apiEquivalentUsd`; local or unpriced
models may explicitly return `not_applicable` or `unavailable` instead of a
fabricated dollar value.

Do not call mutation endpoints during this read smoke. Some GET task endpoints
perform reconciliation and may persist normalized task state, so omit them when
you require a strictly read-only filesystem check.

## 5. Verify routes and the served build

```bash
for route in / /work /automations /sessions /gbrain /usage /systems \
  /settings /councils /setup /workshop /calendar /office /team /ollama /diagnostics
do
  curl -fsS -o /dev/null "$MC_BASE_URL$route" || exit 1
done
```

An HTTP 200 only proves the SPA fallback returned `index.html`. Open the app in
a browser and confirm:

- exactly seven primary destinations, in the documented order;
- Settings and Audit/Governance as utility destinations;
- no unexpected console errors;
- the page content renders rather than remaining in a loading shell;
- the UI behavior matches the API response you just inspected.

When verifying a deployment, check that the served asset names match the
current `frontend/dist/index.html`:

```bash
curl -fsS "$MC_BASE_URL/" | sed -n 's/.*src="\([^"]*assets\/[^"]*\.js\)".*/\1/p'
sed -n 's/.*src="\([^"]*assets\/[^"]*\.js\)".*/\1/p' frontend/dist/index.html
```

## 6. Verify safety boundaries when relevant

- GBrain R0 actions run directly; W1 requires `confirmed: true`; unknown names
  are rejected. Use tests for these checks unless you intend the local action.
- Governance actions return `410` unless
  `MISSION_CONTROL_ENABLE_COUNCIL_ACTIONS=1`.
- Hermes run/delete controls remain disabled in the API contract.
- Task execute, agent creation/model changes, self-heal, quick actions, uploads,
  and settings import are real mutations. Do not use them as probes.
- `DELETE /api/sessions/:key/close` hides a row locally; it does not close the
  OpenClaw session.

## 7. Verify supply-chain checks when network is available

```bash
node scripts/check-npm-supply-chain.mjs
```

The checker fails closed if the configured advisory cannot produce parseable
npm indicators. The separate workflow also protects lockfiles and registry
signatures.

## Troubleshooting

- If localhost requests fail only inside a sandbox, retry from a normal local
  terminal before diagnosing the service.
- If GBrain is unavailable, run its supported health/version commands directly
  and verify database connectivity.
- If Hermes data is empty, confirm the selected `HERMES_PROFILE` and its local
  state/cron files.
- If Usage is stale, inspect source status before treating totals as zero.
- If APIs are current but the UI is old, rebuild `frontend/dist` and restart
  Express.

See [Configuration and Runtime Reference](reference-configuration.md) for
variables and local paths, and [How to Update the Local Live Build](how-to-update-local-live-build.md)
for the workstation deployment procedure.
