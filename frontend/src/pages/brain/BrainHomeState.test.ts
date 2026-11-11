import { describe, expect, it } from 'vitest'
import {
  canStartAction,
  hasFreshReadingAdvanced,
  resolvePendingActionResult,
  resolveActionSuccessPolicy,
  resolveCurrentConfirmedW1,
} from './BrainHomeState'
import type { OperationCapability } from './types'

function capability(
  overrides: Partial<OperationCapability> = {},
): OperationCapability {
  return {
    id: 'sync-sources',
    system: 'gbrain',
    label: 'Sync sources',
    description: 'Sync sources',
    kind: 'maintenance',
    safetyClass: 'W1',
    requiresConfirmation: true,
    timeoutMs: 60_000,
    refreshAfter: true,
    enabled: true,
    disabledReason: '',
    actionEndpoint: '/api/gbrain/actions',
    ...overrides,
  }
}

describe('newer reading detection', () => {
  const fresh = (observedAt: string | null) => ({ observedAt, fresh: true })

  it('rejects missing and invalid first readings', () => {
    expect(hasFreshReadingAdvanced(null, null)).toBe(false)
    expect(hasFreshReadingAdvanced(null, fresh(null))).toBe(false)
    expect(hasFreshReadingAdvanced(null, fresh('not-a-timestamp'))).toBe(false)
  })

  it('accepts a valid fresh first reading', () => {
    expect(hasFreshReadingAdvanced(null, fresh('2026-07-10T12:00:00.000Z'))).toBe(true)
  })

  it('rejects stale, unchanged, invalid, and older follow-up readings', () => {
    const previous = '2026-07-10T12:00:00.000Z'
    expect(hasFreshReadingAdvanced(previous, {
      observedAt: '2026-07-10T12:01:00.000Z',
      fresh: false,
    })).toBe(false)
    expect(hasFreshReadingAdvanced(previous, fresh(previous))).toBe(false)
    expect(hasFreshReadingAdvanced(previous, fresh('invalid'))).toBe(false)
    expect(hasFreshReadingAdvanced(previous, fresh('2026-07-10T11:59:00.000Z'))).toBe(false)
  })

  it('accepts only a later fresh follow-up reading', () => {
    expect(hasFreshReadingAdvanced(
      '2026-07-10T12:00:00.000Z',
      fresh('2026-07-10T12:00:01.000Z'),
    )).toBe(true)
  })
})

describe('action start policy', () => {
  it('re-resolves a confirmed Change from the current capability catalog', () => {
    const current = capability()
    expect(resolveCurrentConfirmedW1([current], current.id)).toBe(current)
  })

  it('rejects missing, disabled, reclassified, or confirmation-free stale Change capabilities', () => {
    expect(resolveCurrentConfirmedW1([], 'sync-sources')).toBeNull()
    expect(resolveCurrentConfirmedW1([capability({ enabled: false })], 'sync-sources')).toBeNull()
    expect(resolveCurrentConfirmedW1([capability({ safetyClass: 'R0' })], 'sync-sources')).toBeNull()
    expect(resolveCurrentConfirmedW1([
      capability({ requiresConfirmation: false }),
    ], 'sync-sources')).toBeNull()
    expect(resolveCurrentConfirmedW1([capability({ safetyClass: 'W2' })], 'sync-sources')).toBeNull()
  })

  it('allows only the matching direct or confirmed policy and blocks double starts', () => {
    const r0 = capability({
      id: 'doctor-fast',
      safetyClass: 'R0',
      requiresConfirmation: false,
    })
    const w1 = capability()

    expect(canStartAction(r0, 'direct', null)).toBe(true)
    expect(canStartAction(w1, 'confirmed', null)).toBe(true)
    expect(canStartAction(w1, 'direct', null)).toBe(false)
    expect(canStartAction(r0, 'confirmed', null)).toBe(false)
    expect(canStartAction(r0, 'direct', 'another-action')).toBe(false)
    expect(canStartAction(capability({ safetyClass: 'W2' }), 'confirmed', null)).toBe(false)
  })
})

describe('action success policy', () => {
  it('keeps soft-timeout payloads pending instead of treating them as failed', () => {
    const payload = {
      ok: false,
      action: 'sync-sources',
      status: 'timed-out',
      pending: true,
      refreshAfter: true,
      summary: 'Cleanup is still running',
      checkedAt: '2026-07-11T12:00:00.000Z',
    }
    const error = Object.assign(new Error('command timed out'), { payload })

    expect(resolvePendingActionResult(error)).toEqual(payload)
    expect(resolvePendingActionResult(new Error('command failed'))).toBeNull()
  })

  it('completes non-refresh checks with the returned summary and no reading refresh', () => {
    expect(resolveActionSuccessPolicy({
      refreshAfter: false,
      summary: 'Storage is reachable',
    })).toEqual({
      shouldRefreshReading: false,
      status: { state: 'complete', message: 'Storage is reachable' },
    })
  })

  it('keeps refresh-required actions in verifying until a newer reading arrives', () => {
    expect(resolveActionSuccessPolicy({
      refreshAfter: true,
      summary: 'Sources synchronized',
    })).toEqual({
      shouldRefreshReading: true,
      status: {
        state: 'verifying',
        message: 'Sources synchronized · waiting for a newer reading',
      },
    })
  })
})
