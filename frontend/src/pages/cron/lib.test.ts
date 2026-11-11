import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  calcSuccessRate,
  getCronScheduler,
  getCronSchedulerLabel,
  isDisallowedCloudModel,
  normalizeCronModelValue,
  formatCronModelLabel,
  buildCronModelOptions,
  buildCronOverlapMarkers,
  formatOverlapMinute,
  rowStaggerDelay,
  errorMessage,
  cronRequest,
  CLOUD_AGENT_MODEL,
} from './lib'
import { ApiError } from '../../lib/hooks'
import type { CronJob } from './types'

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    name: 'Test job',
    schedule: '0 8 * * *',
    status: 'active',
    enabled: true,
    lastRun: null,
    nextRun: null,
    duration: null,
    target: 'isolated',
    payload: 'agentTurn',
    description: '',
    history: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// calcSuccessRate
// ---------------------------------------------------------------------------

describe('calcSuccessRate', () => {
  it('returns null for empty history', () => {
    expect(calcSuccessRate([])).toBeNull()
  })

  it('counts done/success/ok as successes', () => {
    const rate = calcSuccessRate([
      { status: 'done' },
      { status: 'success' },
      { status: 'ok' },
      { status: 'failed' },
    ])
    expect(rate).toEqual({ rate: '75%', pct: 75, total: 4, ok: 3, failed: 1 })
  })

  it('reports 100% when every entry succeeded', () => {
    const rate = calcSuccessRate([{ status: 'done' }, { status: 'ok' }])
    expect(rate?.pct).toBe(100)
    expect(rate?.failed).toBe(0)
  })

  it('treats unknown statuses as failures', () => {
    const rate = calcSuccessRate([{ status: 'weird' }, {}])
    expect(rate?.pct).toBe(0)
    expect(rate?.failed).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// scheduler helpers
// ---------------------------------------------------------------------------

describe('scheduler helpers', () => {
  it('defaults to openclaw', () => {
    expect(getCronScheduler(undefined)).toBe('openclaw')
    expect(getCronScheduler({ scheduler: undefined })).toBe('openclaw')
    expect(getCronScheduler({ scheduler: 'hermes' })).toBe('hermes')
  })

  it('prefers the explicit scheduler label', () => {
    expect(getCronSchedulerLabel({ scheduler: 'hermes', schedulerLabel: 'Hermes Prod' })).toBe('Hermes Prod')
    expect(getCronSchedulerLabel({ scheduler: 'hermes' })).toBe('Hermes')
    expect(getCronSchedulerLabel(undefined)).toBe('OpenClaw')
  })

})

// ---------------------------------------------------------------------------
// model normalization + options
// ---------------------------------------------------------------------------

describe('isDisallowedCloudModel', () => {
  it('disallows blocked cloud providers', () => {
    expect(isDisallowedCloudModel('anthropic/claude-3')).toBe(true)
    expect(isDisallowedCloudModel('claude-cli/opus')).toBe(true)
    expect(isDisallowedCloudModel('openrouter/foo')).toBe(true)
    expect(isDisallowedCloudModel('qwen/qwen-max')).toBe(true)
    expect(isDisallowedCloudModel('minimax-portal/abab')).toBe(true)
    expect(isDisallowedCloudModel('openai/gpt-5.4')).toBe(true)
    expect(isDisallowedCloudModel('openai-codex/gpt-5.2')).toBe(true)
    expect(isDisallowedCloudModel('openai-codex/gpt-5.3')).toBe(true)
    expect(isDisallowedCloudModel('openai-codex/gpt-5.4')).toBe(true)
  })

  it('always allows the designated cloud agent model', () => {
    expect(isDisallowedCloudModel(CLOUD_AGENT_MODEL)).toBe(false)
  })

  it('allows local and unlisted models', () => {
    expect(isDisallowedCloudModel('ollama/qwen3.5:27b')).toBe(false)
    expect(isDisallowedCloudModel('openai/gpt-5.5')).toBe(false)
    expect(isDisallowedCloudModel('')).toBe(false)
  })
})

describe('normalizeCronModelValue', () => {
  it('maps known aliases', () => {
    expect(normalizeCronModelValue('local-qwen3.6-35b-a3b-nvfp4')).toBe('ollama/qwen3.6:35b-a3b-nvfp4')
  })

  it('passes through unknown values and trims', () => {
    expect(normalizeCronModelValue(' openai-codex/gpt-5.5 ')).toBe('openai-codex/gpt-5.5')
    expect(normalizeCronModelValue(undefined)).toBe('')
  })
})

describe('formatCronModelLabel', () => {
  it('appends (local) for plain ollama models', () => {
    expect(formatCronModelLabel('ollama/qwen3.5:27b', 'qwen3.5:27b')).toBe('qwen3.5:27b (local)')
  })

  it('does not append for :cloud variants or already-suffixed names', () => {
    expect(formatCronModelLabel('ollama/qwen3.5:27b:cloud', 'qwen cloud')).toBe('qwen cloud')
    expect(formatCronModelLabel('ollama/qwen3.5:27b', 'qwen (local)')).toBe('qwen (local)')
  })

  it('falls back to the id, then to Unknown model', () => {
    expect(formatCronModelLabel('openai-codex/gpt-5.5')).toBe('openai-codex/gpt-5.5')
    expect(formatCronModelLabel('')).toBe('Unknown model')
  })
})

describe('buildCronModelOptions', () => {
  it('starts with the Default option', () => {
    expect(buildCronModelOptions([], [])[0]).toEqual({ value: '', label: 'Default' })
  })

  it('includes registry models and the fallback, filtering disallowed ones', () => {
    const options = buildCronModelOptions(
      [
        { id: 'ollama/qwen3.5:27b', name: 'Qwen 3.5 27B' },
        { id: 'anthropic/claude-3', name: 'Claude' },
      ],
      []
    )
    const values = options.map((o) => o.value)
    expect(values).toContain('ollama/qwen3.5:27b')
    expect(values).toContain(CLOUD_AGENT_MODEL)
    expect(values).not.toContain('anthropic/claude-3')
  })

  it('keeps a job-only model even when it is disallowed, so the select shows the current value', () => {
    const options = buildCronModelOptions([], [makeJob({ model: 'openai-codex/gpt-5.2' })])
    expect(options.map((o) => o.value)).toContain('openai-codex/gpt-5.2')
  })

  it('labels aliased job models as "raw → normalized"', () => {
    const options = buildCronModelOptions([], [makeJob({ model: 'local-qwen3.6-35b-a3b-nvfp4' })])
    const option = options.find((o) => o.value === 'ollama/qwen3.6:35b-a3b-nvfp4')
    expect(option?.label).toBe('local-qwen3.6-35b-a3b-nvfp4 → ollama/qwen3.6:35b-a3b-nvfp4 (local)')
  })

  it('does not duplicate a model present in both registry and jobs', () => {
    const options = buildCronModelOptions(
      [{ id: 'ollama/qwen3.5:27b', name: 'Qwen' }],
      [makeJob({ model: 'ollama/qwen3.5:27b' })]
    )
    expect(options.filter((o) => o.value === 'ollama/qwen3.5:27b')).toHaveLength(1)
  })

  it('does not add a second empty option for jobs without a model', () => {
    const options = buildCronModelOptions([], [makeJob({ model: undefined }), makeJob({ id: 'job-2', model: '' })])
    expect(options.filter((o) => o.value === '')).toHaveLength(1)
    expect(options[0].label).toBe('Default')
  })
})

// ---------------------------------------------------------------------------
// formatOverlapMinute
// ---------------------------------------------------------------------------

describe('formatOverlapMinute', () => {
  it('returns null for missing dates', () => {
    expect(formatOverlapMinute(undefined)).toBeNull()
    expect(formatOverlapMinute(null)).toBeNull()
    expect(formatOverlapMinute('')).toBeNull()
  })

  it('returns null for unparseable dates', () => {
    expect(formatOverlapMinute('not-a-date')).toBeNull()
  })

  it('formats valid timestamps as an hour:minute label', () => {
    expect(formatOverlapMinute('2026-06-12T10:30:00.000Z')).toMatch(/\d{1,2}:\d{2}/)
  })
})

// ---------------------------------------------------------------------------
// overlap markers
// ---------------------------------------------------------------------------

describe('buildCronOverlapMarkers', () => {
  it('marks enabled jobs sharing the same nextRun minute', () => {
    const a = makeJob({ id: 'a', nextRun: '2026-06-12T10:30:00.000Z' })
    const b = makeJob({ id: 'b', nextRun: '2026-06-12T10:30:45.000Z' })
    const c = makeJob({ id: 'c', nextRun: '2026-06-12T11:00:00.000Z' })
    const state = buildCronOverlapMarkers([a, b, c])
    expect(state.markers.has('a')).toBe(true)
    expect(state.markers.has('b')).toBe(true)
    expect(state.markers.has('c')).toBe(false)
    expect(state.markers.get('a')?.count).toBe(2)
    expect(state.affectedJobs).toBe(2)
    expect(state.windows).toBe(1)
  })

  it('does not bucket an interval job by the words of its display text', () => {
    const a = makeJob({ id: 'a', schedule: 'every 30m', scheduleKind: 'interval', everyMs: 1_800_000 })
    const b = makeJob({ id: 'b', schedule: 'every 30m', scheduleKind: 'interval', everyMs: 1_800_000 })
    const c = makeJob({ id: 'c', schedule: null, scheduleKind: 'interval_unknown' })
    expect(buildCronOverlapMarkers([a, b, c]).markers.size).toBe(0)
    // Without a kind (older payload) the old reading of the text remains.
    expect(buildCronOverlapMarkers([makeJob({ id: 'x', schedule: '30 9 * * *' }), makeJob({ id: 'y', schedule: '30 9 * * 1' })]).markers.size).toBe(2)
  })

  it('falls back to cron hour|minute buckets when nextRun is missing', () => {
    const a = makeJob({ id: 'a', schedule: '30 9 * * *' })
    const b = makeJob({ id: 'b', schedule: '30 9 * * 1' })
    const state = buildCronOverlapMarkers([a, b])
    expect(state.markers.get('a')?.label).toBe('Overlap 09:30')
    expect(state.markers.get('b')?.detail).toContain('2 enabled jobs')
  })

  it('labels wildcard-hour overlaps with just the minute', () => {
    const a = makeJob({ id: 'a', schedule: '15 * * * *' })
    const b = makeJob({ id: 'b', schedule: '15 * * * *' })
    const state = buildCronOverlapMarkers([a, b])
    expect(state.markers.get('a')?.label).toBe('Overlap :15')
  })

  it('ignores disabled jobs and wildcard minutes', () => {
    const a = makeJob({ id: 'a', schedule: '30 9 * * *', enabled: false })
    const b = makeJob({ id: 'b', schedule: '30 9 * * *' })
    const wild1 = makeJob({ id: 'w1', schedule: '* 9 * * *' })
    const wild2 = makeJob({ id: 'w2', schedule: '* 9 * * *' })
    const state = buildCronOverlapMarkers([a, b, wild1, wild2])
    expect(state.affectedJobs).toBe(0)
  })

  it('ignores malformed schedules with fewer than two fields', () => {
    const a = makeJob({ id: 'a', schedule: '30' })
    const b = makeJob({ id: 'b', schedule: '30' })
    const state = buildCronOverlapMarkers([a, b])
    expect(state.affectedJobs).toBe(0)
  })

  it('does not mark a single job in a bucket', () => {
    const state = buildCronOverlapMarkers([makeJob({ id: 'a', schedule: '30 9 * * *' })])
    expect(state.affectedJobs).toBe(0)
    expect(state.windows).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// rowStaggerDelay
// ---------------------------------------------------------------------------

describe('rowStaggerDelay', () => {
  it('grows linearly below the cap', () => {
    expect(rowStaggerDelay(0, 0.25, 0.04)).toBeCloseTo(0.25)
    expect(rowStaggerDelay(5, 0.25, 0.04)).toBeCloseTo(0.45)
  })

  it('stops growing past the cap so long lists appear quickly', () => {
    expect(rowStaggerDelay(10, 0.25, 0.04)).toBeCloseTo(0.65)
    expect(rowStaggerDelay(96, 0.25, 0.04)).toBeCloseTo(0.65)
  })

  it('honors a custom cap index', () => {
    expect(rowStaggerDelay(50, 0.1, 0.03, 5)).toBeCloseTo(0.25)
  })
})

// ---------------------------------------------------------------------------
// errorMessage + cronRequest
// ---------------------------------------------------------------------------

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('errorMessage', () => {
  it('unwraps Error instances and stringifies the rest', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom')
    expect(errorMessage('plain')).toBe('plain')
  })

  it('uses the server message for validation and conflict, and says busy for 429', () => {
    expect(errorMessage(new ApiError({ status: 400, code: 'invalid_schedule', message: 'Invalid job schedule' }))).toBe('Invalid job schedule')
    expect(errorMessage(new ApiError({ status: 429, code: 'x', message: 'busy', retryAfterMs: 2000 }))).toBe('The server is busy, try again in 2 seconds.')
  })
})

describe('cronRequest', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves silently on 2xx and sends the write header with a JSON body', async () => {
    const mock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
    vi.stubGlobal('fetch', mock)
    await expect(cronRequest('/api/cron/x/run', 'POST', { scheduler: 'openclaw' })).resolves.toBeUndefined()
    const [, init] = mock.mock.calls[0] as [string, RequestInit]
    expect(new Headers(init.headers).get('x-mc-request')).toBe('1')
    expect(init.body).toBe('{"scheduler":"openclaw"}')
  })

  it('throws the server message from { error: { code, message } }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error: { code: 'invalid_schedule', message: 'Invalid job schedule' } }, 400)))
    await expect(cronRequest('/api/cron/create', 'POST', {})).rejects.toMatchObject({ status: 400, code: 'invalid_schedule', message: 'Invalid job schedule' })
  })

  it('falls back to the HTTP status when the body is not an error object', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ detail: 'nope' }, 500)))
    await expect(cronRequest('/api/cron/x', 'DELETE', {})).rejects.toThrow('HTTP 500')
  })

  it('falls back to the HTTP status for non-JSON error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('bad gateway', { status: 502 })))
    await expect(cronRequest('/api/cron/x', 'DELETE', {})).rejects.toThrow('HTTP 502')
  })
})
