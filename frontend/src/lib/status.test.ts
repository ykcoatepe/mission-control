import { describe, it, expect } from 'vitest'
import {
  normalizeCronStatus,
  normalizeDecisionStatus,
  isOpenDecisionStatus,
  normalizeHealthState,
} from './status'

// ---------------------------------------------------------------------------
// normalizeCronStatus
// ---------------------------------------------------------------------------

describe('normalizeCronStatus', () => {
  it('returns disabled when enabled=false regardless of rawStatus', () => {
    expect(normalizeCronStatus('active', false)).toBe('disabled')
  })
  it('returns active for "active"', () => expect(normalizeCronStatus('active')).toBe('active'))
  it('returns active for "running"', () => expect(normalizeCronStatus('running')).toBe('active'))
  it('returns active for "ok"', () => expect(normalizeCronStatus('ok')).toBe('active'))
  it('returns active for "success"', () => expect(normalizeCronStatus('success')).toBe('active'))
  it('returns failed for "failed"', () => expect(normalizeCronStatus('failed')).toBe('failed'))
  it('returns failed for "error"', () => expect(normalizeCronStatus('error')).toBe('failed'))
  it('returns failed for "errored"', () => expect(normalizeCronStatus('errored')).toBe('failed'))
  it('returns disabled for "disabled"', () => expect(normalizeCronStatus('disabled')).toBe('disabled'))
  it('returns idle for null/unknown', () => expect(normalizeCronStatus(null)).toBe('idle'))
})

// ---------------------------------------------------------------------------
// normalizeDecisionStatus
// ---------------------------------------------------------------------------

describe('normalizeDecisionStatus', () => {
  it('maps "active" to "open"', () => expect(normalizeDecisionStatus('active')).toBe('open'))
  it('maps empty string to "open"', () => expect(normalizeDecisionStatus('')).toBe('open'))
  it('maps null to "open"', () => expect(normalizeDecisionStatus(null)).toBe('open'))
  it('maps "approved with conditions" to "approved_with_conditions"', () => {
    expect(normalizeDecisionStatus('approved with conditions')).toBe('approved_with_conditions')
  })
  it('lowercases and passes through other statuses', () => {
    expect(normalizeDecisionStatus('Approved')).toBe('approved')
    expect(normalizeDecisionStatus('REJECTED')).toBe('rejected')
  })
})

// ---------------------------------------------------------------------------
// isOpenDecisionStatus
// ---------------------------------------------------------------------------

describe('isOpenDecisionStatus', () => {
  it('treats "open" as open', () => expect(isOpenDecisionStatus('open')).toBe(true))
  it('treats "active" (mapped to open) as open', () => expect(isOpenDecisionStatus('active')).toBe(true))
  it('treats "pending" as open', () => expect(isOpenDecisionStatus('pending')).toBe(true))
  it('treats "pending_user_decision" as open', () => expect(isOpenDecisionStatus('pending_user_decision')).toBe(true))
  it('treats "delegated" as open', () => expect(isOpenDecisionStatus('delegated')).toBe(true))
  it('treats "approved" as not open', () => expect(isOpenDecisionStatus('approved')).toBe(false))
  it('treats "rejected" as not open', () => expect(isOpenDecisionStatus('rejected')).toBe(false))
  it('treats null as open (maps to "open")', () => expect(isOpenDecisionStatus(null)).toBe(true))
})

// ---------------------------------------------------------------------------
// normalizeHealthState
// ---------------------------------------------------------------------------

describe('normalizeHealthState', () => {
  it('passes through known values', () => {
    expect(normalizeHealthState('green')).toBe('green')
    expect(normalizeHealthState('yellow')).toBe('yellow')
    expect(normalizeHealthState('red')).toBe('red')
    expect(normalizeHealthState('gray')).toBe('gray')
  })
  it('uses fallback for unknown values', () => {
    expect(normalizeHealthState('blue')).toBe('gray')
  })
  it('uses custom fallback', () => {
    expect(normalizeHealthState('', 'red')).toBe('red')
  })
  it('is case-insensitive', () => {
    expect(normalizeHealthState('GREEN')).toBe('green')
  })
})

