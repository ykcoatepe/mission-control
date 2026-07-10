# Mission Control Shared Brain Rehaul Design

Date: 2026-07-10  
Status: approved design direction; written specification awaiting user review  
Implementation focus: Phase 1, Shared Brain Core

## Summary

Mission Control will become a shared knowledge and decision center for GBrain,
Hermes, and OpenClaw. GBrain is the common evidence and memory spine. Hermes and
OpenClaw remain independent execution systems whose current state, work, and
proof are surfaced through Mission Control.

The new home screen is a Brain Map rather than an OpenClaw-centric heartbeat
dashboard. It answers four questions in order:

1. What does the shared brain currently know?
2. Which source system supports that conclusion?
3. What evidence is stale, conflicting, or missing?
4. Which safe action, if any, should the operator take next?

The product is read-first. Diagnostic GBrain actions remain directly available.
GBrain actions that change shared memory require a proof summary and explicit
confirmation. Destructive or externally visible actions stay outside the home
screen.

## Current-state evidence

The current application has fifteen first-level sidebar entries grouped by
screen type rather than operator intent. The live home screen is dominated by
OpenClaw heartbeat, session, and old governance activity. GBrain and Hermes are
functional but isolated on separate pages.

The live review on 2026-07-10 found:

- GBrain reported `Live trusted`, trust `100/100`, fresh sources, complete
  embeddings, and no active caveats.
- Hermes Kanban reported two active tasks, one running task, and no blockers.
- The home screen simultaneously showed a stale or absent heartbeat and
  conflicting session summaries.
- The sidebar exposed fifteen primary destinations, including several surfaces
  that overlap in purpose.

The backend already has strong specialized sources:

- OpenClaw status, sessions, agents, channels, cron, and costs.
- Hermes Kanban, workers, profile cron, costs, proxy, and GBrain integration
  contract evidence.
- GBrain health, sources, freshness, embeddings, topology, integration proof,
  and allowlisted operator actions.

What is missing is a single evidence contract that preserves source identity,
observation time, freshness, caveats, and conflicts.

## Goals

- Make the Brain Map the primary Mission Control experience.
- Treat GBrain as shared memory and evidence, not as the owner of Hermes or
  OpenClaw local state.
- Reduce primary navigation from fifteen entries to seven.
- Add a Decision Inbox that prioritizes evidence gaps, contradictions, and
  decisions that need operator attention.
- Add a cross-system Evidence Timeline.
- Preserve all useful GBrain triggers and improve their safety, context, and
  confirmation flow.
- Normalize GBrain, Hermes, and OpenClaw evidence without flattening caveats or
  stale data into a misleading global green state.
- Preserve specialized pages and existing capabilities while route
  consolidation is completed in later phases.
- Deliver a calm, precise visual system suitable for long operator sessions.

## Non-goals for Phase 1

- Rebuilding every specialized page.
- Combining the internal storage systems of GBrain, Hermes, and OpenClaw.
- Moving raw transcripts, credentials, or private configuration into GBrain.
- Running destructive actions, sending external messages, closing sessions, or
  deleting cron jobs from the Brain Map.
- Replacing the existing Hermes Kanban data model.
- Implementing a fully event-sourced control plane.
- Removing legacy routes before compatible replacements exist.

## Program decomposition

### Phase 1: Shared Brain Core

Phase 1 delivers the common evidence contract, Brain Map home screen, Decision
Inbox, Evidence Timeline, Quiet Observatory visual language, seven-item
navigation, and the preserved GBrain trigger shelf.

### Phase 2: Surface consolidation

Phase 2 combines overlapping product areas:

- Workshop and Hermes Kanban become Work.
- Cron and Calendar become Automations with list and schedule views.
- Digital Office, Agent Hub, Team Structure, and Ollama become Systems.
- Conversations becomes Sessions.
- Costs becomes Usage and gains explicit GBrain workload attribution where
  source data supports it.

### Phase 3: Cleanup and migration

Phase 3 removes obsolete standalone shells after their useful capabilities have
moved, rewrites Setup for all three systems, completes legacy redirects, updates
operator documentation, and performs full visual and responsive QA.

## Phase 1 information architecture

The primary sidebar contains seven destinations:

| Destination | Phase 1 behavior | Long-term role |
| --- | --- | --- |
| Brain | New Brain Map home at `/` | Shared state, decisions, evidence, triggers |
| Work | Existing Hermes Kanban mounted under the new IA | Unified Hermes and OpenClaw work |
| Automations | Existing Cron surface mounted under the new IA | Cron list and calendar schedule |
| Sessions | Existing Conversations surface under a stable name | Cross-system sessions and handoffs |
| Explore | Existing GBrain cockpit and search capabilities | Health, search, sources, triggers, timeline |
| Usage | Existing Costs surface under a stable name | Spend, model mix, workload attribution |
| Systems | Existing live agent/system inventory as the starting view | Agents, roles, models, integrations |

Settings and Governance Archive move to the sidebar utility area. Setup remains
conditional. Existing route paths remain as compatibility redirects or aliases
until their Phase 2 replacement is complete.

The Phase 1 navigation changes labels and hierarchy without pretending that the
Phase 2 merges are already complete. Any destination that still exposes one
source in Phase 1 identifies that source explicitly.

## Brain Map home

### Header and global search

The page header contains:

- The Shared Brain title and last generated evidence time.
- A global search field for memory, decisions, work, sessions, systems, and
  automations.
- Compact status indicators for GBrain, Hermes, and OpenClaw.

Search results preserve source labels and link to specialized detail surfaces.
In Phase 1, search filters the current overview evidence, attention items, and
destinations locally; submitting an unmatched query opens GBrain Explore with
the query in the URL. Full federated task and session search belongs to Phase 2.
Search is not allowed to trigger write operations.

### Living Brain Map

The central map places GBrain at the center and shows five surrounding domains:

- Hermes
- OpenClaw
- Source Systems
- Embedding and ingestion pipelines
- Trigger capabilities

Each node shows its own state and observation time. Selecting a node opens an
Evidence Drawer. Connections communicate verified integration relationships,
not inferred ownership. Animation is limited to slow presence and freshness
signals and is disabled when reduced motion is requested.

### Decision Inbox

The Decision Inbox contains ranked attention items. An item is created for:

- stale or unavailable evidence;
- conflicting values from two sources;
- an active caveat or blocker;
- a completed diagnostic that makes a maintenance action available;
- a decision explicitly waiting for operator approval.

Items include severity, system, reason code, concise explanation, observation
time, evidence references, detail route, and recommended next action. A healthy
system with no required operator action does not create noise.

### Evidence Drawer

The drawer is the shared detail pattern for nodes and decisions. It shows:

1. Current conclusion.
2. Supporting evidence and source references.
3. Observation and freshness times.
4. Caveats, conflicts, and missing proof.
5. Available action, safety class, expected effect, and confirmation state.

The drawer never exposes credentials, raw secrets, or unnecessarily sensitive
local configuration.

### GBrain trigger shelf

All useful existing GBrain triggers are retained:

- Run System Check
- Run Fast Doctor
- Preview Source Sync
- Sync Local Sources
- Retry Failed Syncs
- Embed Stale Chunks
- Backfill Missing Embeddings
- Check Skill Routing
- Check Storage Status

`Run System Check` is the prominent home-screen placement of the existing
`doctor-fast` capability, not a ninth backend action. The action registry keeps
the current eight stable action ids.

The UI uses one shared capability registry. The home trigger shelf and Explore
page consume the same registry and mutation handlers, so safety logic cannot
drift between duplicate implementations.

The shelf improves the current trigger experience by showing:

- current eligibility;
- last run and last proof;
- expected duration;
- safety class;
- affected source or queue;
- preview availability;
- the exact reason an action is disabled.

## Visual language: Quiet Observatory

The approved visual direction is Quiet Observatory.

### Principles

- Deep navy and graphite surfaces replace undifferentiated black glass.
- Blue is reserved for selection, navigation, and verified relationships.
- Green, amber, and red communicate real state only.
- Glow is restricted to live nodes and critical focus, not every card.
- Borders and spacing establish hierarchy before shadow or color.
- Dense data uses tabular numbers and concise labels.
- Motion is slow, local, and optional.

### Layout and density

- Desktop uses a compact sidebar and a two-column main workspace: map plus
  Decision Inbox.
- The trigger shelf and Evidence Timeline sit below the primary workspace.
- Tablet stacks the Decision Inbox below the map.
- Mobile replaces the spatial map with an ordered node list while preserving
  identical evidence and action access.
- The main content width is fluid; no critical content is hidden below a fixed
  desktop-only fold.

### Accessibility

- Every state uses text and iconography in addition to color.
- Focus order follows sidebar, header, map nodes, decisions, triggers, timeline.
- All map nodes are buttons with descriptive accessible names.
- Contrast meets WCAG AA for normal text.
- `prefers-reduced-motion` disables ambient node and connection animation.
- Confirmation dialogs restore focus to the initiating trigger.

## Backend architecture

### Unified overview endpoint

Phase 1 adds:

`GET /api/operations/overview`

The endpoint is a bounded parallel aggregator over source-specific adapters. It
returns a versioned contract:

```json
{
  "schemaVersion": "1",
  "generatedAt": "2026-07-10T00:00:00.000Z",
  "mode": "live-read-first",
  "overall": {
    "state": "warning",
    "reasonCodes": ["openclaw_evidence_conflict"]
  },
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

Each system record includes:

- `state`: `healthy`, `warning`, `critical`, `inactive`, or `unavailable`;
- `observedAt`;
- `freshness`: `fresh`, `stale`, `unknown`, or `unavailable`;
- `caveats`;
- normalized metrics;
- `evidenceRefs`;
- `detailHref`.

Each evidence record includes source system, source type, observation time,
summary, status, and a safe reference to the detail surface. Raw command output
is not part of the default overview payload.

Each capability record includes:

- stable id and label;
- owning system;
- safety class;
- enabled state and disabled reason;
- confirmation requirement;
- expected duration;
- preview or proof relationship;
- existing action endpoint reference.

### Adapters

The aggregator uses three isolated adapters:

- OpenClaw adapter: status, heartbeat, gateway, sessions, agents, channels,
  cron summary, and cost summary.
- Hermes adapter: profile status, Kanban summary, workers, blockers, cron
  summary, proxy proof, and GBrain runtime contract.
- GBrain adapter: trust, version, database or storage, source freshness,
  embeddings, queues, integrations, risks, next safe action, and capabilities.

Adapters return partial results instead of throwing away successful source
evidence when another probe fails. Probe timeouts are source-specific and
bounded.

### Health and conflict rules

- System scores are never averaged into a global green state.
- Stale evidence remains stale even when its last value was healthy.
- Unavailable evidence never reuses a cached green value without a visible
  stale marker and observation time.
- Conflicting active-session, heartbeat, queue, or integration values create a
  Decision Inbox item with both evidence references.
- Optional GBrain write or export capabilities do not downgrade healthy core
  read and recall paths.
- Active GBrain caveats remain visible even when trust is `100/100`.
- `inactive` is used only when inactivity is an expected and verified state;
  lack of evidence is `unavailable` or `unknown`, not inactive.

## Action safety model

### R0: direct diagnostic

R0 actions inspect or preview and do not intentionally change a managed source
system. They may update Mission Control cache or evidence timeline records.

R0 includes:

- Run System Check
- Run Fast Doctor
- Preview Source Sync
- Check Skill Routing
- Check Storage Status

### W1: proof plus explicit confirmation

W1 actions change GBrain local shared-memory state. Before execution, the UI
shows current proof, intended scope, expected effect, duration, and rollback or
recovery information where available.

W1 includes:

- Sync Local Sources
- Retry Failed Syncs
- Embed Stale Chunks
- Backfill Missing Embeddings

The confirmation is action-specific and cannot authorize multiple unrelated
actions.

### W2: excluded from the Brain Map

Destructive or externally visible operations remain in specialized pages and
retain their existing confirmations. Examples include cron deletion, external
message send, session close, broad dispatch, and destructive storage repair.

## Frontend component boundaries

Phase 1 introduces focused components rather than growing `Dashboard.tsx`:

- `BrainHome`: query orchestration and page composition.
- `SystemStatusRail`: three-system compact truth display.
- `LivingBrainMap`: accessible node and connection presentation.
- `DecisionInbox`: ranked attention list.
- `EvidenceDrawer`: source proof and action context.
- `GBrainTriggerShelf`: capability registry consumer.
- `EvidenceTimeline`: cross-system evidence events.
- `GlobalSearch`: read-only search over loaded evidence, attention, and
  destinations, with an Explore fallback for unmatched queries.

Pure normalization, ranking, and display helpers live in a sibling `lib.ts` and
receive unit tests. Network reads use the existing query layer. Writes use
mutations and invalidate only the affected overview and specialized query keys.

## Loading, empty, and error behavior

- Initial loading renders the page frame and stable skeleton regions; it does
  not display zero values as facts.
- A source timeout produces a visible unavailable node while successful systems
  remain usable.
- Stale cached evidence shows its observation age and stale label.
- An empty Decision Inbox says that no operator decision currently needs
  attention; it does not imply every source is healthy.
- A trigger failure remains attached to that capability with safe error text and
  a link to evidence. It does not disappear into a transient toast only.
- After W1 success, the UI refetches the affected GBrain proof and keeps the
  action in a verifying state until new evidence arrives.
- If post-action verification fails, the UI reports `action completed; proof
  pending or unavailable` rather than claiming success.

## Verification strategy

### Backend

- Adapter unit tests for healthy, stale, partial, conflicting, and unavailable
  source results.
- Overview contract tests for schema stability and bounded partial failure.
- Health-policy tests proving that caveats and stale evidence are not flattened.
- Capability-policy tests for R0, W1, and W2 classification.
- Route tests proving no secret-adjacent raw output enters the default payload.

### Frontend

- Route and sidebar tests for the seven primary destinations and utility links.
- Component tests for all system states and Decision Inbox ranking.
- Trigger tests for eligibility, preview, confirmation, disabled reasons,
  mutation success, and verification failure.
- Accessibility checks for focus order, names, keyboard activation, contrast,
  and reduced motion.
- Responsive checks at mobile, tablet, and desktop widths.

### Integrated validation

- Frontend lint, unit tests, type-check, and production build.
- Server unit and route test suites.
- Read-only live smoke of `/api/operations/overview` and the Brain Map.
- Rendered visual inspection against the Quiet Observatory direction.
- Live R0 smoke for one diagnostic trigger.
- W1 behavior verified with mocks or a non-mutating preview path unless the user
  separately authorizes a live state-changing test.

## Phase 1 acceptance criteria

Phase 1 is complete when:

- The home route is the Brain Map and no longer presents an OpenClaw-only
  operator briefing.
- Exactly seven primary destinations are shown, with Settings and Audit in the
  utility area.
- GBrain, Hermes, and OpenClaw each show independent state, freshness, evidence,
  and detail navigation.
- Conflicting or stale evidence produces a visible Decision Inbox item.
- The full existing GBrain trigger set remains available through one shared
  registry.
- R0 triggers run without a mutation confirmation; W1 triggers require a scoped
  confirmation; W2 actions are absent from the Brain Map.
- A successful W1 response is not called verified until fresh post-action proof
  is observed.
- Mobile, tablet, keyboard, reduced-motion, and empty or partial states are
  usable.
- Focused tests, production build, and read-only live smoke pass.
- Existing specialized capabilities remain reachable through new or legacy
  routes.

## Documentation impact

Phase 1 updates the route registry and operator-surface documentation. Later
phases update the full consolidation details. At minimum, implementation must
keep these files consistent:

- `README.md`
- `docs/reference-operator-surfaces.md`
- `docs/how-to-verify-operator-surfaces.md`
- `docs/tutorial-first-operator-check.md`
- `docs/reference-frontend-conventions.md`

## Approved decisions

- Primary product mode: information and decision center.
- Action model: read-first with controlled actions.
- GBrain triggers: preserve all useful current triggers and improve proof,
  eligibility, and confirmation UX.
- Home layout: Brain Map.
- Information architecture: seven primary destinations plus utility Settings and
  Audit.
- Backend approach: server-side bounded evidence aggregator.
- Visual direction: Quiet Observatory.
- Delivery: three phases, with Phase 1 implemented first.
