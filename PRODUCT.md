# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

One operator: the owner of this workstation. He runs a personal fleet of AI agents (Hermes, Codex, Claude Code, OpenClaw) that all read from and write to one shared knowledge base, GBrain. Mission Control stays open all day on a second screen or in a corner of the desk; he watches it out of the corner of his eye and turns to it when something changes. He is technical and fluent in English UI; conversation with him is in Turkish.

## Product Purpose

Mission Control is the single local window onto that fleet. Its home page is the Brain page. The Brain page has two jobs of equal weight: answer "is the brain healthy, and if not, what is the one thing to do" at a glance, and show the brain itself: how large it is, what came in, which source brought it, and let him search its contents. Success: he can tell from across the desk whether anything needs him, and when he looks closer the page is worth looking at, not a form to be read.

## Positioning

It is built for one person's own machine and reads the real systems directly. Every state shown is something the server actually observed; what cannot be read is said to be unread, never guessed.

## Operating Context

- Always-on ambient display on a desktop monitor, dark room or office light; also opened in a normal browser tab. Phone is not a primary use.
- Other pages: Attention, Automations, Usage, Services, Local models, Settings, Audit. They share one shell (sidebar, top bar with system signals, command palette).
- GBrain data available to the page today: quality score (0-100), pages / chunks / embedded counts, missing-embedding and link-extraction lag, embedding queue (waiting / active / stalled), 19 sources in 4 groups with sync age, four reader integrations (set up or not; live connection cannot be observed), a verdict with reasons split into action and information, a history ledger of readings (about 5,000 entries), eight maintenance actions (four checks, four changes that ask first), content search and page lookup.

## Capabilities and Constraints

- Local only (127.0.0.1); no accounts, no multi-user.
- A page request never starts a process; data comes from scheduled readings with an observed-at time and a stale flag.
- State vocabulary is fixed: healthy, warning, critical, unavailable (could not be read), inactive (intentionally off).
- Restricted project content is never shown, counts only.
- Reader connections cannot be observed; the page may only say whether a reader is set up.
- English interface text, plain words, no engineer jargon.
- React 19, Vite, TypeScript, CSS Modules; light and dark themes exist.

## Brand Commitments

- Name: Mission Control. No logo or brand assets are binding.
- The owner found the first shipped Brain page boring and without character (2026-11-12), and found its boxes-and-lines system diagram not useful. A future Brain page must not be a stack of equal-weight admin cards.

## Evidence on Hand

- Live data from the owner's own GBrain (about 58,800 pages, 419,000 chunks, 19 sources).
- No testimonials, customers, pricing or marketing claims exist; none may be invented.

## Product Principles

1. Quiet when normal: the page should not ask for attention it does not need.
2. One thing to do: when something is wrong, name the single next action in plain words.
3. Observed, not assumed: never show a state the server did not read.
4. Worth looking at: an always-open screen has to reward a glance and a longer look.
5. Maintenance and history are tools, not the page.
