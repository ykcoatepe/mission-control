import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { DecisionInbox } from './DecisionInbox'
import { EvidenceTimeline } from './EvidenceTimeline'
import { LivingBrainMap } from './LivingBrainMap'
import { SystemStatusRail } from './SystemStatusRail'
import type {
  AttentionItem,
  EvidenceItem,
  OperationsOverview,
  OperationSystem,
} from './types'

const systems: OperationSystem[] = [
  {
    id: 'gbrain',
    label: 'GBrain',
    state: 'healthy',
    freshness: 'fresh',
    observedAt: '2026-07-10T12:00:00Z',
    caveats: [],
    metrics: {},
    evidence: [],
    detailHref: '/gbrain',
  },
  {
    id: 'hermes',
    label: 'Hermes',
    state: 'healthy',
    freshness: 'fresh',
    observedAt: '2026-07-10T12:00:00Z',
    caveats: [],
    metrics: {},
    evidence: [],
    detailHref: '/work',
  },
  {
    id: 'openclaw',
    label: 'OpenClaw',
    state: 'warning',
    freshness: 'stale',
    observedAt: null,
    caveats: ['Heartbeat unavailable'],
    metrics: {},
    evidence: [],
    detailHref: '/systems',
  },
]

const overview = {
  systems: Object.fromEntries(systems.map((system) => [system.id, system])),
} as unknown as OperationsOverview

function renderWithRouter(element: ReturnType<typeof createElement>) {
  return renderToStaticMarkup(createElement(MemoryRouter, null, element))
}

describe('brain truth components', () => {
  it('renders all three systems without reducing caveats to color only', () => {
    const html = renderWithRouter(createElement(SystemStatusRail, { systems }))

    expect(html).toContain('GBrain')
    expect(html).toContain('Hermes')
    expect(html).toContain('OpenClaw')
    expect(html).toContain('Heartbeat unavailable')
    expect(html).toContain('stale')
    expect(html).toContain('no current proof')
    expect(html).toContain('data-state="warning"')
  })

  it('keeps the fixed three-system map relationship and explicit accessible states', () => {
    const html = renderWithRouter(createElement(LivingBrainMap, {
      overview,
      onSelectSystem: vi.fn(),
    }))

    expect(html.indexOf('GBrain')).toBeLessThan(html.indexOf('Hermes'))
    expect(html.indexOf('Hermes')).toBeLessThan(html.indexOf('OpenClaw'))
    expect(html).toContain('aria-label="OpenClaw: warning, stale, no current proof · Heartbeat unavailable')
    expect(html).toContain('Sources')
    expect(html).toContain('Triggers')
  })

  it('uses the shared attention policy and leaves an honest empty state', () => {
    const items = [
      { id: 'warning', system: 'hermes', severity: 'warning', title: 'Warning item', detail: 'Needs review' },
      { id: 'critical', system: 'gbrain', severity: 'critical', title: 'Critical item', detail: 'Needs action' },
    ] as AttentionItem[]
    const sortedHtml = renderToStaticMarkup(createElement(DecisionInbox, { items, onSelect: vi.fn() }))
    const emptyHtml = renderToStaticMarkup(createElement(DecisionInbox, { items: [], onSelect: vi.fn() }))

    expect(sortedHtml.indexOf('Critical item')).toBeLessThan(sortedHtml.indexOf('Warning item'))
    expect(sortedHtml).toContain('data-severity="critical"')
    expect(emptyHtml).toContain('Review system freshness')
  })

  it('limits the evidence stream and labels missing timestamps as unknown', () => {
    const evidence = Array.from({ length: 10 }, (_, index) => ({
      id: `proof-${index}`,
      system: 'gbrain',
      kind: 'health',
      status: 'healthy',
      observedAt: index === 0 ? null : '2026-07-10T12:00:00Z',
      summary: `Proof ${index}`,
      sourceRef: 'gbrain.overview',
      detailHref: '/gbrain',
    })) as EvidenceItem[]
    const html = renderToStaticMarkup(createElement(EvidenceTimeline, { evidence, onSelect: vi.fn() }))

    expect(html).toContain('unknown')
    expect(html).toContain('Proof 7')
    expect(html).not.toContain('Proof 8')
  })
})
