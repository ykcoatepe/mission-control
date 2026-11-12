import { describe, expect, it } from 'vitest'
import { buildDiagram, shortSourceName } from './diagram'
import { synoptic, sources } from './fixtures'
import { PROFILE_SCALE_PX, buildProfile, lineHeight } from './profile'
import type { GBrainSynoptic } from './types'

describe('line heights are on one true linear scale', () => {
  it('is proportional to pages, with the tallest at the full scale', () => {
    expect(lineHeight(18000, 18000)).toBe(PROFILE_SCALE_PX)
    expect(lineHeight(9000, 18000)).toBe(PROFILE_SCALE_PX / 2)
    expect(lineHeight(4500, 18000)).toBe(PROFILE_SCALE_PX / 4)
    // Doubling the pages doubles the height (to the pixel) while there is room: no log scale.
    expect(lineHeight(6000, 18000, 600)).toBe(2 * (lineHeight(3000, 18000, 600) as number))
  })

  it('gives a source too small to see a one-pixel line, never nothing and never a minimum bar', () => {
    expect(lineHeight(84, 18005)).toBe(1)
    expect(lineHeight(1, 18005)).toBe(1)
    expect(lineHeight(0, 18005)).toBe(0)
  })

  it('draws no line for pages that were not read', () => {
    expect(lineHeight(null, 18005)).toBeNull()
    expect(lineHeight(10, null)).toBeNull()
  })
})

function nineteen(): { syn: GBrainSynoptic; pages: Record<string, number> } {
  const base = synoptic()
  const pages: Record<string, number> = {}
  const groups = [
    ['reference', ['default', 'aviation-standards', 'a320-manuals']],
    ['projects', ['gstack-code', 'finance-analyzer', 'tk-a320-line-ops', 'portfolio-exporter', 'mission-control', 'tk-omc-ain', 'gbrain', 'pdfquickfix', 'japanesebuddy', 'extra-one', 'extra-two', 'extra-three']],
    ['agent-memory', ['hermes-agent', 'openclaw-memories', 'codex-memories']],
    ['curated', ['curated']],
  ] as const
  let n = 100
  const item = (id: string) => {
    pages[id] = (n += 137)
    return { id, label: id, state: id === 'tk-omc-ain' ? ('inactive' as const) : ('healthy' as const), observedAt: null, lastSyncAt: '2026-11-11T08:00:00.000Z', behind: null, excludedByPolicy: id === 'tk-omc-ain', reason: id === 'tk-omc-ain' ? 'sync disabled' : null }
  }
  return {
    syn: { ...base, sources: groups.map(([id, ids]) => ({ id, label: id, state: 'healthy' as const, observedAt: null, items: ids.map(item) })) },
    pages,
  }
}

describe('the profile follows the diagram', () => {
  it('has one line per source (19), in diagram order and with the largest source first in each group', () => {
    const { syn, pages } = nineteen()
    pages.default = 18005
    const reading = sources(Object.entries(pages).map(([id, count]) => ({ id, pages: count, chunks: count * 3, lastSyncAt: null })))
    const diagram = buildDiagram(syn, reading)
    const profile = buildProfile(diagram)
    expect(profile.lines).toHaveLength(19)
    expect(profile.lines.map((line) => line.full)).toEqual(diagram.sources.map((source) => source.id))
    expect(diagram.groups.map((group) => group.id)).toEqual(['reference', 'projects', 'agent-memory', 'curated'])
    const first = diagram.groups[1].sources.map((source) => source.pages ?? 0)
    expect(first).toEqual([...first].sort((a, b) => b - a))
    expect(profile.max).toBe(18005)
    expect(profile.lines.find((line) => line.full === 'default')?.height).toBe(PROFILE_SCALE_PX)
  })

  it('marks a source whose sync is off, and takes that from the server flag only', () => {
    const { syn, pages } = nineteen()
    const reading = sources(Object.entries(pages).map(([id, count]) => ({ id, pages: count })))
    const profile = buildProfile(buildDiagram(syn, reading))
    expect(profile.lines.filter((line) => line.syncOff).map((line) => line.full)).toEqual(['tk-omc-ain'])
  })

  it('colours a line by its group and leaves pages unread when the sources reading is missing', () => {
    const { syn } = nineteen()
    const diagram = buildDiagram(syn, null)
    expect(diagram.pagesUnread).toBe(true)
    const profile = buildProfile(diagram)
    expect(profile.max).toBeNull()
    expect(profile.lines.every((line) => line.height === null && line.percent === null)).toBe(true)
    expect([...new Set(profile.lines.map((line) => line.tone))]).toEqual(['reference', 'projects', 'agent', 'curated'])
  })

  it('shortens names to the first word, or two when the first is a prefix, and never lets two lines share a label', () => {
    expect(shortSourceName('gstack-code')).toBe('gstack')
    expect(shortSourceName('tk-a320-line-ops')).toBe('tk-a320')
    expect(shortSourceName('default')).toBe('default')
    const base = synoptic()
    const item = (id: string) => ({ id, label: id, state: 'healthy' as const, observedAt: null, lastSyncAt: null, behind: null, excludedByPolicy: false, reason: null })
    const syn = { ...base, sources: [{ id: 'projects', label: 'projects', state: 'healthy' as const, observedAt: null, items: [item('hermes-agent'), item('hermes-memories')] }] }
    const names = buildProfile(buildDiagram(syn, sources([{ id: 'hermes-agent', pages: 2 }, { id: 'hermes-memories', pages: 1 }]))).lines.map((line) => line.name)
    expect(names).toEqual(['hermes-agent', 'hermes-memories'])
  })
})
