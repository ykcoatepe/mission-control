---
version: 1
slug: "frontend-src-pages-brainhome-tsx"
primary_target: "frontend/src/pages/BrainHome.tsx"
related_targets: []
---

# Brain home (and the Mission Control shell)

Scope: `/` Brain page, mode Operate; the same world governs every Mission Control page. Audience: the single owner, always-on second screen. Job: see at a glance whether anything is abnormal and the one action; see what feeds the brain and how much it holds. Approved reference image (critique reference, code-led build): `.impeccable/mocks/decision/col-1.png`; light theme reference `.impeccable/mocks/decision/pal-c.png`.

Decisions by the owner (2026-11-12): direction "Signalling Diagram" with the line-profile strip taken from "Line Rail"; palette A "Slate dusk" dark, C "Soft daylight" light; "Line colours" for the four source groups; the whole app moves to this world; menu badges count only new, unacknowledged, actionable items (acknowledge / shelve), restricted counts never enter a badge.

## Direction contract

THESIS: A supervisory HMI in the manner of a railway signalling centre: the brain is a station fed by four coloured lines. It refuses the stack of equal-weight admin cards and the dashboard that is always lit.

OWN-WORLD: Deep blue-grey slate ground, soft off-white lettering, hairline outlines, no shadows. Colour has three jobs only: amber/red for abnormal state (always with a shape), teal for what can be done or is selected, and four line colours (blue, green, violet, rose) that identify the source groups. Normal is neutral grey-white. Block headers in condensed capitals; tabular numerals; analog bars with a marked normal band and a 24-hour trend.

STORY: He glances: nothing coloured means nothing to do. If something is amber, the alarm line names it and offers one action. A longer look shows what feeds the brain, how big each source is, and how the readings moved today.

FIRST VIEWPORT: Standard side rail and top bar with three system signals. Alarm line across the top of the work area with the single action at its right end. Left two thirds: the track diagram (four group blocks, coloured tracks into GBRAIN CORE, embedding-queue siding below, four reader blocks marked "set up"). Right third: three analog bars (quality, embedded, queue) with normal band and trend. Under the diagram: the line profile, 19 lines to scale in group colours, sync-off dashed. Bottom: recent readings table.

FORM: railway signalling control diagram, candidate 6 of the second (HMI-steered) list; seed:73fce8ee55d448c0. Signature move: sources as tracks whose section shows occupied while a sync is observed running, plus the to-scale line profile.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Unresolved: whether a running sync and an embedded-percentage history are observable (show only if read); other pages follow the same rules without their own comps.
