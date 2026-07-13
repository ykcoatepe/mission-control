# Read-Only Evidence Design

Mission Control is an operator console. Its first responsibility is to show
what is known, where that proof came from, how fresh it is, and which action is
safe next—not to make every local system look healthy.

## Why evidence needs more than a status color

The console reads several independently owned systems. Any one of them can be
slow, unavailable, partially configured, or able to return cached data:

- GBrain can be installed while its database is unreachable.
- Hermes can be absent while OpenClaw remains healthy.
- detailed usage collection can time out after faster summary data exists;
- a local cache can preserve useful detail after the source stops responding;
- a command can finish without repairing the condition it targeted.

Collapsing those cases into green/red or replacing missing data with zero would
turn absence of proof into misleading proof.

## The evidence contract

```text
source command, HTTP service, file, or database
                    |
                    v
          bounded source-specific reader
                    |
                    v
 normalized value + provenance + observed time + caveats
                    |
                    v
      current, stale, warning, or unavailable UI state
```

Brain preserves separate state, freshness, and caveats for OpenClaw, Hermes,
and GBrain. Its aggregate reports the worst relevant condition rather than an
average. A `100/100` trust score therefore does not erase a missing-embedding
warning, and a stale cached usage result does not become current merely because
it is detailed.

## Partial truth is useful when labeled

Mission Control isolates reader failures so one unavailable source does not
erase the rest of the console. Cached snapshots and usage detail may remain
visible, but their metadata must say that they are stale or refreshing.

This creates more yellow states than an optimistic dashboard. That is
intentional: a degraded result with provenance is more actionable than a green
card based on fabricated defaults.

## Observation and mutation are separate contracts

Read models do not automatically justify control-plane access. The product uses
different boundaries according to what is understood and testable:

- GBrain R0 diagnostics and previews are direct; W1 repair requires exact
  confirmation; W2 is absent.
- Hermes Kanban and cron expose only named, validated actions. Hermes cron
  run/delete remains disabled even though the source system may support it.
- Governance stays archive-only unless explicitly enabled.
- Task execution and OpenClaw self-heal are broader mutations and should never
  be used as health probes.

An action response proves completion of the invocation, not the desired
outcome. GBrain results remain in a verifying state until a later read carries
newer, fresh evidence.

## Caveats and trade-offs

- Some GET task endpoints reconcile and persist task state, so method name alone
  is not a sufficient definition of read-only behavior.
- Saved detail can outlive its source. Every consumer must preserve stale
  metadata rather than copying values without provenance.
- Navigation visibility is not security. Hidden routes and module flags remain
  directly reachable.
- The loopback-only server model is part of the safety design because the app
  has no application authentication.

## Related

- [System Architecture](explanation-system-architecture.md)
- [Operator Surfaces Reference](reference-operator-surfaces.md)
- [How to Verify Operator Surfaces](how-to-verify-operator-surfaces.md)
