# First Operator Check

This tutorial walks through the first useful Mission Control check: start the
local console, inspect shared evidence for GBrain, Hermes, and OpenClaw, then
confirm the underlying work, automation, and usage surfaces.

## What you'll need

- Node.js 18 or newer.
- Dependencies installed at the repository root and in `frontend/`.
- A local OpenClaw or Hermes setup if you want live data instead of empty or unavailable states.
- Optional: `gbrain` on PATH for live GBrain probes.

## Step 1: Start Mission Control

From the repository root:

```bash
npm install
cd frontend
npm install
npm run build
cd ..
npm start
```

The server starts on `http://127.0.0.1:3333` unless `PORT` is set.

## Step 2: Open Brain

Open:

```text
http://127.0.0.1:3333/
```

Brain is the common read-first center for OpenClaw, Hermes, and GBrain. You
should see three independent system states, evidence freshness, the Decision
Inbox, an evidence timeline and drawer, and the existing safe GBrain triggers.
The first result appears as soon as `/api/operations/overview` responds.

Do not interpret an empty Decision Inbox as a global health average. Each
system keeps its own state and freshness. A `100/100` GBrain trust score still
shows active caveats and stale source warnings.

## Step 3: Verify the same data from the API

Run:

```bash
curl -s http://127.0.0.1:3333/api/operations/overview
```

Expected shape:

```json
{
  "ok": true,
  "schemaVersion": "1",
  "mode": "live-read-first",
  "overall": {},
  "systems": {
    "gbrain": {},
    "hermes": {},
    "openclaw": {}
  },
  "attention": [],
  "evidence": [],
  "capabilities": []
}
```

Use `/api/operations/overview` for this aggregate, not
`/api/gbrain/overview`. The Operations endpoint runs bounded read-only readers
and reports unavailable evidence explicitly. It must not expose raw messages,
task bodies, tokens, or absolute home paths.

The capability list contains exactly these eight ids:
`doctor-fast`, `preview-sync`, `sync-sources`, `retry-failed-sync`,
`embed-stale`, `embed-missing`, `check-resolvable`, and `storage-status`.
R0 diagnostics and previews run directly. W1 maintenance and repair require a
scoped confirmation. W2 actions are not rendered. `Run System Check` is the
Brain label for `doctor-fast`, not an extra action.

## Step 4: Inspect Hermes Kanban

Open:

```text
http://127.0.0.1:3333/work
```

The board shows `triage`, `todo`, `ready`, `running`, `blocked`, and `done` columns. If Hermes is not reachable, the API returns an empty board plus an error instead of crashing the page.

Check the backing endpoint:

```bash
curl -s http://127.0.0.1:3333/api/hermes-kanban
```

The response includes the active Hermes profile, column data, assignee totals, and summary counts.

## Step 5: Check cron and cost posture

Open:

```text
http://127.0.0.1:3333/automations
http://127.0.0.1:3333/usage
```

Cron should show both OpenClaw and Hermes jobs when available. Hermes jobs are editable for model and enabled state, but they are not runnable or deletable from Mission Control.

Costs should show OpenClaw and Hermes usage when both sources are available. If OpenClaw usage is slow or unavailable, Mission Control can preserve the last detailed OpenClaw data while still showing fresh Hermes usage.

## Step 6: Explore GBrain evidence

Open:

```text
http://127.0.0.1:3333/gbrain
```

Explore retains the detailed GBrain health, sources, memory, triggers, and
timeline surface. After an allowed action, completion is not yet repair proof:
Brain reports `verified` only after a refreshed Operations overview advances
GBrain `observedAt` and marks the evidence `fresh`.

Phase 2 source pages such as `/diagnostics`, `/workshop`, and `/calendar` remain
directly reachable but are intentionally hidden from primary navigation. Old
bookmarks such as `/kanban`, `/cron`, `/conversations`, `/costs`, and `/agents`
redirect to their new primary destinations.

## What you built

You started the local operator console and verified the new PR surfaces from both the browser and API:

- Brain shows independent GBrain, Hermes, and OpenClaw evidence and freshness.
- GBrain caveats and stale evidence remain visible even at `100/100` trust.
- Hermes Kanban cards are visible in Mission Control.
- Cron jobs show scheduler ownership and safe actions.
- Cost data keeps stale and unavailable source states explicit.
- Detailed GBrain exploration and the original eight triggers remain available.

For exact endpoint details, see [Operator Surfaces Reference](reference-operator-surfaces.md). For verification and troubleshooting commands, see [How to Verify Operator Surfaces](how-to-verify-operator-surfaces.md). After merging PRs, use [How to Update the Local Live Build](how-to-update-local-live-build.md) to rebuild and restart the running local app.
