import { describe, expect, it } from 'vitest'
import {
  SERIES_COLOR_COUNT,
  assignSeriesColors,
  assignStableSeriesColors,
  isModelColumnKey,
  isModelMetricKey,
  seriesColorToken,
} from './lib'

describe('assignSeriesColors', () => {
  it('gives every active model its own --series token and never a colour literal', () => {
    const models = ['a', 'b', 'c', 'd', 'e', 'f']
    const assignments = assignSeriesColors(models)
    expect(new Set(assignments.values()).size).toBe(6)
    for (const color of assignments.values()) expect(color).toMatch(/^var\(--chart-[1-6]\)$/)
  })

  it('keeps a model on its colour when the other active models change (period switch)', () => {
    const month = assignSeriesColors(['opus', 'gpt', 'qwen'])
    const week = assignSeriesColors(['qwen', 'opus', 'haiku'], month)
    expect(week.get('opus')).toBe(month.get('opus'))
    expect(week.get('qwen')).toBe(month.get('qwen'))
  })

  it('recycles the colour of a model that left the period for a newcomer', () => {
    const before = assignSeriesColors(['a', 'b', 'c'])
    const after = assignSeriesColors(['b', 'c', 'd'], before)
    expect(after.get('d')).toBe(before.get('a'))
    expect(after.has('a')).toBe(false)
  })

  it('treats model names case-insensitively and ignores blanks', () => {
    const assignments = assignSeriesColors(['Claude Opus', ' claude opus ', '', 'GPT'])
    expect(assignments.size).toBe(2)
    expect(assignments.get('claude opus')).toBeDefined()
  })

  it('never hands out the reserved sixth token when the pool is limited to five', () => {
    const previous = new Map([['legacy', seriesColorToken(SERIES_COLOR_COUNT - 1)]])
    const assignments = assignSeriesColors(['legacy', 'a', 'b', 'c', 'd'], previous, 5)
    expect(Array.from(assignments.values())).not.toContain(seriesColorToken(5))
    expect(new Set(assignments.values()).size).toBe(5)
  })

  it('reuses tokens deterministically instead of inventing colours when models outnumber tokens', () => {
    const assignments = assignSeriesColors(Array.from({ length: 8 }, (_, i) => `m${i}`))
    expect(assignments.size).toBe(8)
    for (const color of assignments.values()) expect(color).toMatch(/^var\(--chart-[1-6]\)$/)
  })
})

describe('assignStableSeriesColors', () => {
  it('keeps every model on one colour across Month, Day, 7 days and back', () => {
    const month = assignStableSeriesColors(['opus', 'sonnet', 'fable', 'sol'])
    const day = assignStableSeriesColors(['astra', 'opus', 'sonnet'], month.memory)
    const week = assignStableSeriesColors(['sol', 'astra', 'opus'], day.memory)
    const back = assignStableSeriesColors(['opus', 'sonnet', 'fable', 'sol'], week.memory)

    for (const model of ['opus', 'sonnet']) expect(day.assignments.get(model)).toBe(month.assignments.get(model))
    expect(week.assignments.get('sol')).toBe(month.assignments.get('sol'))
    expect(week.assignments.get('astra')).toBe(day.assignments.get('astra'))
    expect(Array.from(back.assignments.entries())).toEqual(Array.from(month.assignments.entries()))
  })

  it('does not hand a newcomer the colour of a model that is only absent from this view', () => {
    const month = assignStableSeriesColors(['a', 'b', 'c'])
    const day = assignStableSeriesColors(['d'], month.memory)
    expect(Array.from(month.assignments.values())).not.toContain(day.assignments.get('d'))
  })

  it('still reuses a colour once every token is remembered, and never invents a literal', () => {
    const all = Array.from({ length: 6 }, (_, i) => `m${i}`)
    const first = assignStableSeriesColors(all)
    const next = assignStableSeriesColors(['newcomer'], first.memory)
    expect(next.assignments.get('newcomer')).toMatch(/^var\(--chart-[1-6]\)$/)
  })

  it('keeps colours distinct between the models of one view', () => {
    const first = assignStableSeriesColors(['a', 'b', 'c', 'd', 'e'])
    const second = assignStableSeriesColors(['f', 'g', 'a', 'b'], first.memory)
    expect(new Set(second.assignments.values()).size).toBe(4)
  })
})

describe('model column classification', () => {
  it('never treats reasoning (or any other per-model metric) as a model, so it reserves no colour', () => {
    for (const metric of ['tokens', 'input', 'output', 'reasoning', 'cacheRead', 'cacheWrite', 'costSource', 'apiEquivalentUsd', 'apiEquivalentStatus']) {
      expect(isModelMetricKey(`gpt-5.6_${metric}`)).toBe(true)
      expect(isModelColumnKey(`gpt-5.6_${metric}`)).toBe(false)
    }
  })

  it('does not treat daily totals as models, but does keep real model columns', () => {
    for (const total of ['date', 'models', 'totalCost', 'apiEquivalentCost', 'totalTokens']) {
      expect(isModelColumnKey(total)).toBe(false)
    }
    expect(isModelColumnKey('Claude Code / claude-fable-5')).toBe(true)
    expect(isModelColumnKey('Qwen3.6')).toBe(true)
  })
})

describe('the chart ramp is its own', () => {
  it('draws every series from --chart-* and never from a source-group line colour, the accent, a state colour or the Brain series', () => {
    const tokens = Array.from({ length: SERIES_COLOR_COUNT + 3 }, (_, slot) => seriesColorToken(slot))
    for (const token of tokens) {
      expect(token).toMatch(/^var\(--chart-[1-6]\)$/)
      expect(token).not.toMatch(/--line-|--accent|--state-|--series-/)
    }
    expect(new Set(tokens.slice(0, SERIES_COLOR_COUNT)).size).toBe(SERIES_COLOR_COUNT)
  })
})
