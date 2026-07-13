# Mission Control documentation

This is the entry point for current Mission Control documentation. Product and
runtime behavior is documented here; dated handoffs, specifications, and plans
are design history rather than current operating instructions.

## Tutorial

- [First operator check](tutorial-first-operator-check.md) — start the console,
  follow attention from Brain to source evidence, and verify the result.

## How-to guides

- [Verify operator surfaces](how-to-verify-operator-surfaces.md) — run focused
  tests, API smokes, route checks, and served-build verification.
- [Update the local live build](how-to-update-local-live-build.md) — safely
  update and restart the instance on this workstation.

## Reference

- [Operator surfaces](reference-operator-surfaces.md) — route registry, API
  families, action classes, and safety boundaries.
- [Configuration and runtime](reference-configuration.md) — config fields,
  environment variables, local data, and optional dependencies.
- [Frontend conventions](reference-frontend-conventions.md) — route metadata,
  data access, CSS, component organization, and lint/test rules.

## Explanation

- [System architecture](explanation-system-architecture.md) — composition,
  data flow, source ownership, and failure behavior.
- [Read-only evidence design](explanation-read-only-evidence-design.md) — why
  state, freshness, provenance, and action safety remain separate.

## Design history

These records explain how the current product was shaped. They may contain old
route names, snapshots, branch names, or unfinished checklists and must not be
used as runtime reference:

- [GBrain hybrid Brain handoff (2026-05-24)](gbrain-hybrid-brain-view-handoff-20260524.md)
- [Shared Brain rehaul design (2026-07-10)](superpowers/specs/2026-07-10-mission-control-shared-brain-rehaul-design.md)
- [Shared Brain implementation plan (2026-07-10)](superpowers/plans/2026-07-10-mission-control-shared-brain-core.md)

The [root README](../README.md) remains the installation and repository entry
point. When a current contract changes, update the relevant reference page and
link to it instead of duplicating the full table elsewhere.
