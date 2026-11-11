import { describe, expect, it } from 'vitest'
import { describeJobText, describeRunKind, failureReason, isInternalKey } from './jobWords'

describe('describeRunKind', () => {
  it('says what the job does and where, in plain words', () => {
    expect(describeRunKind('agentTurn', 'isolated')).toEqual({ text: 'Agent task in its own session', unknown: null })
    expect(describeRunKind('command', 'isolated')).toEqual({ text: 'Shell command in its own session', unknown: null })
    expect(describeRunKind('systemEvent', 'main')).toEqual({ text: 'System message in the main session', unknown: null })
  })

  it('keeps an unknown raw value as quiet secondary text and never invents a meaning', () => {
    expect(describeRunKind('weirdKind', 'isolated')).toEqual({ text: 'Runs in its own session', unknown: 'weirdKind' })
    expect(describeRunKind('agentTurn', 'sandbox-7')).toEqual({ text: 'Agent task', unknown: 'sandbox-7' })
  })

  it('reports nothing when the job did not say how it runs', () => {
    expect(describeRunKind('?', '')).toEqual({ text: null, unknown: null })
    expect(describeRunKind(undefined, undefined)).toEqual({ text: null, unknown: null })
  })
})

describe('isInternalKey', () => {
  it('recognises the scheduler markers that stand in for a description', () => {
    expect(isInternalKey('__openclaw_memory_core_short_term_promotion_dream__')).toBe(true)
    expect(isInternalKey('Send the daily digest')).toBe(false)
    expect(isInternalKey('')).toBe(false)
    expect(isInternalKey(null)).toBe(false)
  })
})

describe('describeJobText', () => {
  it('a description at the list limit was cut; a shorter one was not', () => {
    expect(describeJobText('a'.repeat(120)).cut).toBe(true)
    expect(describeJobText('a'.repeat(119)).cut).toBe(false)
    expect(describeJobText(null)).toEqual({ text: '', cut: false })
  })
})

describe('failureReason', () => {
  it('prefers the job, then the newest run that has a reason, else null (never invented)', () => {
    expect(failureReason({ lastError: 'Timed out', history: [] })).toBe('Timed out')
    expect(failureReason({ history: [{ status: 'failed', error: null }, { status: 'failed', error: 'Exit 2' }] })).toBe('Exit 2')
    expect(failureReason({ history: [] })).toBeNull()
    expect(failureReason({ lastError: '  ' })).toBeNull()
  })
})
