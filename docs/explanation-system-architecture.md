# System Architecture

Mission Control is a local composition layer, not the system of record for the
AI stack. It reads from several independently owned runtimes, normalizes their
evidence, and exposes a small number of bounded write paths where the ownership
and confirmation policy are understood.

## Shape of the system

```text
React/Vite browser application
          |
          | same-origin JSON, SSE, and file responses
          v
Express composition root (`server.js`)
  |       |          |          |           |
  v       v          v          v           v
GBrain  Hermes   OpenClaw    Ollama     local files/SQLite
  |       |          |                      |
  +-------+----------+----------------------+
                  normalized readers
                         |
                 snapshots + provenance
                         |
              Brain / source-specific pages
```

Express serves the built SPA and mounts route modules from `server/routes/`.
Reusable source readers, normalization, caching, and persistence live in
`server/services/`. The frontend route registry is centralized in
`frontend/src/appRoutes.tsx`.

## Two levels of operator view

Brain (`/`) is the shared read-first summary. Its
`/api/operations/overview` payload keeps OpenClaw, Hermes, and GBrain state,
freshness, provenance, caveats, attention items, and evidence separate. It
derives the worst relevant condition instead of averaging three systems into a
false global green.

Explore (`/gbrain`) and the other source pages are detailed workbenches. They
retain source-specific data and controls that would overload Brain. This is why
hidden pages can remain directly reachable even when they are not primary
navigation destinations.

## Data acquisition and failure behavior

Readers use bounded CLI calls, local HTTP, JSON/JSONL files, SQLite, or cached
snapshots. A source failure is isolated so the rest of the overview can remain
useful. Normalized responses carry provenance and freshness; cached detail can
stay visible only when it is marked stale.

Examples:

- Operations readers have independent timeouts and preserve partial evidence.
- Usage merges OpenClaw, Hermes, Claude Code, and CodexBar-derived data. A slow
  source can refresh in the background while its last detailed result remains
  visible as stale. Tracked spend stays separate from `apiEquivalentUsd`, which
  estimates public API list price from input, cached-input, output, and cache-write
  token classes when the model has a known rate card.
- Runtime snapshots use atomic writes and TTLs.
- GBrain errors redact credentials and absolute home paths before reaching the
  browser.

## Write boundaries

Not every visible action has the same risk model:

- GBrain exposes exactly eight allowlisted actions. R0 diagnostics/previews run
  directly; W1 maintenance requires scoped confirmation; W2 is not rendered.
- Hermes Kanban accepts named actions and validates values before passing
  argument arrays to the CLI.
- Hermes cron jobs can be toggled and have their model changed, but cannot be
  run or deleted from Mission Control.
- Governance is archive-only by default; mutations require an explicit
  environment opt-in.
- Task execution is broader: it launches OpenClaw work in the configured
  workspace. Treat execute controls as real agent dispatch, not as a read-only
  preview.
- Hiding a session removes it from Mission Control's list; it does not close the
  underlying OpenClaw session.

Navigation and module flags are presentation controls. They are never part of
the authorization model.

## Local trust model

The server binds to `127.0.0.1` by default and accepts only localhost Host
values. Its mutation Origin filter uses a local-origin prefix check, so it is
defense in depth rather than exact origin validation. There is no user login or
network-grade authentication. That is appropriate for a private loopback
console, but it makes changing the bind host a security decision rather than a
cosmetic configuration change.

## Why the frontend is built before runtime QA

Express serves `frontend/dist`, so changing TypeScript does not change the live
app until the production bundle is rebuilt. Vite development mode is useful for
component work; deployment and integrated QA must exercise the Express-served
bundle and its same-origin APIs.

## Related

- [Read-Only Evidence Design](explanation-read-only-evidence-design.md)
- [Operator Surfaces Reference](reference-operator-surfaces.md)
- [Configuration and Runtime Reference](reference-configuration.md)
