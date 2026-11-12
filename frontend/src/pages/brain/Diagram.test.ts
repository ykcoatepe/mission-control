// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { LineProfile } from './LineProfile'
import { ReadingsBars } from './ReadingsBars'
import { StatusLine } from './StatusLine'
import { TrackDiagram } from './TrackDiagram'
import { alarmFrom } from './alarm'
import { buildDiagram } from './diagram'
import { META, health, sources, synoptic, withVerdict } from './fixtures'
import { buildBrainModel, deriveReadings, deriveVerdict } from './lib'
import { PROFILE_SCALE_PX } from './profile'
import type { GBrainSynoptic, TrendsReading } from './types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mounted: Array<() => void> = []
afterEach(() => {
  while (mounted.length) mounted.pop()?.()
  document.body.innerHTML = ''
})

async function mount(node: ReturnType<typeof createElement>) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(node))
  mounted.push(() => act(() => root.unmount()) as unknown as void)
  return host
}

const AT = '2026-11-11T08:19:30.000Z'
const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  state: 'healthy' as const,
  observedAt: AT,
  lastSyncAt: AT,
  behind: null,
  excludedByPolicy: false,
  reason: null,
  ...extra,
})

const IDS: Record<string, string[]> = {
  reference: ['default-x', 'aviation-standards', 'a320-manuals'],
  projects: ['gstack-code', 'finance-analyzer', 'tk-omc-ain', 'gbrain'],
  'agent-memory': ['hermes-agent'],
  curated: ['curated'],
}
const PAGES: Record<string, number> = {
  'default-x': 18005,
  'aviation-standards': 2078,
  'a320-manuals': 705,
  'gstack-code': 3237,
  'finance-analyzer': 1234,
  'tk-omc-ain': 459,
  gbrain: 84,
  'hermes-agent': 16190,
  curated: 1,
}

function fixture(): GBrainSynoptic {
  return synoptic({
    sources: Object.entries(IDS).map(([id, ids]) => ({
      id,
      label: id,
      state: 'healthy' as const,
      observedAt: AT,
      items: ids.map((sourceId) => (sourceId === 'tk-omc-ain' ? item(sourceId, { state: 'inactive', excludedByPolicy: true, reason: 'sync disabled' }) : item(sourceId))),
    })),
  })
}

const readingOf = () => sources(Object.entries(PAGES).map(([id, pages]) => ({ id, pages, chunks: pages * 2, lastSyncAt: AT })))

function diagramNode(syn = fixture(), selected: string | null = null) {
  return createElement(TrackDiagram, {
    syn,
    model: buildBrainModel(syn),
    diagram: buildDiagram(syn, readingOf()),
    health: health(),
    selectedId: selected,
    onSelect: () => undefined,
  })
}

describe('track diagram', () => {
  it('draws four group blocks with every source, its pages and a mark, and the core with its readings', async () => {
    const host = await mount(diagramNode())
    const svg = host.querySelector('svg[role="group"]') as SVGElement
    for (const id of ['group:reference', 'group:projects', 'group:agent-memory', 'group:curated', 'core', 'queue', 'reader:hermes']) {
      expect(svg.querySelector(`[data-syn-id="${id}"]`), id).not.toBeNull()
    }
    const rows = [...svg.querySelectorAll('[data-source-id]')]
    expect(rows.map((row) => row.getAttribute('data-source-id'))).toHaveLength(Object.keys(PAGES).length)
    const projects = svg.querySelector('[data-syn-id="group:projects"]') as SVGElement
    expect(projects.textContent).toContain('Projects (4)')
    expect(projects.textContent).toContain('5,014 pages')
    expect(projects.textContent).toContain('gstack-code')
    expect(projects.textContent).toContain('3,237')
    // The coloured header takes the group's own line colour (by tone), not a state.
    expect(projects.getAttribute('data-tone')).toBe('projects')
    expect(svg.querySelector('[data-reading="Pages"]')?.textContent).toContain('63,313')
    expect(svg.querySelector('[data-reading="Sources"]')?.textContent).toContain('9 (8 fresh, 1 sync off)')
    expect(svg.querySelector('[data-reading="Link extraction"]')?.textContent).toContain('Current')
    expect(svg.querySelector('[data-reading="Last sync"]')?.textContent).not.toContain('not read')
  })

  it('shows a source with sync off as a dash, never as a state', async () => {
    const host = await mount(diagramNode())
    const off = host.querySelector('svg [data-source-id="tk-omc-ain"]') as SVGElement
    expect(off.getAttribute('data-sync-off')).toBe('true')
    expect(off.querySelector('[data-shape="dash"]')).not.toBeNull()
    const normal = host.querySelector('svg [data-source-id="gbrain"]') as SVGElement
    expect(normal.hasAttribute('data-sync-off')).toBe(false)
    expect(normal.querySelector('[data-shape="circle"]')).not.toBeNull()
  })

  it('draws no occupied track section: a running sync is not observable in the data', async () => {
    const host = await mount(diagramNode())
    expect(host.querySelector('[data-occupied]')).toBeNull()
    expect(host.textContent).not.toMatch(/occupied|sync running/i)
    expect(host.querySelector('ul[aria-label="Legend"]')?.textContent).not.toMatch(/occupied/i)
  })

  it('draws the queue as units on a siding: waiting and running jobs, with the counts under it', async () => {
    const syn = fixture()
    syn.queue = { ...syn.queue, waiting: { ...syn.queue.waiting!, value: 2 }, active: { ...syn.queue.active!, value: 1 }, stalled: { ...syn.queue.stalled!, value: 0 } }
    const host = await mount(diagramNode(syn))
    const units = [...host.querySelectorAll('svg [data-unit]')].map((unit) => unit.getAttribute('data-unit'))
    expect(units).toEqual(['active', 'waiting', 'waiting'])
    expect(host.querySelector('svg [data-queue-caption]')?.textContent).toBe('2 waiting | 1 active | 0 stalled')
  })

  it('marks an unread queue with the hollow circle and draws no units', async () => {
    const syn = fixture()
    syn.queue = { state: 'unavailable', observedAt: null }
    const host = await mount(diagramNode(syn))
    expect(host.querySelectorAll('svg [data-unit]')).toHaveLength(0)
    const caption = host.querySelector('svg [data-queue-caption]')
    expect(caption?.textContent).toBe('not read')
    expect(caption?.querySelector('[data-shape="ring"]')).not.toBeNull()
  })

  it('is keyboard navigable: every block is a focusable button, arrows move between them', async () => {
    const host = await mount(diagramNode())
    const blocks = [...host.querySelectorAll('svg [data-syn-id]')] as SVGElement[]
    expect(blocks.length).toBe(4 + 1 + 1 + 2)
    for (const block of blocks) {
      expect(block.getAttribute('role')).toBe('button')
      expect(block.getAttribute('tabindex')).toBe('0')
      expect(block.getAttribute('aria-label')).toBeTruthy()
    }
    const first = host.querySelector('svg [data-syn-id="group:reference"]') as SVGElement
    first.focus()
    await act(async () => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    expect(document.activeElement?.getAttribute('data-syn-id')).toBe('group:projects')
  })

  it('marks the selected block', async () => {
    const host = await mount(diagramNode(fixture(), 'group:projects'))
    expect(host.querySelector('svg [data-syn-id="group:projects"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('svg [data-syn-id="core"]')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('narrow fallback: every group and every source is in the list, so nothing is lost', async () => {
    const host = await mount(diagramNode())
    const lists = [...host.querySelectorAll('ul[data-list-id^="group:"]')]
    expect(lists.map((list) => list.getAttribute('data-list-id'))).toEqual(['group:reference', 'group:projects', 'group:agent-memory', 'group:curated'])
    const listed = lists.flatMap((list) => [...list.querySelectorAll('li')].map((li) => li.textContent ?? ''))
    for (const id of Object.keys(PAGES)) {
      expect(listed.some((text) => text.includes(id)), id).toBe(true)
    }
    const projects = host.querySelector('ul[data-list-id="group:projects"]') as HTMLElement
    expect(projects.textContent).toContain('sync off')
    expect(projects.textContent).toContain('3,237')
    expect(host.querySelector('[data-list-id="core"]')?.textContent).toContain('63,313')
    expect(host.querySelector('[data-list-id="queue"]')?.textContent).toContain('waiting')
  })
})

describe('line profile', () => {
  const lines = (host: HTMLElement) => [...host.querySelectorAll('ul[aria-label="Pages per source"] li')] as HTMLElement[]

  it('draws one line per source in diagram order, labelled with exact values', async () => {
    const host = await mount(createElement(LineProfile, { diagram: buildDiagram(fixture(), readingOf()) }))
    const items = lines(host)
    expect(items.map((li) => li.getAttribute('data-source-id'))).toEqual(buildDiagram(fixture(), readingOf()).sources.map((s) => s.id))
    const label = (id: string) => items.find((li) => li.getAttribute('data-source-id') === id)?.textContent
    expect(label('default-x')).toContain('18,005')
    expect(label('gbrain')).toContain('84')
    expect(label('curated')).toContain('1')
  })

  it('heights are proportional to pages on one linear scale; a tiny source is one pixel, not hidden', async () => {
    const host = await mount(createElement(LineProfile, { diagram: buildDiagram(fixture(), readingOf()) }))
    const height = (id: string) => Number.parseFloat((lines(host).find((li) => li.getAttribute('data-source-id') === id) as HTMLElement).style.getPropertyValue('--h'))
    expect(height('default-x')).toBe(PROFILE_SCALE_PX)
    expect(height('hermes-agent')).toBe(Math.round((16190 / 18005) * PROFILE_SCALE_PX))
    expect(height('gstack-code')).toBe(Math.round((3237 / 18005) * PROFILE_SCALE_PX))
    expect(height('curated')).toBe(1)
    expect(height('gbrain')).toBe(1)
    // One baseline: every line has the same plot height, and its line is drawn.
    expect(lines(host).every((li) => li.querySelector('span[class*="line"]') !== null)).toBe(true)
  })

  it('has a plot at least 140px tall, and every source label is its full id or a middle cut that keeps the id in the title', async () => {
    const host = await mount(createElement(LineProfile, { diagram: buildDiagram(fixture(), readingOf()) }))
    const list = host.querySelector('ul[aria-label="Pages per source"]') as HTMLElement
    expect(Number.parseFloat(list.style.getPropertyValue('--scale'))).toBeGreaterThanOrEqual(140)
    const names = lines(host).map((li) => li.querySelector('span[title]') as HTMLElement)
    expect(names.every((n) => n !== null)).toBe(true)
    const texts = names.map((n) => n.textContent)
    expect(new Set(texts).size).toBe(texts.length)
    // The label is the id itself (none of the fixture's ids is long enough to be cut), not its first word.
    for (const li of lines(host)) {
      const name = li.querySelector('span[title]') as HTMLElement
      expect(name.getAttribute('title')).toBe(li.getAttribute('data-source-id'))
      expect(name.textContent).toBe(li.getAttribute('data-source-id'))
    }
  })

  it('writes the count above each line, and says on hover which counts it left out', async () => {
    const host = await mount(createElement(LineProfile, { diagram: buildDiagram(fixture(), readingOf()) }))
    const item = lines(host).find((li) => li.getAttribute('data-source-id') === 'default-x') as HTMLElement
    const count = item.querySelector('span[class*="value"]') as HTMLElement
    expect(count.textContent).toBe('18,005')
    // Without a measured width nothing is hidden (jsdom has no layout): no count is marked crowded.
    expect(lines(host).every((li) => !(li.querySelector('span[class*="value"]') as HTMLElement).hasAttribute('data-crowded'))).toBe(true)
  })

  it('draws a source whose sync is off dashed, and colours each line by its group', async () => {
    const host = await mount(createElement(LineProfile, { diagram: buildDiagram(fixture(), readingOf()) }))
    const byId = (id: string) => lines(host).find((li) => li.getAttribute('data-source-id') === id) as HTMLElement
    expect(byId('tk-omc-ain').hasAttribute('data-sync-off')).toBe(true)
    expect(byId('gbrain').hasAttribute('data-sync-off')).toBe(false)
    expect(byId('gstack-code').getAttribute('data-tone')).toBe('projects')
    expect(byId('hermes-agent').getAttribute('data-tone')).toBe('agent')
    expect(byId('curated').getAttribute('data-tone')).toBe('curated')
  })

  it('shows name, pages, chunks and last sync on hover and on focus', async () => {
    const host = await mount(createElement(LineProfile, { diagram: buildDiagram(fixture(), readingOf()) }))
    const readout = host.querySelector('p[aria-live="polite"]') as HTMLElement
    expect(readout.textContent).toContain('Hover or focus')
    const target = lines(host).find((li) => li.getAttribute('data-source-id') === 'gstack-code') as HTMLElement
    await act(async () => {
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(readout.textContent).toContain('gstack-code: 3,237 pages, 6,474 chunks, last sync')
    const off = lines(host).find((li) => li.getAttribute('data-source-id') === 'tk-omc-ain') as HTMLElement
    await act(async () => off.focus())
    expect(readout.textContent).toContain('tk-omc-ain: 459 pages, 918 chunks, sync off')
  })

  it('has one tab stop and moves with the arrow keys', async () => {
    const host = await mount(createElement(LineProfile, { diagram: buildDiagram(fixture(), readingOf()) }))
    expect(lines(host).filter((li) => li.tabIndex === 0)).toHaveLength(1)
    const first = lines(host)[0]
    first.focus()
    await act(async () => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(document.activeElement).toBe(lines(host)[1])
  })

  it('says not read, with no line, for a source whose pages were not read', async () => {
    const host = await mount(createElement(LineProfile, { diagram: buildDiagram(fixture(), null) }))
    const first = lines(host)[0]
    expect(first.textContent).toContain('not read')
    expect(first.querySelector('span[class*="line"]')).toBeNull()
  })
})

describe('analog bars: no trend without data', () => {
  const trends = (series: TrendsReading['series']): TrendsReading => ({ series, meta: META })
  const bars = (syn: GBrainSynoptic, t: TrendsReading | null) => {
    const verdict = deriveVerdict(syn, META)
    return createElement(ReadingsBars, { syn, verdict, readings: deriveReadings(syn, buildBrainModel(syn), health(), verdict.state), trends: t })
  }
  const points = (values: number[]) => values.map((v, i) => ({ t: Date.parse(AT) + i * 60_000, v }))

  it('draws no trend when the series is missing, empty or a single reading', async () => {
    for (const t of [null, trends({}), trends({ quality: [], embeddedPercent: [], queue: [] }), trends({ quality: points([99]) })]) {
      const host = await mount(bars(fixture(), t))
      expect(host.querySelector('svg[aria-label="24-hour trend"]')).toBeNull()
      expect(host.textContent).not.toContain('24h trend')
      expect(host.querySelectorAll('[role="meter"]')).toHaveLength(3)
    }
  })

  it('draws the trend only for the series that has at least two real readings', async () => {
    const host = await mount(bars(fixture(), trends({ quality: points([98, 99, 99]), queue: points([3]) })))
    expect(host.querySelectorAll('svg[aria-label="24-hour trend"]')).toHaveLength(1)
    expect(host.textContent).toContain('24h trend')
  })

  it('says the trends were not read when there is no answer or the server could not read the history', async () => {
    const unread = { ...META, ok: false, stale: true, error: { code: 'gbrain_trends_corrupt', message: 'The readings history could not be read' } }
    for (const t of [null, { series: { quality: [], embeddedPercent: [], queue: [] }, skippedLines: 3, meta: unread }, { series: { quality: points([98, 99]) }, meta: unread }]) {
      const host = await mount(bars(fixture(), t))
      expect(host.textContent).toContain('24-hour trends not read')
      expect(host.querySelector('svg[aria-label="24-hour trend"]')).toBeNull()
    }
    const read = await mount(bars(fixture(), trends({ quality: [], embeddedPercent: [], queue: [] })))
    expect(read.textContent).not.toContain('not read')
  })

  it('draws a partly read history with the number of lines that could not be read', async () => {
    const host = await mount(bars(fixture(), { series: { quality: points([98, 99]) }, partial: true, skippedLines: 2, meta: META }))
    expect(host.querySelectorAll('svg[aria-label="24-hour trend"]')).toHaveLength(1)
    expect(host.textContent).toContain('2 history lines not read')
  })

  it('states the normal band only where the server defines one: quality 90 to 100', async () => {
    const host = await mount(bars(fixture(), null))
    const meters = [...host.querySelectorAll('[role="meter"]')]
    expect(meters.map((meter) => meter.getAttribute('aria-label'))).toEqual(['Quality, out of 100', 'Embedded', expect.stringMatching(/^Queue/)])
    expect(meters[0].getAttribute('aria-valuetext')).toContain('normal 90 – 100')
    expect(meters[1].getAttribute('aria-valuetext')).not.toContain('normal')
    expect(host.textContent).toContain('Normal: 90 – 100')
  })

  it('says not read, with no pointer and no trend, for readings that were not taken', async () => {
    const syn = fixture()
    syn.core = { ...syn.core, quality: { ...syn.core.quality!, value: null, state: 'unavailable' }, chunks: { ...syn.core.chunks!, value: null, state: 'unavailable' } }
    syn.queue = { state: 'unavailable', observedAt: null }
    const host = await mount(bars(syn, trends({ quality: points([98, 99]), embeddedPercent: points([99, 100]), queue: points([1, 2]) })))
    expect([...host.querySelectorAll('[role="meter"]')].map((meter) => meter.getAttribute('aria-valuetext'))).toEqual(['Not read', 'Not read', 'Not read'])
    expect(host.querySelector('svg[aria-label="24-hour trend"]')).toBeNull()
  })
})

describe('status line', () => {
  const props = {
    running: null,
    stale: false,
    observedAt: AT,
    onRun: () => undefined,
    runCheckDisabled: false,
    checkRunning: false,
  }
  const verdictOf = (...reasons: Parameters<typeof withVerdict>[1][]) => deriveVerdict(withVerdict(synoptic(), ...reasons), META)

  it('is an alarm line only for something to act on, with its one action', async () => {
    const verdict = verdictOf({ elementId: 'missing-embeddings', state: 'warning', kind: 'action', text: '9 chunks are missing embeddings past the tolerance.' })
    const clicks: string[] = []
    const host = await mount(
      createElement(StatusLine, {
        ...props,
        verdict,
        alarm: alarmFrom(verdict),
        action: { label: 'Backfill embeddings', capability: { id: 'embed-missing' } as never },
        onRun: (choice: { label: string }) => clicks.push(choice.label),
      }),
    )
    const line = host.querySelector('[role="status"][data-state="warning"]') as HTMLElement
    expect(line.textContent).toContain('Caution')
    expect(line.textContent).toContain('9 chunks are missing embeddings past the tolerance')
    const buttons = line.querySelectorAll('button')
    expect(buttons).toHaveLength(1)
    await act(async () => (buttons[0] as HTMLButtonElement).click())
    expect(clicks).toEqual(['Backfill embeddings'])
  })

  it('is critical as an alert', async () => {
    const verdict = verdictOf({ elementId: 'gbrain-core', state: 'critical', kind: 'action', text: 'GBrain core is failing.' })
    const host = await mount(createElement(StatusLine, { ...props, verdict, alarm: alarmFrom(verdict), action: null }))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Critical')
  })

  it('is no alarm line when only information is left: one quiet sentence, no state colour', async () => {
    const verdict = verdictOf(
      { elementId: 'embed-job-probe', state: 'unavailable', kind: 'info', text: "Embedding job status couldn't be read." },
      { elementId: 'tk-omc-ain', state: 'inactive', kind: 'info', text: 'tk-omc-ain: sync off.' },
    )
    const host = await mount(createElement(StatusLine, { ...props, verdict, alarm: alarmFrom(verdict), action: null }))
    expect(host.querySelector('[data-state="warning"], [data-state="critical"], [role="alert"]')).toBeNull()
    expect(host.querySelectorAll('button')).toHaveLength(0)
    expect(host.textContent).not.toMatch(/caution|critical/i)
  })

  it('says a normal reading once, quietly, and a stale reading with "as of"', async () => {
    const verdict = verdictOf()
    const fresh = await mount(createElement(StatusLine, { ...props, verdict, alarm: null, action: null }))
    expect(fresh.textContent).toContain('GBrain is normal')
    expect(fresh.textContent).not.toMatch(/as of|stale|fresh/)
    const stale = await mount(createElement(StatusLine, { ...props, stale: true, verdict, alarm: null, action: null }))
    expect(stale.textContent).toMatch(/as of/)
  })
})
