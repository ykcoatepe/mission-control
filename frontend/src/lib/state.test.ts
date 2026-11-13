import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isAbnormal, stateLabel, stateShape, toUiState, worstState, type UiState } from './state'

describe('toUiState', () => {
  it.each([
    ['ok', 'healthy'],
    ['active', 'healthy'],
    ['running', 'healthy'],
    ['success', 'healthy'],
    ['done', 'healthy'],
    ['connected', 'healthy'],
    ['healthy', 'healthy'],
    ['fresh', 'healthy'],
    ['warning', 'warning'],
    ['stale', 'warning'],
    ['degraded', 'warning'],
    ['paused-by-error', 'warning'],
    ['blocked', 'warning'],
    ['overdue', 'warning'],
    ['failed', 'critical'],
    ['error', 'critical'],
    ['critical', 'critical'],
    ['down', 'critical'],
    ['unavailable', 'unavailable'],
    ['unknown', 'unavailable'],
    ['no-data', 'unavailable'],
    ['disabled', 'inactive'],
    ['paused', 'inactive'],
    ['off', 'inactive'],
    ['idle', 'inactive'],
    ['inactive', 'inactive'],
    ['archived', 'inactive'],
  ] as Array<[string, UiState]>)('maps %s to %s', (raw, expected) => {
    expect(toUiState(raw)).toBe(expected)
  })

  it('ignores case, padding, spaces and underscores', () => {
    expect(toUiState('  FAILED ')).toBe('critical')
    expect(toUiState('Paused_By_Error')).toBe('warning')
    expect(toUiState('no data')).toBe('unavailable')
  })

  it('maps the legacy health colours', () => {
    expect(toUiState('green')).toBe('healthy')
    expect(toUiState('yellow')).toBe('warning')
    expect(toUiState('red')).toBe('critical')
    expect(toUiState('gray')).toBe('unavailable')
  })

  it('maps unknown input to unavailable, never to an inactive look', () => {
    expect(toUiState('banana')).toBe('unavailable')
    expect(toUiState('')).toBe('unavailable')
    expect(toUiState(undefined)).toBe('unavailable')
    expect(toUiState(null)).toBe('unavailable')
    expect(toUiState(0)).toBe('unavailable')
    expect(toUiState({})).toBe('unavailable')
    expect(toUiState('constructor')).toBe('unavailable')
    expect(toUiState('__proto__')).toBe('unavailable')
  })
})

describe('stateLabel', () => {
  it('has a word for every state', () => {
    expect(stateLabel('healthy')).toBe('Normal')
    expect(stateLabel('warning')).toBe('Caution')
    expect(stateLabel('critical')).toBe('Critical')
    expect(stateLabel('unavailable')).toBe('Not read')
    expect(stateLabel('inactive')).toBe('Off')
  })
})

describe('stateShape', () => {
  it('gives every state its own shape (state is never colour alone)', () => {
    expect(stateShape('healthy')).toBe('circle')
    expect(stateShape('warning')).toBe('triangle')
    expect(stateShape('critical')).toBe('square')
    expect(stateShape('unavailable')).toBe('ring')
    expect(stateShape('inactive')).toBe('dash')
    expect(new Set(['healthy', 'warning', 'critical', 'unavailable', 'inactive'].map((s) => stateShape(s as UiState))).size).toBe(5)
  })

  it('only warning and critical are abnormal', () => {
    expect((['healthy', 'warning', 'critical', 'unavailable', 'inactive'] as UiState[]).filter(isAbnormal)).toEqual(['warning', 'critical'])
  })
})

describe('worstState', () => {
  it('returns critical over warning over unavailable over healthy over inactive', () => {
    expect(worstState(['healthy', 'critical', 'warning'])).toBe('critical')
    expect(worstState(['healthy', 'warning', 'unavailable'])).toBe('warning')
    expect(worstState(['healthy', 'unavailable'])).toBe('unavailable')
    expect(worstState(['inactive', 'healthy'])).toBe('healthy')
    expect(worstState(['inactive', 'inactive'])).toBe('inactive')
  })

  it('treats an empty list as unavailable, not healthy', () => {
    expect(worstState([])).toBe('unavailable')
  })

  it('returns the only element of a single-item list', () => {
    expect(worstState(['inactive'])).toBe('inactive')
  })
})

/**
 * The same static table the backend executes (tests/scrubAndStateFinal.test.js):
 * expected worstState for every ordered pair of states. Both sides run their
 * real implementation against it, so the two orderings cannot drift apart.
 */
describe('worstState agrees with the shared state-order fixture', () => {
  const fixture = JSON.parse(
    readFileSync(join(__dirname, '..', '..', '..', 'tests', 'fixtures', 'state-order.json'), 'utf8'),
  ) as { states: UiState[]; empty: UiState; pairs: [UiState, UiState, UiState][]; lists: [UiState[], UiState][] }

  it('covers every ordered pair of the five states', () => {
    expect(fixture.states).toHaveLength(5)
    expect(fixture.pairs).toHaveLength(25)
  })

  it.each(fixture.pairs)('worstState([%s, %s]) is %s', (a, b, worst) => {
    expect(worstState([a, b])).toBe(worst)
  })

  it.each(fixture.lists)('worstState(%j) is %s', (list, worst) => {
    expect(worstState(list)).toBe(worst)
  })

  it('an empty list is the fixture default', () => {
    expect(worstState([])).toBe(fixture.empty)
  })
})
