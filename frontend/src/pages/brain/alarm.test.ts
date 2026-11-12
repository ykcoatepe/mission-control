import { describe, expect, it } from 'vitest'
import { actionIdFor, alarmAction, alarmFrom } from './alarm'
import { synoptic, withVerdict, META } from './fixtures'
import { deriveVerdict } from './lib'
import type { OperationCapability, VerdictReason } from './types'

const verdictFor = (...reasons: VerdictReason[]) => deriveVerdict(withVerdict(synoptic(), ...reasons), META)

const capability = (id: string, over: Partial<OperationCapability> = {}): OperationCapability => ({
  id,
  system: 'gbrain',
  label: id,
  description: '',
  kind: 'maintenance',
  safetyClass: 'W1',
  requiresConfirmation: true,
  timeoutMs: null,
  refreshAfter: true,
  enabled: true,
  disabledReason: '',
  actionEndpoint: '/api/gbrain/actions',
  ...over,
})

const MISSING: VerdictReason = { elementId: 'missing-embeddings', state: 'warning', kind: 'action', text: '9 chunks are missing embeddings past the tolerance.' }
const INFO_UNREAD: VerdictReason = { elementId: 'embed-job-probe', state: 'unavailable', kind: 'info', text: "Embedding job status couldn't be read." }
const SYNC_OFF: VerdictReason = { elementId: 'tk-omc-ain', state: 'inactive', kind: 'info', text: 'tk-omc-ain: sync off.' }

describe('the alarm line comes from reasons that ask for action, and only those', () => {
  it('is absent when nothing is abnormal', () => {
    expect(alarmFrom(verdictFor())).toBeNull()
  })

  it('is absent when the only reasons are information, whatever their state', () => {
    expect(alarmFrom(verdictFor(INFO_UNREAD, SYNC_OFF))).toBeNull()
    expect(alarmFrom(verdictFor({ ...INFO_UNREAD, state: 'warning' }))).toBeNull()
    expect(alarmFrom(verdictFor({ ...INFO_UNREAD, state: 'critical' }))).toBeNull()
  })

  it('is absent for a reading that was not taken: that is said quietly, not raised as an alarm', () => {
    const verdict = verdictFor({ elementId: 'queue', state: 'unavailable', kind: 'action', text: 'Queue reading unavailable.' })
    expect(verdict.state).toBe('unavailable')
    expect(alarmFrom(verdict)).toBeNull()
  })

  it('names the first thing to act on and never counts information in "more"', () => {
    const alarm = alarmFrom(verdictFor(INFO_UNREAD, SYNC_OFF, MISSING))
    expect(alarm).toMatchObject({ state: 'warning', title: '9 chunks are missing embeddings past the tolerance', more: 0, elementId: 'missing-embeddings' })
    const two = alarmFrom(verdictFor(MISSING, { elementId: 'queue', state: 'warning', kind: 'action', text: 'Queue requires attention.' }, INFO_UNREAD))
    expect(two?.more).toBe(1)
  })

  it('takes the worst state: a critical reason leads and the line is critical', () => {
    const alarm = alarmFrom(verdictFor(MISSING, { elementId: 'gbrain-core', state: 'critical', kind: 'action', text: 'GBrain core is failing.' }))
    expect(alarm).toMatchObject({ state: 'critical', title: 'GBrain core is failing' })
  })

  it('raises a caution for a stale reading, the same rule the top bar applies', () => {
    const verdict = deriveVerdict(synoptic(), { ...META, stale: true })
    expect(alarmFrom(verdict)).toMatchObject({ state: 'warning', title: 'The last reading is stale', elementId: null })
  })
})

describe('the one action of the alarm line', () => {
  const ALL = [capability('embed-missing'), capability('sync-sources'), capability('doctor-fast', { safetyClass: 'R0', requiresConfirmation: false })]

  it('matches the reason: missing embeddings backfill, a stale source sync, anything else the check', () => {
    expect(actionIdFor('missing-embeddings')).toBe('embed-missing')
    expect(actionIdFor('mission-control')).toBe('sync-sources')
    expect(actionIdFor('queue')).toBe('doctor-fast')
    expect(actionIdFor('gbrain.health')).toBe('doctor-fast')
    expect(actionIdFor(null)).toBe('doctor-fast')
    expect(alarmAction('missing-embeddings', ALL)).toMatchObject({ label: 'Backfill embeddings', capability: { id: 'embed-missing' } })
  })

  it('falls back to the check when the matching action is off, and offers nothing when nothing can run', () => {
    expect(alarmAction('missing-embeddings', [capability('embed-missing', { enabled: false }), ALL[2]])?.capability.id).toBe('doctor-fast')
    expect(alarmAction('missing-embeddings', [capability('embed-missing', { enabled: false })])).toBeNull()
    expect(alarmAction('missing-embeddings', null)).toBeNull()
  })

  it('never offers a W2 action', () => {
    expect(alarmAction('missing-embeddings', [capability('embed-missing', { safetyClass: 'W2' })])).toBeNull()
  })
})
