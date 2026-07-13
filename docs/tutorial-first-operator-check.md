# First Operator Check

This tutorial teaches the current Mission Control workflow: begin with shared
attention on Brain, inspect its proof, move to the owning source surface, and
confirm that refreshed evidence changed the state.

## Before you begin

You need Node.js 20.19+ in the Node 20 line or Node.js 22.12+, installed
root/frontend dependencies, and a built frontend. OpenClaw, Hermes, and GBrain
are optional for starting the app but are needed for live evidence from their
respective systems.

```bash
npm install
npm --prefix frontend install
cp -n mc-config.default.json mc-config.json
npm run build
npm start
```

Open `http://127.0.0.1:3333`.

## 1. Read Brain before opening a source tool

Brain shows OpenClaw, Hermes, and GBrain independently. Look at each system's
state, freshness, observed time, and caveats, then scan the Decision Inbox.

Do not treat an empty inbox as proof that every system is healthy. Likewise, a
GBrain trust score of `100/100` does not hide missing embeddings, stale sources,
or other caveats.

Confirm the same contract from the API:

```bash
curl -fsS http://127.0.0.1:3333/api/operations/overview | jq \
  '{schemaVersion,mode,systems,attention,evidenceCount:(.evidence|length)}'
```

You should see schema version `1`, mode `live-read-first`, and separate
`openclaw`, `hermes`, and `gbrain` system objects. An unavailable integration is
a valid result when its provenance and failure state are explicit.

## 2. Follow one attention item to its evidence

Select an attention item, then open its evidence drawer. Compare:

- source and provenance;
- observed time and freshness;
- caveat or recommendation;
- the detailed source destination.

Use the source destination rather than guessing from the aggregate:

- Hermes work: `http://127.0.0.1:3333/work`
- OpenClaw/Hermes schedules: `http://127.0.0.1:3333/automations`
- GBrain detail: `http://127.0.0.1:3333/gbrain`
- sessions: `http://127.0.0.1:3333/sessions`
- usage: `http://127.0.0.1:3333/usage`
- agent/runtime inventory: `http://127.0.0.1:3333/systems`

The specialized page carries more source-specific context than Brain.

## 3. Learn the safe action model

Brain and Explore expose the same eight allowlisted GBrain actions. Try an R0
diagnostic such as **Run System Check** (`doctor-fast`) or a preview action.
R0 runs without a confirmation dialog because it does not repair data.

W1 actions such as source sync or embedding repair require confirmation scoped
to that exact action. Cancel the dialog during a first walkthrough. W2 actions
are not rendered.

An action finishing is not proof that the underlying condition changed. The UI
keeps the result in a verifying state until a newer Operations response carries
fresh GBrain evidence.

## 4. Check work, automation, and usage ownership

Open `/work`. The Hermes board uses `triage`, `todo`, `ready`, `running`,
`blocked`, and `done` columns. If Hermes is unavailable, the page should keep an
explicit empty/error state instead of failing the whole app.

Open `/automations`. Each job identifies its scheduler. OpenClaw jobs support
the full set of configured controls. Hermes jobs can be toggled and have their
model changed, but cannot be run or deleted here.

Open `/usage`. The page combines OpenClaw, Hermes, Claude Code, and CodexBar
evidence. Read the source reliability metadata alongside totals: preserved
stale detail is useful history, not current proof and not zero usage.
`Included` is tracked subscription/local spend, while `API equivalent` is the
separate public-list-price estimate for the same model usage. Local models and
unpriced routing aliases report the comparison as not applicable or unavailable.

## 5. Recognize secondary surfaces

Settings and Governance Archive are utility destinations. `/workshop`,
`/calendar`, `/office`, `/team`, `/ollama`, `/setup`, and `/diagnostics` are
reachable directly but intentionally absent from primary navigation. A module
flag may hide a navigation item or Diagnostics tab; it does not block the URL.

Old bookmarks continue to redirect, including `/kanban`, `/cron`,
`/conversations`, `/costs`, and `/agents`.

## What you verified

You used the current operator loop:

1. begin with independent state and freshness on Brain;
2. inspect provenance-bearing evidence;
3. move to the owning source surface;
4. distinguish preview, confirmed maintenance, and broader dispatch actions;
5. wait for newer proof before calling an outcome verified.

For exact routes and endpoints, use the
[Operator Surfaces Reference](reference-operator-surfaces.md). For a release or
PR check, follow [How to Verify Operator Surfaces](how-to-verify-operator-surfaces.md).
