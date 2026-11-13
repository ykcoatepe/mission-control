// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LineProfile } from './LineProfile'
import { ReadingsBars } from './ReadingsBars'
import { StatusLine } from './StatusLine'
import { TrackDiagram } from './TrackDiagram'
import { alarmFrom } from './alarm'
import { RAIL_MAX, RAIL_MIN, ageShort, buildDiagram, groupFreshness, railWeight } from './diagram'
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

function cleanup(host: HTMLElement) {
  host.remove()
}

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

  it('has a plot at least 140px tall, and every source label is a short name that is unique, with the full id in the title', async () => {
    const host = await mount(createElement(LineProfile, { diagram: buildDiagram(fixture(), readingOf()) }))
    const list = host.querySelector('ul[aria-label="Pages per source"]') as HTMLElement
    expect(Number.parseFloat(list.style.getPropertyValue('--scale'))).toBeGreaterThanOrEqual(140)
    const names = lines(host).map((li) => li.querySelector('span[title]') as HTMLElement)
    expect(names.every((n) => n !== null)).toBe(true)
    const texts = names.map((n) => n.textContent)
    expect(new Set(texts).size).toBe(texts.length)
    for (const li of lines(host)) {
      const name = li.querySelector('span[title]') as HTMLElement
      expect(name.getAttribute('title')).toBe(li.getAttribute('data-source-id'))
    }
    const label = (id: string) => lines(host).find((li) => li.getAttribute('data-source-id') === id)?.querySelector('span[title]')?.textContent
    expect(label('gstack-code')).toBe('gstack')
    expect(label('aviation-standards')).toBe('aviation')
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

  it('shows name, pages, chunks and last sync on hover and on focus, for screen readers too', async () => {
    const host = await mount(createElement(LineProfile, { diagram: buildDiagram(fixture(), readingOf()) }))
    const live = host.querySelector('[data-live]') as HTMLElement
    expect(live.getAttribute('aria-live')).toBe('polite')
    expect(live.textContent).toBe('')
    const target = lines(host).find((li) => li.getAttribute('data-source-id') === 'gstack-code') as HTMLElement
    await act(async () => {
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(live.textContent).toContain('gstack-code: 3,237 pages, 6,474 chunks, last sync')
    const off = lines(host).find((li) => li.getAttribute('data-source-id') === 'tk-omc-ain') as HTMLElement
    await act(async () => off.focus())
    expect(live.textContent).toContain('tk-omc-ain: 459 pages, 918 chunks, sync off')
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

describe('line profile: looking at one source', () => {
  const lines = (host: HTMLElement) => [...host.querySelectorAll('ul[aria-label="Pages per source"] li')] as HTMLElement[]
  const byId = (host: HTMLElement, id: string) => lines(host).find((li) => li.getAttribute('data-source-id') === id) as HTMLElement
  const profileNode = () => createElement(LineProfile, { diagram: buildDiagram(fixture(), readingOf()) })

  it('has a labelled scale with round values up to the tallest line', async () => {
    const host = await mount(profileNode())
    const ticks = [...host.querySelectorAll('[data-axis] [data-tick]')].map((tick) => tick.textContent)
    expect(ticks[0]).toBe('0')
    expect(ticks.length).toBeGreaterThanOrEqual(3)
    expect(ticks).toContain('10,000')
  })

  it('focusing a column puts its readings in the caption row, marks its value on the scale, and dims the others', async () => {
    const host = await mount(profileNode())
    expect(host.querySelector('[data-readout]')).toBeNull()
    expect(host.querySelector('[data-caption-idle]')?.textContent).toContain('One scale: the tallest line is 18,005 pages')
    const target = byId(host, 'gstack-code')
    await act(async () => target.focus())
    const reading = host.querySelector('[data-readout]') as HTMLElement
    // Name, group, pages, chunks, share, last sync, sync state: one row, in this order.
    const parts = [...reading.children].map((child) => child.textContent)
    expect(parts[0]).toBe('gstack-code')
    expect(parts[1]).toBe('Projects')
    expect(parts[2]).toBe('3,237 pages')
    expect(parts[3]).toBe('6,474 chunks')
    // 3,237 of 41,953 pages (the fixture's total): one decimal place below 10%.
    expect(parts[4]).toBe('7.7% of all pages')
    expect(parts[5]).toMatch(/^last sync /)
    expect(parts[6]).toBe('fresh')
    expect(reading.getAttribute('data-tone')).toBe('projects')
    // Its home is the caption row under the title, not the plot; the sentence it replaces stays in the row, out of sight.
    expect(reading.closest('[data-caption]')).not.toBeNull()
    expect(reading.closest('[class*="chart"]')).toBeNull()
    expect(host.querySelector('[data-caption-idle]')?.hasAttribute('data-away')).toBe(true)
    expect(host.querySelector('[data-full-label]')?.textContent).toBe('gstack-code')
    expect(target.getAttribute('data-shown')).toBe('true')
    expect(host.querySelector('ul[aria-label="Pages per source"]')?.getAttribute('data-focus')).toBe('true')
    expect(lines(host).filter((li) => li.hasAttribute('data-shown'))).toHaveLength(1)
  })

  it('draws no guide line across the plot and no floating card: the value is marked on the scale only', async () => {
    const host = await mount(profileNode())
    await act(async () => byId(host, 'gstack-code').focus())
    expect(host.querySelector('[data-rule]')).toBeNull()
    expect(host.querySelector('[class*="rule"]')).toBeNull()
    expect(host.querySelector('[class*="card"]')).toBeNull()
    const marker = host.querySelector('[data-axis-marker]') as HTMLElement
    expect(marker).not.toBeNull()
    expect(marker.closest('[data-axis]')).not.toBeNull()
    expect(marker.textContent).toBe('3,237')
    // Level with the top of the line (36px at 200px for 18,005 pages).
    expect(marker.style.getPropertyValue('--v')).toBe(`${byId(host, 'gstack-code').style.getPropertyValue('--h')}`)
    // Nothing is drawn inside the plot but the lines, their counts and their labels.
    expect(host.querySelector('ul[aria-label="Pages per source"]')?.querySelectorAll('[data-axis-marker]')).toHaveLength(0)
    await act(async () => (document.activeElement as HTMLElement).blur())
    expect(host.querySelector('[data-axis-marker]')).toBeNull()
  })

  it('puts away a scale value that would sit under the marker, and only that one', async () => {
    const host = await mount(profileNode())
    const away = () => [...host.querySelectorAll('[data-axis] [data-tick][data-away]')].map((tick) => tick.getAttribute('data-tick'))
    expect(away()).toEqual([])
    // 459 pages stand 5px high: level with the 0 of the scale.
    await act(async () => byId(host, 'tk-omc-ain').focus())
    expect(away()).toEqual(['0'])
    await act(async () => byId(host, 'gstack-code').focus())
    expect(away()).toEqual([])
  })

  it('hovering anywhere on the column shows the same readings; leaving restores the sentence', async () => {
    const host = await mount(profileNode())
    await act(async () => {
      byId(host, 'hermes-agent').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(host.querySelector('[data-readout]')?.textContent).toContain('16,190 pages')
    await act(async () => {
      host.querySelector('ul[aria-label="Pages per source"]')?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    })
    expect(host.querySelector('[data-readout]')).toBeNull()
    expect(host.querySelector('[data-caption-idle]')?.hasAttribute('data-away')).toBe(false)
  })

  it('gives a one-pixel source the same readings, and says sync off for a source with sync off', async () => {
    const host = await mount(profileNode())
    await act(async () => byId(host, 'curated').focus())
    expect(host.querySelector('[data-readout]')?.textContent).toContain('curated')
    expect(byId(host, 'curated').style.getPropertyValue('--h')).toBe('1px')
    await act(async () => byId(host, 'tk-omc-ain').focus())
    const reading = host.querySelector('[data-readout]') as HTMLElement
    expect(reading.textContent).toContain('sync off')
    expect(reading.textContent).not.toContain('last sync')
  })

  it('Escape and blur restore the sentence', async () => {
    const host = await mount(profileNode())
    const target = byId(host, 'gbrain')
    await act(async () => target.focus())
    expect(host.querySelector('[data-readout]')).not.toBeNull()
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(host.querySelector('[data-readout]')).toBeNull()
    expect(host.querySelector('[data-caption-idle]')?.hasAttribute('data-away')).toBe(false)
    expect(document.activeElement).toBe(target)
    await act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(host.querySelector('[data-readout]')).not.toBeNull()
    await act(async () => (document.activeElement as HTMLElement).blur())
    expect(host.querySelector('[data-readout]')).toBeNull()
    expect(host.querySelector('[data-caption-idle]')?.hasAttribute('data-away')).toBe(false)
    expect(host.querySelector('[data-caption-idle]')?.textContent).toContain('One scale')
  })

  it('a tap toggles the same state', async () => {
    const host = await mount(profileNode())
    const target = byId(host, 'finance-analyzer')
    class FakePointer extends Event {
      pointerType = 'touch'
    }
    await act(async () => {
      target.dispatchEvent(new FakePointer('pointerdown', { bubbles: true }))
      target.click()
    })
    expect(host.querySelector('[data-readout]')?.textContent).toContain('1,234')
    await act(async () => {
      target.dispatchEvent(new FakePointer('pointerdown', { bubbles: true }))
      target.click()
    })
    expect(host.querySelector('[data-readout]')).toBeNull()
  })
})

describe('line profile: labels on a measured, wide profile', () => {
  const lines = (host: HTMLElement) => [...host.querySelectorAll('ul[aria-label="Pages per source"] li')] as HTMLElement[]
  const byId = (host: HTMLElement, id: string) => lines(host).find((li) => li.getAttribute('data-source-id') === id) as HTMLElement
  const nameOf = (host: HTMLElement, id: string) => byId(host, id).querySelector('[data-name-label]') as HTMLElement
  const profileNode = () => createElement(LineProfile, { diagram: buildDiagram(fixture(), readingOf()) })

  // jsdom has no layout: give the profile a width (900px: nine columns of 100px) and every label a box.
  let labelWidth = 60
  const realRect = Element.prototype.getBoundingClientRect
  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')
  const RealObserver = globalThis.ResizeObserver

  beforeEach(() => {
    labelWidth = 60
    globalThis.ResizeObserver = class {
      constructor(private callback: () => void) {}
      observe() {
        this.callback()
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    Object.defineProperty(Element.prototype, 'clientWidth', {
      configurable: true,
      get(this: Element) {
        return this.tagName === 'UL' ? 900 : 0
      },
    })
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const index = this.closest('li') ? [...(this.closest('ul')?.children ?? [])].indexOf(this.closest('li') as Element) : -1
      const centre = (index + 0.5) * 100
      const make = (width: number, top: number, bottom: number) =>
        ({ left: centre - width / 2, right: centre + width / 2, top, bottom, width, height: bottom - top, x: centre - width / 2, y: top, toJSON: () => ({}) }) as DOMRect
      if (this.hasAttribute('data-name-label')) return make(labelWidth, 229, 245)
      if (this.hasAttribute('data-full-label')) return make(160, 227, 247)
      return realRect.call(this)
    }
  })

  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect
    if (clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', clientWidth)
    globalThis.ResizeObserver = RealObserver
  })

  it('hides the labels that touch the enlarged label of the looked-at source, from measured boxes, and restores them on leave', async () => {
    const host = await mount(profileNode())
    const covered = () => lines(host).filter((li) => li.querySelector('[data-covered]')).map((li) => li.getAttribute('data-source-id'))
    expect(covered()).toEqual([])
    // finance-analyzer is the fifth column: its enlarged label (160px) reaches into the columns on both sides, not beyond.
    await act(async () => byId(host, 'finance-analyzer').focus())
    expect(host.querySelector('[data-full-label]')?.textContent).toBe('finance-analyzer')
    expect(covered()).toEqual(['gstack-code', 'tk-omc-ain'])
    await act(async () => byId(host, 'curated').focus())
    expect(covered()).toEqual(['hermes-agent'])
    await act(async () => (document.activeElement as HTMLElement).blur())
    expect(covered()).toEqual([])
  })

  it('draws one row of labels: a column too narrow for its label loses the label, and no label is offset onto a second row', async () => {
    const host = await mount(profileNode())
    const dropped = () => lines(host).filter((li) => li.querySelector('[data-dropped]')).map((li) => li.getAttribute('data-source-id'))
    // 60px labels in 100px columns: all of them fit.
    expect(dropped()).toEqual([])
    cleanup(host)
    // 120px labels in 100px columns: the bigger source keeps its label, a neighbour that would touch it loses its own.
    labelWidth = 120
    const narrow = await mount(profileNode())
    const lost = lines(narrow).filter((li) => li.querySelector('[data-dropped]')).map((li) => li.getAttribute('data-source-id'))
    expect(lost.sort()).toEqual(['a320-manuals', 'aviation-standards', 'curated', 'finance-analyzer', 'gbrain'])
    for (const li of lines(narrow)) {
      expect(li.style.getPropertyValue('--row')).toBe('')
      expect(li.querySelectorAll('[data-name-label]')).toHaveLength(1)
    }
    // The dropped name is still the accessible name of its column.
    expect(byId(narrow, 'aviation-standards').getAttribute('aria-label')).toContain('aviation-standards')
    expect(nameOf(narrow, 'default-x').hasAttribute('data-dropped')).toBe(false)
  })
})

describe('line profile: short labels', () => {
  const lines = (host: HTMLElement) => [...host.querySelectorAll('ul[aria-label="Pages per source"] li')] as HTMLElement[]

  it('the three japanesebuddy sources get unique labels that keep their distinguishing tail, in one row', async () => {
    const ids = ['japanesebuddy', 'japanesebuddy-dev-yordam-dl', 'japanesebuddy-main-dl']
    const syn = synoptic({
      sources: [{ id: 'projects', label: 'projects', state: 'healthy' as const, observedAt: AT, items: ids.map((id) => item(id)) }],
    })
    const diagram = buildDiagram(syn, sources(ids.map((id, i) => ({ id, pages: 30 - i, chunks: 60, lastSyncAt: AT }))))
    const host = await mount(createElement(LineProfile, { diagram }))
    const labels = lines(host).map((li) => (li.querySelector('[data-name-label]') as HTMLElement).textContent)
    expect(labels).toEqual(['japanesebuddy', '…dev-yordam-dl', '…main-dl'])
    expect(new Set(labels).size).toBe(3)
    // The full id is what the label stands for.
    expect(lines(host).map((li) => (li.querySelector('[data-name-label]') as HTMLElement).getAttribute('title'))).toEqual(ids)
    expect(lines(host).every((li) => li.style.getPropertyValue('--row') === '')).toBe(true)
  })
})

describe('track rails read their group', () => {
  const NOW = Date.parse(AT) + 8 * 60_000

  it('weights each rail by the group share of pages, and says the share on hover and in the accessible name', async () => {
    const host = await mount(diagramNode())
    const diagram = buildDiagram(fixture(), readingOf())
    const weight = (id: string) => Number(host.querySelector(`[data-group-track="${id}"]`)?.getAttribute('data-rail-weight'))
    const total = diagram.groups.reduce((sum, group) => sum + (group.totalPages ?? 0), 0)
    for (const group of diagram.groups) {
      expect(weight(group.id)).toBeCloseTo(railWeight((group.totalPages as number) / total), 5)
    }
    expect(weight('reference')).toBeGreaterThan(weight('projects'))
    expect(weight('curated')).toBe(2)
    const title = host.querySelector('[data-group-track="reference"] title')?.textContent ?? ''
    expect(title).toMatch(/\d+% of all pages/)
    expect(host.querySelector('[data-syn-id="group:reference"]')?.getAttribute('aria-label')).toMatch(/\d+% of all pages/)
    // Reader rails stay thin and neutral: not group tracks at all.
    expect(host.querySelectorAll('[data-group-track]')).toHaveLength(4)
  })

  it('draws the oldest sync age on the rail, neutral when nothing is stale, with a count of sources that have sync off', async () => {
    const host = await mount(diagramNode())
    const fresh = host.querySelector('[data-rail-labels="reference"] [data-rail-freshness]') as HTMLElement
    expect(fresh.getAttribute('data-rail-freshness')).toBe('fresh')
    expect(fresh.textContent).toMatch(/^(<1 min|\d+ (min|h|d))$/)
    expect(fresh.querySelector('[data-shape="triangle"]')).toBeNull()
    expect(host.querySelector('[data-rail-labels="projects"] [data-rail-off="1"]')?.textContent).toBe('1 off')
    expect(host.querySelector('[data-rail-labels="reference"] [data-rail-off]')).toBeNull()
  })

  it('marks a group with a stale source with a caution mark and amber text', async () => {
    const syn = fixture()
    const projects = syn.sources.find((group) => group.id === 'projects')!
    projects.items = projects.items.map((it) => (it.id === 'gbrain' ? { ...it, state: 'warning' as const, lastSyncAt: '2026-11-08T08:19:30.000Z' } : it))
    const host = await mount(diagramNode(syn))
    const stale = host.querySelector('[data-rail-labels="projects"] [data-rail-freshness]') as HTMLElement
    expect(stale.getAttribute('data-rail-freshness')).toBe('stale')
    expect(stale.querySelector('[data-shape="triangle"]')).not.toBeNull()
    expect(host.querySelector('[data-syn-id="group:projects"]')?.getAttribute('aria-label')).toMatch(/stale/)
  })

  it('computes weight, clamp and freshness as pure values', () => {
    expect(railWeight(0.25)).toBe(4)
    expect(railWeight(0.5)).toBe(8)
    expect(railWeight(0.01)).toBe(RAIL_MIN)
    expect(railWeight(0.9)).toBe(RAIL_MAX)
    expect(railWeight(null)).toBe(RAIL_MIN)
    const diagram = buildDiagram(fixture(), readingOf())
    const reference = diagram.groups.find((group) => group.id === 'reference')!
    expect(groupFreshness(reference, NOW)).toEqual({ label: '8 min', stale: false, unread: false, off: 0 })
    const projects = diagram.groups.find((group) => group.id === 'projects')!
    expect(groupFreshness(projects, NOW).off).toBe(1)
    expect(ageShort(3 * 3600_000)).toBe('3 h')
    expect(ageShort(30_000)).toBe('<1 min')
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
