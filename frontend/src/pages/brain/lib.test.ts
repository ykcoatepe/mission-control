import { describe, expect, it } from 'vitest'
import {
  alignWithVerdict,
  buildBrainModel,
  collapseIncidents,
  currentNotes,
  deriveLinkExtraction,
  deriveReadings,
  deriveSourceSync,
  deriveVerdict,
  describeElement,
  describeLookupFailure,
  describeIncident,
  fmtAge,
  fmtCount,
  groupBlockId,
  plainWords,
  readerBlockId,
  reasonsForBlock,
  recentReadings,
} from './lib'
import { ApiError } from '../../lib/hooks'
import { META, health, minimalSynoptic, synoptic, verdictOf, withVerdict } from './fixtures'
import type { GBrainSynoptic, TimelineEntry } from './types'

const AT = '2026-11-11T08:19:30.000Z'

function withStaleGroup(): GBrainSynoptic {
  const base = synoptic()
  return {
    ...base,
    state: 'warning',
    verdict: verdictOf({ elementId: 'mission-control', state: 'warning', text: 'mission-control: source evidence is stale.' }),
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
  it('is normal with a healthy configured reader, which is a quiet block with the payload line label', () => {
    const syn = synoptic()
    const model = buildBrainModel(syn)
    const verdict = deriveVerdict(syn, META)
    expect(verdict.state).toBe('healthy')
    expect(verdict.text).toBe('GBrain is normal')
    expect(model.states[readerBlockId('hermes')]).toBe('healthy')
    expect(model.readers[0].sub).toBe('configured')
    expect(model.edges.find((e) => e.blockId === readerBlockId('hermes'))).toMatchObject({ state: 'healthy', label: 'configured' })
    expect(verdict.conditions).toEqual([])
  })

  it('shows the readers note once in Notes and no old workaround', () => {
    const syn = synoptic()
    const notes = currentNotes(deriveVerdict(syn, META), [], syn.readersNote).map((n) => n.text)
    expect(notes).toEqual(['Connection telemetry is not observable locally.'])
    expect(currentNotes(deriveVerdict(syn, META), [], undefined)).toEqual([])
  })

  it('is the payload verdict: same state, first reason as the sentence, the rest counted', () => {
    const syn = withVerdict(
      synoptic(),
      { elementId: 'queue', state: 'warning', text: 'Queue requires attention.' },
      { elementId: 'hermes', state: 'unavailable', text: 'Hermes: integration unavailable.' },
      { elementId: 'gbrain.health', state: 'critical', text: 'GBrain core requires attention (quality 40).' },
    )
    const verdict = deriveVerdict(syn, META)
    // The server ranks a failed reading above critical and warning; the page keeps that order.
    expect(verdict.state).toBe('unavailable')
    expect(verdict.state).toBe(syn.verdict?.state)
    expect(verdict.state).toBe(syn.state)
    expect(verdict.text).toBe('GBrain readings are incomplete: Hermes: integration unavailable (and 2 more)')
    expect(verdict.conditions.map((c) => c.id)).toEqual(['hermes', 'gbrain.health', 'queue'])

    const critical = withVerdict(synoptic(), syn.verdict!.reasons[0], syn.verdict!.reasons[2])
    expect(deriveVerdict(critical, META)).toMatchObject({ state: 'critical', text: 'GBrain needs attention: GBrain core requires attention (quality 40) (and 1 more)' })
  })

  it('uses the incomplete wording only when the payload verdict is unavailable', () => {
    const syn = withVerdict(synoptic(), { elementId: 'embed-job-probe', state: 'unavailable', text: 'Embed-job probe unavailable; the missing-embedding verdict uses embedding age only.' })
    expect(deriveVerdict(syn, META)).toMatchObject({
      state: 'unavailable',
      text: 'GBrain readings are incomplete: Embed-job probe unavailable; the missing-embedding verdict uses embedding age only',
    })
  })

  it('never derives a second verdict from the blocks: a lit block under a healthy payload verdict stays healthy', () => {
    const syn = synoptic()
    syn.readers[0] = { ...syn.readers[0], state: 'critical' }
    syn.queue = { ...syn.queue, state: 'warning' }
    expect(deriveVerdict(syn, META)).toMatchObject({ state: 'healthy', text: 'GBrain is normal' })
  })

  it('lists inactive reasons but they never degrade the verdict', () => {
    const syn = withVerdict(synoptic(), { elementId: 'off', state: 'inactive', text: 'off: sync disabled.' })
    const verdict = deriveVerdict(syn, META)
    expect(verdict).toMatchObject({ state: 'healthy', text: 'GBrain is normal' })
    expect(verdict.conditions).toEqual([{ id: 'off', state: 'inactive', text: 'off: sync disabled' }])
    expect(currentNotes(verdict, [], undefined).map((n) => n.state)).toEqual(['inactive'])
  })

  it('does not trust a payload with no verdict, and does not repair it', () => {
    const syn = { ...synoptic(), verdict: undefined }
    expect(deriveVerdict(syn, META)).toMatchObject({ state: 'unavailable', text: 'GBrain did not report a verdict' })
    expect(deriveVerdict({ verdict: { state: 'fine', reasons: [] } } as unknown as GBrainSynoptic, META).state).toBe('unavailable')
    expect(deriveVerdict(null, null)).toMatchObject({ state: 'unavailable', text: 'GBrain could not be read' })
  })

  it('treats unread data as incomplete, never as normal', () => {
    const syn = minimalSynoptic()
    const verdict = deriveVerdict(syn, META)
    expect(verdict.state).toBe('unavailable')
    expect(verdict.text).toBe('GBrain readings are incomplete: GBrain core reading unavailable')
    expect(buildBrainModel(syn).core.rows.find((r) => r.label === 'Pages')?.value).toBe('—')
  })

  it('shows a healthy verdict on a stale reading as caution, the rule the top bar uses', () => {
    const stale = deriveVerdict(synoptic(), { ...META, stale: true })
    expect(stale.state).toBe('warning')
    expect(stale.text).toBe('GBrain needs attention: the last reading is stale')
    // An unhealthy verdict keeps the payload's own state on a stale reading.
    expect(deriveVerdict(withStaleGroup(), { ...META, stale: true }).state).toBe('warning')
    expect(deriveVerdict(minimalSynoptic(), { ...META, stale: true }).state).toBe('unavailable')
  })

  it('names the specific stale source from the payload, and the line keeps its own reading', () => {
    const syn = withStaleGroup()
    const verdict = deriveVerdict(syn, META)
    expect(verdict.state).toBe('warning')
    expect(verdict.text).toBe('GBrain needs attention: mission-control: source evidence is stale')
    const edge = buildBrainModel(syn).edges.find((e) => e.blockId === groupBlockId('projects'))
    expect(edge).toMatchObject({ state: 'warning', label: '3h · 2 behind' })
  })
})

describe('the readings strip cannot disagree with the verdict', () => {
  it('a reading may not be lit under a healthy verdict, nor critical under a warning one', () => {
    expect(alignWithVerdict('warning', 'healthy')).toBe('healthy')
    expect(alignWithVerdict('critical', 'healthy')).toBe('healthy')
    expect(alignWithVerdict('critical', 'warning')).toBe('warning')
    expect(alignWithVerdict('critical', 'critical')).toBe('critical')
    // A failed reading outranks everything in the server's verdict.
    expect(alignWithVerdict('critical', 'unavailable')).toBe('critical')
    expect(alignWithVerdict('warning', 'unavailable')).toBe('warning')
    expect(alignWithVerdict('warning', 'critical')).toBe('warning')
    // Not read is not an alarm, and it is never turned green.
    expect(alignWithVerdict('unavailable', 'healthy')).toBe('unavailable')
    expect(alignWithVerdict('inactive', 'healthy')).toBe('inactive')
  })

  it('shows the link extraction backlog with its figure but not a colour the verdict does not have', () => {
    const syn = synoptic()
    const behind = health({ stalePages: 3, stalePagesOverdue: 3 })
    const quiet = deriveReadings(syn, buildBrainModel(syn), behind, deriveVerdict(syn, META).state)
    expect(quiet.linkExtraction).toMatchObject({ value: '3', unit: 'pages behind', state: 'healthy' })

    const warn = withVerdict(synoptic(), { elementId: 'stale-pages', state: 'warning', text: 'Stale pages need link extraction.' })
    const lit = deriveReadings(warn, buildBrainModel(warn), behind, deriveVerdict(warn, META).state)
    expect(lit.linkExtraction).toMatchObject({ value: '3', state: 'warning' })
  })

  it('takes the queue state from the payload alone: the health reading adds figures, not an opinion', () => {
    const syn = synoptic()
    const model = buildBrainModel(syn)
    expect(model.states.queue).toBe('healthy')
    const readings = deriveReadings(syn, model, health({ missingEmbeddings: 5, missingEmbeddingsOverdue: 5, queue: { waiting: 0, active: 0, stalled: 2 } }), 'healthy')
    expect(readings.queue.state).toBe('healthy')
  })

  it('every reading state is within what the verdict allows, for every verdict state', () => {
    const rank = { healthy: 0, inactive: 0, warning: 2, critical: 3 } as const
    const allowed = { healthy: 0, inactive: 0, warning: 2, critical: 3, unavailable: 3 } as const
    for (const verdictState of ['healthy', 'warning', 'critical', 'unavailable', 'inactive'] as const) {
      const syn = withStaleGroup()
      syn.core.quality = { ...syn.core.quality, state: 'critical' }
      const readings = deriveReadings(syn, buildBrainModel(syn), health({ stalePages: 2, stalePagesOverdue: 2 }), verdictState)
      for (const reading of [readings.quality, readings.sourceSync, readings.linkExtraction, readings.queue]) {
        if (reading.state === 'warning' || reading.state === 'critical') {
          expect(rank[reading.state], `${verdictState}: ${reading.state}`).toBeLessThanOrEqual(allowed[verdictState])
        }
      }
    }
  })
})

describe('reasons per block', () => {
  it('attach the payload reasons to the block they are about', () => {
    const syn = withVerdict(
      synoptic(),
      { elementId: 'mission-control', state: 'warning', text: 'mission-control: source evidence is stale.' },
      { elementId: 'queue', state: 'warning', text: 'Queue requires attention.' },
      { elementId: 'hermes', state: 'inactive', text: 'Hermes: integration not configured.' },
      { elementId: 'gbrain-core', state: 'warning', text: 'GBrain core requires attention (quality 80).' },
    )
    expect(reasonsForBlock(groupBlockId('projects'), syn).map((r) => r.elementId)).toEqual(['mission-control'])
    expect(reasonsForBlock(groupBlockId('reference'), syn)).toEqual([])
    expect(reasonsForBlock('queue', syn).map((r) => r.elementId)).toEqual(['queue'])
    expect(reasonsForBlock(readerBlockId('hermes'), syn).map((r) => r.elementId)).toEqual(['hermes'])
    expect(reasonsForBlock('core', syn).map((r) => r.elementId)).toEqual(['gbrain-core'])
    expect(describeElement('queue', syn, buildBrainModel(syn))?.notes).toEqual(['Queue requires attention.'])
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
    const readings = deriveReadings(syn, buildBrainModel(syn), health(), 'healthy')
    expect(readings.queue.value).toBe(0)
    expect(readings.queue.state).toBe('healthy')

    const unread = synoptic()
    unread.queue = { ...unread.queue, state: 'unavailable', waiting: { value: null, unit: 'jobs', state: 'unavailable', observedAt: null } }
    const r = deriveReadings(unread, buildBrainModel(unread), undefined, 'unavailable')
    expect(r.queue.value).toBeNull()
    expect(r.queue.state).toBe('unavailable')
    expect(buildBrainModel(unread).edges.find((e) => e.blockId === 'queue')?.label).toBe('not read')
  })

  it('keeps quality null when it was not read', () => {
    const syn = synoptic()
    syn.core.quality = { ...syn.core.quality, value: null, state: 'unavailable', observedAt: null }
    expect(deriveReadings(syn, buildBrainModel(syn), undefined, 'unavailable').quality).toEqual({ value: null, state: 'unavailable' })
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
    expect(reader?.rows.find((r) => r.label === 'Configuration')?.value).toBe('configured')
    expect(reader?.rows.find((r) => r.label === 'Connection')).toBeUndefined()
    expect(reader?.notes).toEqual([])
    const line = describeElement('edge:reader:hermes', syn, model)
    expect(line?.rows[0]).toMatchObject({ label: 'Line', value: 'configured', state: 'healthy' })
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

describe('optional fields never crash the page', () => {
  /** The same payload with every optional object removed. */
  const stripped = (): GBrainSynoptic => {
    const syn = synoptic()
    return {
      ...syn,
      core: { state: syn.core.state, observedAt: syn.core.observedAt },
      queue: { state: syn.queue.state, observedAt: syn.queue.observedAt },
      readers: syn.readers.map(({ id, label, state, observedAt }) => ({ id, label, state, observedAt })),
      sources: syn.sources.map((group) => ({
        ...group,
        items: group.items.map(({ id, label, state, observedAt }) => ({ id, label, state, observedAt })),
      })),
      edges: syn.edges.map(({ from, to, state, label, observedAt }) => ({ from, to, state, label, observedAt })) as GBrainSynoptic['edges'],
      sourcesState: undefined,
      readersState: undefined,
      readersNote: undefined,
    }
  }

  for (const [name, make] of [
    ['a minimal payload', minimalSynoptic],
    ['a payload without any optional object', stripped],
  ] as const) {
    it(`builds the model, readings, verdict, notes and every detail from ${name}`, () => {
      const syn = make()
      const model = buildBrainModel(syn)
      const readings = deriveReadings(syn, model, undefined, 'unavailable')
      expect(readings.quality.value).toBeNull()
      expect(readings.queue.value).toBeNull()
      const verdict = deriveVerdict(syn, META)
      expect(['healthy', 'unavailable']).toContain(verdict.state)
      expect(() => currentNotes(verdict, [], syn.readersNote)).not.toThrow()
      expect(model.core.rows.map((r) => r.value)).toEqual(['—', '—', '—'])
      expect(model.core.sub).toBe('version not read')
      const ids = [
        'core',
        'queue',
        ...model.readers.map((b) => b.id),
        ...model.groups.map((b) => b.id),
        ...model.edges.map((e) => e.id),
      ]
      for (const id of ids) {
        const detail = describeElement(id, syn, model)
        expect(detail, id).not.toBeNull()
        for (const row of detail?.rows ?? []) expect(typeof row.value).toBe('string')
      }
      expect(describeElement('core', syn, model)?.rows.every((r) => r.value === '—')).toBe(true)
    })
  }

  it('reads missing measurements as not read, never as normal', () => {
    const model = buildBrainModel(minimalSynoptic())
    expect(deriveVerdict(minimalSynoptic(), META).state).toBe('unavailable')
    expect(model.edges.find((e) => e.blockId === 'queue')).toMatchObject({ label: 'not read', state: 'unavailable' })
    expect(model.edges.find((e) => e.blockId === readerBlockId('hermes'))).toMatchObject({ label: 'not read', state: 'unavailable' })
    expect(model.readers[0].sub).toBe('not read')
  })

  it('keeps null optional fields on sources and health from crashing', () => {
    const syn = stripped()
    expect(describeElement(groupBlockId('projects'), syn, buildBrainModel(syn), { sources: null, health: undefined })?.items).toHaveLength(2)
    expect(deriveSourceSync(syn.sources).value).toBe('2 of 3')
    const bare = { ok: true, meta: META }
    expect(deriveLinkExtraction(bare)).toMatchObject({ state: 'unavailable' })
    expect(buildBrainModel(syn).states.queue).toBeDefined()
    expect(describeElement('queue', syn, buildBrainModel(syn), { health: bare, sources: { meta: META } })).not.toBeNull()
  })

  it('reads timeline entries with no metrics or score', () => {
    const bare = { id: 'x', capturedAt: AT, trust: { label: '', status: 'healthy', score: null }, metrics: {}, sourceFreshness: { status: 'healthy' }, warnings: [] } as TimelineEntry
    expect(recentReadings([bare])[0]).toMatchObject({ quality: 'not read' })
    expect(() => recentReadings([{ ...bare, metrics: undefined, sourceFreshness: undefined, warnings: undefined } as unknown as TimelineEntry, bare])).not.toThrow()
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
    expect(deriveVerdict(synoptic(), META).state).toBe('healthy')
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

describe('lookup failures', () => {
  it('429 is "busy, try again" and honours Retry-After, not a broken brain', () => {
    const busy = new ApiError({ status: 429, code: 'lane_busy', message: 'busy', retryAfterMs: 3000 })
    expect(describeLookupFailure(busy, 'Search')).toEqual({
      kind: 'busy',
      title: 'Search is busy',
      message: 'The server is busy, try again in 3 seconds.',
    })
    expect(describeLookupFailure(busy, 'This page')).toMatchObject({ kind: 'busy', title: 'The page is busy' })
    expect(describeLookupFailure(new ApiError({ status: 429, code: 'x', message: 'x' }), 'Search').message).toBe(
      'The server is busy, try again in a moment.',
    )
  })

  it('503 is "not available" with the server reason', () => {
    const down = new ApiError({ status: 503, code: 'gbrain_lane_quarantined', message: 'Lookup lane is quarantined' })
    expect(describeLookupFailure(down, 'Search')).toEqual({
      kind: 'unavailable',
      title: 'Search is not available',
      message: 'Lookup lane is quarantined',
    })
  })

  it('anything else is an error with the server message, or a plain fallback', () => {
    expect(describeLookupFailure(new ApiError({ status: 400, code: 'invalid_query', message: 'q must be 1-300 characters' }), 'Search')).toMatchObject({
      kind: 'error',
      message: 'q must be 1-300 characters',
    })
    expect(describeLookupFailure(null, 'This page')).toMatchObject({ kind: 'error', title: 'This page could not be read' })
  })
})
