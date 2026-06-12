import { describe, it, expect } from 'vitest'
import {
  normalizeTaskStatus,
  normalizeTaskStatusFromColumn,
  taskStatusLabel,
  normalizeCronStatus,
  normalizeDecisionStatus,
  isOpenDecisionStatus,
  normalizeVoteStatus,
  normalizeHealthState,
  healthStateColor,
  scoreToHealthState,
} from './status'

// ---------------------------------------------------------------------------
// normalizeTaskStatus
// ---------------------------------------------------------------------------

describe('normalizeTaskStatus', () => {
  it('returns queue for "queue"', () => expect(normalizeTaskStatus('queue')).toBe('queue'))
  it('returns blocked for "blocked"', () => expect(normalizeTaskStatus('blocked')).toBe('blocked'))
  it('returns done for "completed"', () => expect(normalizeTaskStatus('completed')).toBe('done'))
  it('returns done for "done"', () => expect(normalizeTaskStatus('done')).toBe('done'))
  it('returns executing for "executing"', () => expect(normalizeTaskStatus('executing')).toBe('executing'))
  it('returns inProgress for "inprogress"', () => expect(normalizeTaskStatus('inprogress')).toBe('inProgress'))
  it('returns inProgress for "in_progress"', () => expect(normalizeTaskStatus('in_progress')).toBe('inProgress'))
  it('returns inProgress for "running"', () => expect(normalizeTaskStatus('running')).toBe('inProgress'))
  it('is case-insensitive', () => expect(normalizeTaskStatus('QUEUE')).toBe('queue'))
  it('uses fallback for unknown status', () => expect(normalizeTaskStatus('unknown')).toBe('queue'))
  it('uses custom fallback', () => expect(normalizeTaskStatus('???', 'done')).toBe('done'))
  it('uses fallback for null', () => expect(normalizeTaskStatus(null)).toBe('queue'))
  it('uses fallback for undefined', () => expect(normalizeTaskStatus(undefined)).toBe('queue'))
})

// ---------------------------------------------------------------------------
// normalizeTaskStatusFromColumn
// ---------------------------------------------------------------------------

describe('normalizeTaskStatusFromColumn', () => {
  it('uses column as fallback when status is unknown', () => {
    expect(normalizeTaskStatusFromColumn('???', 'inProgress')).toBe('inProgress')
  })
  it('uses column=done as fallback', () => {
    expect(normalizeTaskStatusFromColumn(null, 'done')).toBe('done')
  })
  it('still normalizes known statuses regardless of column', () => {
    expect(normalizeTaskStatusFromColumn('executing', 'queue')).toBe('executing')
  })
  it('defaults to queue for unrecognized column', () => {
    expect(normalizeTaskStatusFromColumn(null, 'other')).toBe('queue')
  })
})

// ---------------------------------------------------------------------------
// taskStatusLabel
// ---------------------------------------------------------------------------

describe('taskStatusLabel', () => {
  it('labels executing', () => expect(taskStatusLabel('executing')).toBe('Executing'))
  it('labels inprogress -> In Progress', () => expect(taskStatusLabel('inprogress')).toBe('In Progress'))
  it('labels blocked', () => expect(taskStatusLabel('blocked')).toBe('Blocked'))
  it('labels done', () => expect(taskStatusLabel('done')).toBe('Done'))
  it('labels queue', () => expect(taskStatusLabel('queue')).toBe('Queue'))
  it('labels unknown as Queue (default fallback)', () => expect(taskStatusLabel(null)).toBe('Queue'))
})

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
// normalizeVoteStatus
// ---------------------------------------------------------------------------

describe('normalizeVoteStatus', () => {
  it('maps "approved" -> "approve"', () => expect(normalizeVoteStatus('approved')).toBe('approve'))
  it('maps "rejected" -> "reject"', () => expect(normalizeVoteStatus('rejected')).toBe('reject'))
  it('maps "veto" -> "reject"', () => expect(normalizeVoteStatus('veto')).toBe('reject'))
  it('maps "approved_with_conditions" -> "conditional"', () => {
    expect(normalizeVoteStatus('approved_with_conditions')).toBe('conditional')
  })
  it('passes through valid canonical values', () => {
    expect(normalizeVoteStatus('approve')).toBe('approve')
    expect(normalizeVoteStatus('conditional')).toBe('conditional')
    expect(normalizeVoteStatus('reject')).toBe('reject')
    expect(normalizeVoteStatus('abstain')).toBe('abstain')
  })
  it('defaults to "abstain" for unknown values', () => {
    expect(normalizeVoteStatus('unknown')).toBe('abstain')
  })
  it('defaults to "abstain" for null', () => {
    expect(normalizeVoteStatus(null)).toBe('abstain')
  })
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

// ---------------------------------------------------------------------------
// healthStateColor
// ---------------------------------------------------------------------------

describe('healthStateColor', () => {
  it('green -> #32D74B', () => expect(healthStateColor('green')).toBe('#32D74B'))
  it('yellow -> #FF9500', () => expect(healthStateColor('yellow')).toBe('#FF9500'))
  it('red -> #FF453A', () => expect(healthStateColor('red')).toBe('#FF453A'))
  it('gray -> #8E8E93', () => expect(healthStateColor('gray')).toBe('#8E8E93'))
})

// ---------------------------------------------------------------------------
// scoreToHealthState
// ---------------------------------------------------------------------------

describe('scoreToHealthState', () => {
  it('returns green for score >= 85', () => {
    expect(scoreToHealthState(85)).toBe('green')
    expect(scoreToHealthState(100)).toBe('green')
  })
  it('returns yellow for score >= 60 and < 85', () => {
    expect(scoreToHealthState(60)).toBe('yellow')
    expect(scoreToHealthState(84)).toBe('yellow')
  })
  it('returns red for score >= 1 and < 60', () => {
    expect(scoreToHealthState(1)).toBe('red')
    expect(scoreToHealthState(59)).toBe('red')
  })
  it('returns gray for score 0', () => {
    expect(scoreToHealthState(0)).toBe('gray')
  })
  it('returns gray for null/undefined', () => {
    expect(scoreToHealthState(null)).toBe('gray')
    expect(scoreToHealthState(undefined)).toBe('gray')
  })
  it('returns gray for NaN', () => {
    expect(scoreToHealthState(NaN)).toBe('gray')
  })
})
