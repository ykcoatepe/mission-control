import { describe, expect, it } from 'vitest'
import {
  buildBrainModel,
  collapseIncidents,
  currentNotes,
  deriveLinkExtraction,
  deriveReadings,
  deriveSourceSync,
  deriveVerdict,
  describeElement,
  describeIncident,
  fmtAge,
  fmtCount,
  groupBlockId,
  linkExtractionCondition,
  plainWords,
  readerBlockId,
  recentReadings,
} from './lib'
import { META, health, sources, synoptic } from './fixtures'
import type { GBrainSynoptic, TimelineEntry } from './types'

const AT = '2026-11-11T08:19:30.000Z'

function withStaleGroup(): GBrainSynoptic {
  const base = synoptic()
  return {
    ...base,
    state: 'warning',
    sources: [
      {
        id: 'projects',
        label: 'projects',
        state: 'warning',
        observedAt: AT,
        items: [
          { id: 'mission-control', label: 'mission-control', state: 'warning', observedAt: AT, lastSyncAt: AT, behind: 2, excludedByPolicy: null },
          { id: 'other', label: 'other', state: 'healthy', observedAt: AT, lastSyncAt: AT, behind: null, excludedByPolicy: null },
        ],
      },
      base.sources[1],
    ],
    edges: base.edges.map((edge) =>
      edge.from === 'mission-control' ? { ...edge, state: 'warning', measurement: { ...edge.measurement, value: 10800 } } : edge,
    ),
  }
}

describe('formatting never invents numbers', () => {
  it('shows a missing count as a dash, not zero', () => {
    expect(fmtCount(null)).toBe('—')
    expect(fmtCount(undefined)).toBe('—')
    expect(fmtCount(Number.NaN)).toBe('—')
    expect(fmtCount(0)).toBe('0')
    expect(fmtCount(63313)).toBe('63,313')
  })

  it('formats compact ages and refuses missing ones', () => {
    expect(fmtAge(30)).toBe('<1m')
    expect(fmtAge(275)).toBe('4m')
    expect(fmtAge(10800)).toBe('3h')
    expect(fmtAge(200000)).toBe('2d')
    expect(fmtAge(null)).toBe('—')
    expect(fmtAge(-5)).toBe('—')
  })

  it('replaces retired words in backend sentences', () => {
    expect(plainWords('Heartbeat proof is stale; 3 caveats')).toBe('Heartbeat reading is stale; 3 notes')
    expect(plainWords('Caveat: evidence missing')).toBe('Note: reading missing')
  })
})

describe('verdict', () => {
  it('is normal when everything read is healthy, and an unobserved reader connection is only a note', () => {
    const model = buildBrainModel(synoptic())
    const verdict = deriveVerdict(model, META)
    expect(verdict.state).toBe('healthy')
    expect(verdict.text).toBe('GBrain is normal')
    // ...but the reader is shown as not read, never as healthy.
    expect(model.states[readerBlockId('hermes')]).toBe('unavailable')
    expect(model.edges.find((e) => e.blockId === readerBlockId('hermes'))?.label).toBe('not read')
    const notes = currentNotes(verdict, model).map((n) => n.text)
    expect(notes.join(' ')).toContain('Reader connections are not observed')
  })

  it('names the specific condition for a stale source', () => {
    const model = buildBrainModel(withStaleGroup(), {
      sources: sources([{ id: 'mission-control', freshness: { status: 'warning' } }]),
    })
    const verdict = deriveVerdict(model, META)
    expect(verdict.state).toBe('warning')
    expect(verdict.text).toBe('GBrain needs attention: 1 source is stale')
    const edge = model.edges.find((e) => e.blockId === groupBlockId('projects'))
    expect(edge).toMatchObject({ state: 'warning', label: '3h · 2 behind' })
  })

  it('does not claim staleness it cannot show', () => {
    const model = buildBrainModel(withStaleGroup())
    expect(deriveVerdict(model, META).text).toBe('GBrain needs attention: 1 source is behind')
  })

  it('puts critical before warning and counts the rest', () => {
    const syn = withStaleGroup()
    syn.queue = { ...syn.queue, state: 'critical' }
    const verdict = deriveVerdict(buildBrainModel(syn), META)
    expect(verdict.state).toBe('critical')
    expect(verdict.text).toMatch(/^GBrain needs attention: .* \(and 1 more\)$/)
  })

  it('treats unread data as incomplete, never as normal', () => {
    const syn = synoptic()
    syn.core = {
      ...syn.core,
      state: 'unavailable',
      pages: { ...syn.core.pages, value: null, state: 'unavailable', observedAt: null },
      chunks: { ...syn.core.chunks, value: null, state: 'unavailable', observedAt: null },
    }
    const model = buildBrainModel(syn)
    const verdict = deriveVerdict(model, META)
    expect(verdict.state).toBe('unavailable')
    expect(verdict.text).toBe('GBrain readings are incomplete: GBrain core readings could not be read')
    expect(model.core.rows.find((r) => r.label === 'Pages')?.value).toBe('—')
  })

  it('is not normal when the reading itself is stale or missing', () => {
    const stale = deriveVerdict(buildBrainModel(synoptic()), { ...META, stale: true })
    expect(stale.state).toBe('warning')
    expect(stale.text).toContain('the last reading is stale')
    expect(deriveVerdict(null, null)).toMatchObject({ state: 'unavailable', text: 'GBrain could not be read' })
  })

  it('counts a reader whose own configuration is wrong', () => {
    const syn = synoptic()
    syn.readers[0] = { ...syn.readers[0], integration: { ...syn.readers[0].integration, configured: false, state: 'warning' } }
    expect(deriveVerdict(buildBrainModel(syn), META).text).toBe('GBrain needs attention: Hermes is not configured')
  })
})

describe('link extraction', () => {
  it('is not read when the health reading is missing or failed', () => {
    expect(deriveLinkExtraction(undefined)).toMatchObject({ value: null, state: 'unavailable' })
    expect(deriveLinkExtraction(null)).toMatchObject({ value: null, state: 'unavailable' })
    expect(deriveLinkExtraction(health({}, { ok: false }))).toMatchObject({ value: null, state: 'unavailable' })
    expect(deriveLinkExtraction(health({ stalePagesUnavailable: true }))).toMatchObject({ value: null, state: 'unavailable' })
    expect(deriveLinkExtraction(health({ stalePages: null, stalePagesOverdue: null }))).toMatchObject({ value: null, state: 'unavailable' })
  })

  it('separates overdue pages from pages still catching up', () => {
    expect(deriveLinkExtraction(health())).toMatchObject({ value: 'current', state: 'healthy' })
    expect(deriveLinkExtraction(health({ stalePages: 3, stalePagesOverdue: 0, stalePagesCatchingUp: 3 }))).toMatchObject({
      value: 'current',
      unit: '3 catching up',
      state: 'healthy',
    })
    expect(deriveLinkExtraction(health({ stalePages: 3, stalePagesOverdue: 3 }))).toMatchObject({ value: '3', unit: 'pages behind', state: 'warning' })
    expect(deriveLinkExtraction(health({ stalePages: 1, stalePagesOverdue: 1 }))).toMatchObject({ value: '1', unit: 'page behind' })
  })

  it('feeds the verdict only when it is not current', () => {
    expect(linkExtractionCondition(undefined)).toEqual([])
    expect(linkExtractionCondition(health())).toEqual([])
    expect(linkExtractionCondition(health({ stalePages: 1, stalePagesOverdue: 1 }))[0].text).toBe('1 page awaiting link extraction')
    expect(linkExtractionCondition(health({}, { ok: false }))[0].state).toBe('unavailable')
  })
})

describe('readings', () => {
  it('counts fresh sources of all and keeps the rest as a hint', () => {
    const syn = withStaleGroup()
    syn.sources[1].items[0] = { ...syn.sources[1].items[0], state: 'inactive', excludedByPolicy: true }
    const sync = deriveSourceSync(syn.sources)
    expect(sync.value).toBe('1 of 3')
    expect(sync.hint).toBe('1 stale · 1 excluded')
    expect(sync.state).toBe('warning')
  })

  it('reads unavailable sources as not read and never as fresh', () => {
    const syn = synoptic()
    syn.sources[0].state = 'unavailable'
    syn.sources[0].items = syn.sources[0].items.map((item) => ({ ...item, state: 'unavailable' }))
    const sync = deriveSourceSync(syn.sources)
    expect(sync.value).toBe('1 of 3')
    expect(sync.hint).toContain('2 not read')
    expect(sync.state).toBe('unavailable')
    expect(deriveSourceSync([])).toMatchObject({ value: null, state: 'unavailable' })
  })

  it('shows a null queue as a dash and an overdue embedding backlog as a warning', () => {
    const syn = synoptic()
    const readings = deriveReadings(syn, buildBrainModel(syn), health())
    expect(readings.queue.value).toBe(0)
    expect(readings.queue.state).toBe('healthy')

    const backlog = buildBrainModel(syn, { health: health({ missingEmbeddings: 5, missingEmbeddingsOverdue: 5 }) })
    expect(backlog.states.queue).toBe('warning')
    expect(backlog.conditions[0].text).toBe('5 chunks overdue for embedding')

    const unread = synoptic()
    unread.queue = { ...unread.queue, state: 'unavailable', waiting: { value: null, unit: 'jobs', state: 'unavailable', observedAt: null } }
    const r = deriveReadings(unread, buildBrainModel(unread), undefined)
    expect(r.queue.value).toBeNull()
    expect(r.queue.state).toBe('unavailable')
    expect(buildBrainModel(unread).edges.find((e) => e.blockId === 'queue')?.label).toBe('not read')
  })

  it('keeps quality null when it was not read', () => {
    const syn = synoptic()
    syn.core.quality = { ...syn.core.quality, value: null, state: 'unavailable', observedAt: null }
    expect(deriveReadings(syn, buildBrainModel(syn), undefined).quality).toEqual({ value: null, state: 'unavailable' })
  })
})

describe('element detail', () => {
  it('offers Retry failed syncs first for a stale group and only sync actions for a healthy one', () => {
    const syn = withStaleGroup()
    const model = buildBrainModel(syn)
    const stale = describeElement(groupBlockId('projects'), syn, model)
    expect(stale?.actionIds[0]).toBe('retry-failed-sync')
    expect(stale?.items.map((i) => i.id)).toEqual(['mission-control', 'other'])
    expect(stale?.items[0].note).toBe('2 behind')

    const healthy = describeElement(groupBlockId('reference'), syn, model)
    expect(healthy?.actionIds).toEqual(['preview-sync', 'sync-sources'])
  })

  it('offers the embed actions for the queue and no action for a reader', () => {
    const syn = synoptic()
    const model = buildBrainModel(syn)
    expect(describeElement('queue', syn, model)?.actionIds).toEqual(['embed-stale', 'embed-missing'])
    const reader = describeElement(readerBlockId('hermes'), syn, model)
    expect(reader?.actionIds).toEqual([])
    expect(reader?.rows.find((r) => r.label === 'Connection')?.value).toBe('not read')
    expect(reader?.notes.join(' ')).toContain('has not been shown to connect')
  })

  it('describes a line with its own reading and the actions of its block', () => {
    const syn = withStaleGroup()
    const model = buildBrainModel(syn)
    const edge = describeElement('edge:group:projects', syn, model)
    expect(edge?.title).toBe('projects to GBrain core')
    expect(edge?.rows[0]).toMatchObject({ label: 'Line', value: '3h · 2 behind' })
    expect(edge?.actionIds[0]).toBe('retry-failed-sync')
  })

  it('returns null for unknown elements and keeps unread core values as dashes', () => {
    const syn = synoptic()
    syn.core.chunks = { ...syn.core.chunks, value: null, state: 'unavailable', observedAt: null }
    const model = buildBrainModel(syn)
    expect(describeElement('group:nope', syn, model)).toBeNull()
    expect(describeElement('edge:nope', syn, model)).toBeNull()
    expect(describeElement('core', syn, model)?.rows.find((r) => r.label === 'Chunks')?.value).toBe('—')
  })
})

describe('recovered regressions', () => {
  const banner = (snapshotId: string, detail = '3 caveats at 2026-11-11T08:05:20.562Z.', kind = 'recent-regression') => ({
    title: 'Worst recent regression still needs acknowledgement',
    detail,
    snapshotId,
    kind,
  })

  it('collapses repeats, hides acknowledged ones and ignores non-regressions', () => {
    const list = [banner('a'), banner('a'), banner('b'), banner('c', 'x', 'current'), banner('d')]
    expect(collapseIncidents(list, new Set(['d'])).map((i) => i.key)).toEqual(['a', 'b'])
    expect(collapseIncidents(null, new Set())).toEqual([])
  })

  it('writes the incident in plain words with its time', () => {
    expect(describeIncident(banner('a'))).toEqual({ text: '3 notes', at: '2026-11-11T08:05:20.562Z' })
    expect(describeIncident(banner('a', 'queue 10 / 2 / 0'))).toEqual({ text: 'queue 10 / 2 / 0', at: null })
  })

  it('never lets history change the current verdict', () => {
    const model = buildBrainModel(synoptic())
    expect(deriveVerdict(model, META).state).toBe('healthy')
  })
})

describe('recent readings', () => {
  const entry = (id: string, status: TimelineEntry['trust']['status'], health: string | null, caveats = '0'): TimelineEntry => ({
    id,
    capturedAt: AT,
    trust: { label: 'x', status, score: status === 'healthy' ? 100 : null },
    metrics: { health, caveats },
    sourceFreshness: { status: 'healthy' },
    warnings: [],
  })

  it('describes changes and shows unread quality as not read', () => {
    const rows = recentReadings([entry('2', 'warning', null, '3'), entry('1', 'healthy', '100/100')])
    expect(rows[0]).toMatchObject({ state: 'warning', quality: 'not read' })
    expect(rows[0].headline).toContain('State Normal → Warning')
    expect(rows[1]).toMatchObject({ quality: '100/100', headline: 'No change' })
    expect(recentReadings(null)).toEqual([])

    const many = entry('9', 'warning', 'Unavailable', '3')
    many.metrics = { health: 'Unavailable', embeddings: 'Unavailable', queue: 'Unavailable', caveats: '3' }
    const before = entry('8', 'healthy', '100/100')
    before.metrics = { health: '100/100', embeddings: '100%', queue: '0 / 0 / 0', caveats: '0' }
    expect(recentReadings([many, before])[0].headline).toMatch(/^(.* · ){3}\+\d+ more$/)
    expect(recentReadings([entry('1', 'healthy', '100/100')], 0)).toEqual([])
  })
})
