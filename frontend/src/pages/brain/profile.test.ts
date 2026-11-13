import { describe, expect, it } from 'vitest'
import { buildDiagram, shortSourceName } from './diagram'
import { synoptic, sources } from './fixtures'
import { PROFILE_SCALE_PX, axisTicks, buildProfile, lineHeight, middleTruncate, shortLabels, sourceLabels, visibleCounts, visibleLabels, coveredLabels, crowdedTicks, boxesTouch } from './profile'
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

describe('the profile is tall enough to read', () => {
  it('has a plot at least 140px tall for the tallest line', () => {
    expect(PROFILE_SCALE_PX).toBeGreaterThanOrEqual(140)
  })
})

describe('labels are the full source id, never two alike', () => {
  it('keeps a short id whole and cuts a long one in the middle, keeping its start and its end', () => {
    expect(middleTruncate('default')).toBe('default')
    const cut = middleTruncate('japanesebuddy-notes-archive-2026')
    expect(cut.length).toBeLessThanOrEqual(22)
    expect(cut.startsWith('japanesebuddy')).toBe(true)
    expect(cut.endsWith('2026')).toBe(true)
    expect(cut).toContain('…')
  })

  it('writes in full any labels that would come out the same after cutting', () => {
    const ids = ['japanesebuddy-alpha-study-notes', 'japanesebuddy-bravo-study-notes', 'japanesebuddy-charlie-study-notes', 'default']
    expect(new Set(ids.map((id) => middleTruncate(id))).size).toBe(1 + 1)
    const labels = sourceLabels(ids)
    expect(new Set(labels).size).toBe(ids.length)
    expect(labels.slice(0, 3)).toEqual(ids.slice(0, 3))
    expect(labels[3]).toBe('default')
  })

  it('the profile labels are unique even when the ids share a long start', () => {
    const base = synoptic()
    const ids = ['japanesebuddy-study-notes', 'japanesebuddy-study-cards', 'japanesebuddy-study-audio']
    const item = (id: string) => ({ id, label: id, state: 'healthy' as const, observedAt: null, lastSyncAt: null, behind: null, excludedByPolicy: false, reason: null })
    const syn = { ...base, sources: [{ id: 'projects', label: 'projects', state: 'healthy' as const, observedAt: null, items: ids.map(item) }] }
    const profile = buildProfile(buildDiagram(syn, sources(ids.map((id, i) => ({ id, pages: 10 + i })))))
    const names = profile.lines.map((line) => line.name)
    expect(new Set(names).size).toBe(3)
    expect(profile.lines.map((line) => line.full).sort()).toEqual([...ids].sort())
  })
})

describe('counts that would collide are left out of the picture', () => {
  const text = (pages: number | null) => (pages === null ? 'not read' : pages.toLocaleString('en-US'))
  const line = (id: string, pages: number | null, height: number | null) => ({ id, pages, height })

  it('shows every count when the columns are wide, or the width is not known', () => {
    const lines = [line('a', 18005, 140), line('b', 16190, 126), line('c', 8223, 64)]
    expect([...visibleCounts(lines, 60, text)]).toEqual(['a', 'b', 'c'])
    expect(visibleCounts(lines, null, text).size).toBe(3)
  })

  it('hides the smaller of two neighbouring counts that overlap, and keeps the larger', () => {
    const lines = [line('a', 1234, 10), line('b', 956, 8), line('c', 712, 6)]
    const shown = visibleCounts(lines, 30, text)
    expect(shown.has('a')).toBe(true)
    expect(shown.has('b')).toBe(false)
    // c is two columns from a, far enough apart to stand clear of it.
    expect(shown.has('c')).toBe(true)
  })

  it('does not hide counts that are at different heights', () => {
    const lines = [line('a', 18005, 140), line('b', 3237, 25)]
    expect(visibleCounts(lines, 30, text).size).toBe(2)
  })
})

describe('short labels', () => {
  const ids19 = [
    'default', 'aviation-standards', 'a320-manuals', 'gstack-code-github-com-garrytan', 'finance-analyzer', 'tk-a320-line-ops',
    'portfolio-exporter', 'mission-control', 'tk-omc-ain', 'codeforge-powerlaw-trader', 'trader-assistant', 'gbrain', 'pdfquickfix',
    'japanesebuddy', 'japanesebuddy-dev-yordam-dl', 'japanesebuddy-main-dl', 'hermes-agent', 'openclaw-memories', 'codex-memories',
  ]

  it('strips generic tails and keeps the distinguishing words, the same way every time', () => {
    const labels = shortLabels(ids19)
    expect(labels[ids19.indexOf('gstack-code-github-com-garrytan')]).toBe('gstack')
    expect(labels[ids19.indexOf('tk-a320-line-ops')]).toBe('tk-a320')
    expect(labels[ids19.indexOf('aviation-standards')]).toBe('aviation')
    expect(labels[ids19.indexOf('hermes-agent')]).toBe('hermes')
    expect(shortLabels(ids19)).toEqual(labels)
  })

  it('never gives two sources one label, and every label stays short unless it is the last resort', () => {
    const labels = shortLabels(ids19)
    expect(new Set(labels).size).toBe(ids19.length)
    expect(labels.every((label) => label.length <= 19)).toBe(true)
    // Clashes: the three japanesebuddy ids are told apart by their own words or the middle cut.
    const jp = labels.filter((_, i) => ids19[i].startsWith('japanesebuddy'))
    expect(new Set(jp).size).toBe(3)
    expect(shortLabels(['abcdefghijklmnopqrstuvwxyz1', 'abcdefghijklmnopqrstuvwxyz2'])).toHaveLength(2)
    expect(new Set(shortLabels(['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2'])).size).toBe(2)
  })

  it('tells ids that share a start apart by their own tail, not by a cut that leaves them all alike', () => {
    const labels = shortLabels(ids19)
    const at = (id: string) => labels[ids19.indexOf(id)]
    expect(at('japanesebuddy')).toBe('japanesebuddy')
    expect(at('japanesebuddy-dev-yordam-dl')).toBe('…dev-yordam-dl')
    expect(at('japanesebuddy-main-dl')).toBe('…main-dl')
    // Without a shorter id to carry the shared start, the leading words are kept.
    expect(shortLabels(['hermes-agent', 'hermes-memories'])).toEqual(['hermes-agent', 'hermes-memories'])
    // A tail too long to fit is cut, still unique.
    const long = shortLabels(['alpha', 'alpha-' + 'x'.repeat(40) + '-one', 'alpha-' + 'x'.repeat(40) + '-two'])
    expect(new Set(long).size).toBe(3)
    expect(long.every((label) => label.length <= 19)).toBe(true)
  })

  it('draws labels in one row: a label that would touch a bigger source\'s label is left out, never put on a second row', () => {
    const line = (id: string, name: string, pages: number) => ({ id, name, pages })
    const lines = [line('a', 'aviation', 100), line('b', 'a320', 50), line('c', 'japanesebuddy', 3), line('d', '…dev-yordam-dl', 2), line('e', '…main-dl', 1)]
    // Wide columns: nothing is left out. Unknown width: nothing is left out.
    expect(visibleLabels(lines, 200).size).toBe(5)
    expect(visibleLabels(lines, null).size).toBe(5)
    // Narrow columns: the bigger source keeps its label; neighbours that would touch it lose theirs.
    const kept = visibleLabels(lines, 40)
    expect(kept.has('a')).toBe(true)
    expect(kept.size).toBeLessThan(5)
    // No two kept labels touch (centres 40px apart, estimated widths).
    const centres = lines.map((l, i) => ({ id: l.id, x: (i + 0.5) * 40, w: l.name.length * 6 })).filter((box) => kept.has(box.id))
    for (let i = 0; i < centres.length; i += 1) for (let j = i + 1; j < centres.length; j += 1) expect(Math.abs(centres[i].x - centres[j].x)).toBeGreaterThanOrEqual((centres[i].w + centres[j].w) / 2)
    // Measured widths win over the estimate.
    expect(visibleLabels(lines.slice(0, 2), 40, { a: 10, b: 10 }).size).toBe(2)
    expect(visibleLabels(lines.slice(0, 2), 40, { a: 80, b: 10 }).size).toBe(1)
  })

  it('puts away exactly the labels that touch the enlarged one, from measured boxes', () => {
    const box = (left: number, right: number, top = 229, bottom = 245) => ({ left, right, top, bottom })
    const cover = box(100, 200, 227, 247)
    const away = coveredLabels(cover, [
      { id: 'near-left', box: box(60, 105) },
      { id: 'near-right', box: box(195, 240) },
      { id: 'inside', box: box(120, 160) },
      { id: 'clear-left', box: box(20, 90) },
      { id: 'clear-right', box: box(210, 260) },
      { id: 'other-row', box: box(120, 160, 300, 316) },
    ])
    expect([...away].sort()).toEqual(['inside', 'near-left', 'near-right'])
    expect(boxesTouch(box(0, 10), box(10, 20))).toBe(false)
    expect(coveredLabels(cover, [])).toEqual(new Set())
  })

  it('puts away only the scale values that sit on the marker of the looked-at line', () => {
    const ticks = axisTicks(18032)
    expect(crowdedTicks(ticks, 18032, 200)).toEqual(new Set())
    // 5,000 sits at 55px, 10,000 at 111px, 15,000 at 166px.
    expect(crowdedTicks(ticks, 18032, 60)).toEqual(new Set([5000]))
    expect(crowdedTicks(ticks, 18032, 1)).toEqual(new Set([0]))
    expect(crowdedTicks(ticks, 18032, null)).toEqual(new Set())
    expect(crowdedTicks([], null, 10)).toEqual(new Set())
  })

  it('draws round axis ticks from zero up to the tallest line', () => {
    expect(axisTicks(18032)).toEqual([0, 5000, 10000, 15000])
    expect(axisTicks(84)).toEqual([0, 20, 40, 60, 80])
    expect(axisTicks(null)).toEqual([])
  })
})
