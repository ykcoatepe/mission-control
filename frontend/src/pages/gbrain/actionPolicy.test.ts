import { describe, expect, it } from 'vitest'
import {
  resolveGBrainAction,
  visibleGBrainActions,
  type GBrainActionCapability,
} from './actionPolicy'

const actions: GBrainActionCapability[] = [
  { id: 'doctor-fast', safetyClass: 'R0', requiresConfirmation: false },
  { id: 'sync-sources', safetyClass: 'W1', requiresConfirmation: true },
  { id: 'danger', safetyClass: 'W2', requiresConfirmation: true },
]

describe('GBrain Explore action policy', () => {
  it('allows R0 only as direct and W1 only after scoped confirmation', () => {
    expect(resolveGBrainAction(actions, 'doctor-fast', 'direct', null)?.id).toBe('doctor-fast')
    expect(resolveGBrainAction(actions, 'doctor-fast', 'confirmed', null)).toBeNull()
    expect(resolveGBrainAction(actions, 'sync-sources', 'direct', null)).toBeNull()
    expect(resolveGBrainAction(actions, 'sync-sources', 'confirmed', null)?.id).toBe('sync-sources')
  })

  it('omits and rejects W2 and rejects stale or concurrent starts', () => {
    expect(visibleGBrainActions(actions).map((action) => action.id)).toEqual(['doctor-fast', 'sync-sources'])
    expect(resolveGBrainAction(actions, 'danger', 'direct', null)).toBeNull()
    expect(resolveGBrainAction(actions, 'danger', 'confirmed', null)).toBeNull()
    expect(resolveGBrainAction(actions, 'removed-action', 'confirmed', null)).toBeNull()
    expect(resolveGBrainAction(actions, 'doctor-fast', 'direct', 'sync-sources')).toBeNull()
  })

  it('never treats malformed W1 fallback metadata as direct', () => {
    const malformed = [{ id: 'sync-sources', safetyClass: 'W1', requiresConfirmation: false }] as GBrainActionCapability[]
    expect(resolveGBrainAction(malformed, 'sync-sources', 'direct', null)).toBeNull()
    expect(resolveGBrainAction(malformed, 'sync-sources', 'confirmed', null)).toBeNull()
  })
})
