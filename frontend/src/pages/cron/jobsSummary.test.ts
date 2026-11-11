import { describe, expect, it } from 'vitest'
import { isJobOn, summarizeJobs } from './jobsSummary'
import type { CronJob } from './types'

function job(over: Partial<CronJob> & { id: string }): CronJob {
  return {
    name: over.id, schedule: '0 9 * * *', status: 'active', enabled: true, lastRun: null, nextRun: null,
    duration: null, target: 'isolated', payload: 'agentTurn', description: '', history: [], ...over,
  }
}

const NOW = Date.parse('2026-11-11T12:00:00Z')

const jobs = [
  job({ id: 'ok', status: 'active', nextRun: '2026-11-11T12:30:00Z' }),
  job({ id: 'soon', status: 'scheduled', nextRun: '2026-11-11T12:05:00Z' }),
  job({ id: 'bad', status: 'failed', nextRun: '2026-11-11T13:00:00Z' }),
  job({ id: 'off', status: 'disabled', enabled: false, nextRun: '2026-11-11T12:01:00Z' }),
]

describe('summarizeJobs', () => {
  it('uses the API numbers when it gives them: Active counts every job that is on, failed ones included', () => {
    const s = summarizeJobs(jobs, { active: 31, paused: 144, failed: 2, nextRunAt: '2026-11-11T12:05:00.000Z' }, NOW)
    expect(s).toMatchObject({ active: 31, paused: 144, failed: 2 })
  })

  it('derives the same figures from the list with the same rule when there is no summary', () => {
    const s = summarizeJobs(jobs, undefined, NOW)
    expect(s).toMatchObject({ active: 3, paused: 1, failed: 1, waiting: 1 })
    expect(s.active + s.paused).toBe(jobs.length)
  })

  it('finds the next run among jobs that are on, ignoring paused jobs and past times', () => {
    const s = summarizeJobs(jobs, undefined, NOW)
    expect(s.nextRun).toEqual({ at: Date.parse('2026-11-11T12:05:00Z'), name: 'soon' })
    expect(summarizeJobs(jobs, undefined, Date.parse('2026-11-11T14:00:00Z')).nextRun).toBeNull()
  })

  it('falls back to the API next run (without a name) only when it is still ahead', () => {
    const none = [job({ id: 'a' })]
    expect(summarizeJobs(none, { nextRunAt: '2026-11-11T12:10:00Z' }, NOW).nextRun).toEqual({ at: Date.parse('2026-11-11T12:10:00Z'), name: null })
    expect(summarizeJobs(none, { nextRunAt: '2026-11-11T11:00:00Z' }, NOW).nextRun).toBeNull()
    expect(summarizeJobs(none, { nextRunAt: null }, NOW).nextRun).toBeNull()
  })

  it('ignores API counts that are not whole numbers and derives them instead', () => {
    const s = summarizeJobs(jobs, { active: null as unknown as number, paused: -1, failed: 1.5 }, NOW)
    expect(s).toMatchObject({ active: 3, paused: 1, failed: 1 })
  })

  it('an unknown next run is null, never a time or 0', () => {
    expect(summarizeJobs([], undefined, NOW)).toMatchObject({ active: 0, paused: 0, failed: 0, nextRun: null })
  })
})

describe('isJobOn', () => {
  it('is true for failed and waiting jobs, false only for paused ones', () => {
    expect(isJobOn(job({ id: 'a', status: 'failed' }))).toBe(true)
    expect(isJobOn(job({ id: 'b', status: 'idle' }))).toBe(true)
    expect(isJobOn(job({ id: 'c', status: 'active', enabled: false }))).toBe(false)
    expect(isJobOn(job({ id: 'd', status: 'disabled' }))).toBe(false)
  })
})
