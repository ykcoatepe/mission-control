import { describe, expect, it } from 'vitest'
import {
  canStartAction,
  hasFreshProofAdvanced,
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
    description: 'Sync source evidence',
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

describe('GBrain proof advancement', () => {
  const freshProof = (observedAt: string | null) => ({ observedAt, freshness: 'fresh' as const })

  it('rejects missing and invalid first proof', () => {
    expect(hasFreshProofAdvanced(null, null)).toBe(false)
    expect(hasFreshProofAdvanced(null, freshProof(null))).toBe(false)
    expect(hasFreshProofAdvanced(null, freshProof('not-a-timestamp'))).toBe(false)
  })

  it('accepts a valid fresh first proof', () => {
    expect(hasFreshProofAdvanced(null, freshProof('2026-07-10T12:00:00.000Z'))).toBe(true)
  })

  it('rejects stale, unchanged, invalid, and older follow-up proof', () => {
    const previous = '2026-07-10T12:00:00.000Z'
    expect(hasFreshProofAdvanced(previous, {
      observedAt: '2026-07-10T12:01:00.000Z',
      freshness: 'stale',
    })).toBe(false)
    expect(hasFreshProofAdvanced(previous, freshProof(previous))).toBe(false)
    expect(hasFreshProofAdvanced(previous, freshProof('invalid'))).toBe(false)
    expect(hasFreshProofAdvanced(previous, freshProof('2026-07-10T11:59:00.000Z'))).toBe(false)
  })

  it('accepts only a later fresh follow-up proof', () => {
    expect(hasFreshProofAdvanced(
      '2026-07-10T12:00:00.000Z',
      freshProof('2026-07-10T12:00:01.000Z'),
    )).toBe(true)
  })
})

describe('GBrain action start policy', () => {
  it('re-resolves a confirmed W1 from the current capability catalog', () => {
    const current = capability()
    expect(resolveCurrentConfirmedW1([current], current.id)).toBe(current)
  })

  it('rejects missing, disabled, reclassified, or confirmation-free stale W1 capabilities', () => {
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
