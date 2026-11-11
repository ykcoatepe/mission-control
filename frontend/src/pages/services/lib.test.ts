import { describe, expect, it } from 'vitest'
import {
  describeExit,
  endpointReading,
  filterCounts,
  filterServices,
  formatInterval,
  isAbnormal,
  scheduleNote,
  serviceHint,
  serviceStatus,
  servicesVerdict,
  sortServices,
} from './lib'
import type { Endpoint, ServiceRow, ServicesData } from './types'

const row = (over: Partial<ServiceRow> = {}): ServiceRow => ({
  label: 'ai.example.job',
  kind: 'keepalive',
  pid: 100,
  lastExitCode: 0,
  state: 'running',
  runAtLoad: true,
  intervalSeconds: null,
  calendar: false,
  plist: 'read',
  ...over,
})

const up = (over: Partial<Endpoint> = {}): Endpoint => ({
  state: 'up',
  reachable: true,
  error: null,
  observedAt: '2026-11-11T08:00:00.000Z',
  ...over,
})

const data = (over: Partial<ServicesData> = {}): ServicesData => ({
  services: [row({ label: 'a' }), row({ label: 'b', kind: 'interval', pid: null, state: 'idle', intervalSeconds: 600 })],
  counts: { total: 2, running: 1, idle: 1, down: 0, failed: 0 },
  gateways: { openclaw: up(), hermes: up({ heartbeatAt: '2026-11-11T08:00:05.000Z' }) },
  ollama: up(),
  ...over,
})

describe('serviceStatus', () => {
  it('maps the four server words', () => {
    expect(serviceStatus({ state: 'running' })).toEqual({ state: 'healthy', label: 'Running' })
    expect(serviceStatus({ state: 'idle' })).toEqual({ state: 'inactive', label: 'Idle' })
    expect(serviceStatus({ state: 'down' })).toEqual({ state: 'critical', label: 'Down' })
    expect(serviceStatus({ state: 'failed' })).toEqual({ state: 'critical', label: 'Failed' })
  })

  it('never turns an unknown word into healthy or down', () => {
    expect(serviceStatus({ state: 'weird' })).toEqual({ state: 'unavailable', label: 'Not read' })
    expect(serviceStatus({ state: '' })).toEqual({ state: 'unavailable', label: 'Not read' })
    expect(isAbnormal({ state: 'weird' })).toBe(false)
  })
})

describe('sortServices and filters', () => {
  const rows = [
    row({ label: 'z-idle', state: 'idle', pid: null, kind: 'interval' }),
    row({ label: 'b-running' }),
    row({ label: 'a-down', state: 'down', pid: null }),
    row({ label: 'm-unknown', state: 'weird', kind: null }),
    row({ label: 'f-failed', state: 'failed', pid: null, kind: 'one-shot', lastExitCode: 1 }),
  ]

  it('puts abnormal rows first, then unread, running, idle', () => {
    expect(sortServices(rows).map((r) => r.label)).toEqual(['a-down', 'f-failed', 'm-unknown', 'b-running', 'z-idle'])
  })

  it('does not mutate its input', () => {
    const copy = [...rows]
    sortServices(rows)
    expect(rows).toEqual(copy)
  })

  it('filters by down and by kind', () => {
    expect(filterServices(rows, 'down', '').map((r) => r.label)).toEqual(['a-down', 'f-failed'])
    expect(filterServices(rows, 'one-shot', '').map((r) => r.label)).toEqual(['f-failed'])
    expect(filterServices(rows, 'interval', '').map((r) => r.label)).toEqual(['z-idle'])
  })

  it('searches label, kind and state, case-insensitively', () => {
    expect(filterServices(rows, 'all', 'RUNNING').map((r) => r.label)).toEqual(['b-running'])
    expect(filterServices(rows, 'all', 'one-shot').map((r) => r.label)).toEqual(['f-failed'])
    expect(filterServices(rows, 'all', 'nothing-here')).toEqual([])
  })

  it('counts chips from the rows, and a row of unknown kind is in no kind chip', () => {
    expect(filterCounts(rows)).toEqual({ all: 5, down: 2, keepalive: 2, interval: 1, 'one-shot': 1 })
  })
})

describe('serviceHint', () => {
  it('is empty for a healthy row', () => {
    expect(serviceHint(row())).toBeNull()
    expect(serviceHint(row({ state: 'idle', pid: null, kind: 'interval' }))).toBeNull()
  })

  it('explains a one-shot with a non-zero exit as inactive, not failed', () => {
    const hint = serviceHint(row({ kind: 'one-shot', state: 'idle', pid: null, lastExitCode: 78 }))
    expect(hint).toContain('code 78')
    expect(hint).toContain('inactive')
    expect(hint).toContain('not failed')
  })

  it('does not call a failed row inactive', () => {
    const hint = serviceHint(row({ kind: 'one-shot', state: 'failed', pid: null, lastExitCode: 1 }))
    expect(hint).toContain('code 1')
    expect(hint).not.toContain('inactive')
  })

  it('explains a down keepalive and a restart after a signal', () => {
    expect(serviceHint(row({ state: 'down', pid: null }))).toContain('no process')
    expect(serviceHint(row({ lastExitCode: -15 }))).toContain('signal 15 (SIGTERM)')
  })

  it('explains a missing definition, and prefers a hint the server wrote', () => {
    expect(serviceHint(row({ kind: null, plist: 'not-found' }))).toContain('not found')
    expect(serviceHint(row({ plist: 'unreadable' }))).toContain('could not be read')
    expect(serviceHint(row({ hint: ' Server says so ', lastExitCode: 3 }))).toBe('Server says so')
  })
})

describe('words', () => {
  it('describes exit codes and signals', () => {
    expect(describeExit(1)).toBe('code 1')
    expect(describeExit(-9)).toBe('signal 9 (SIGKILL)')
    expect(describeExit(-40)).toBe('signal 40')
  })

  it('formats intervals and never invents one', () => {
    expect(formatInterval(600)).toBe('every 10m')
    expect(formatInterval(3600)).toBe('every 1h')
    expect(formatInterval(45)).toBe('every 45s')
    expect(formatInterval(null)).toBeNull()
    expect(formatInterval(0)).toBeNull()
    expect(scheduleNote({ kind: 'keepalive', intervalSeconds: 600, calendar: false })).toBeNull()
    expect(scheduleNote({ kind: 'interval', intervalSeconds: null, calendar: true })).toBe('on a calendar')
    expect(scheduleNote({ kind: 'interval', intervalSeconds: null, calendar: false })).toBeNull()
  })
})

describe('endpointReading', () => {
  it('reads up, down and stale', () => {
    expect(endpointReading(up())).toMatchObject({ state: 'healthy', word: 'Up', atLabel: 'checked' })
    expect(endpointReading(up({ state: 'down', reachable: false }))).toMatchObject({ state: 'critical', word: 'Down' })
    expect(endpointReading(up({ state: 'stale' }))).toMatchObject({ state: 'warning', word: 'Stale' })
  })

  it('prefers the heartbeat time when there is one', () => {
    expect(endpointReading(up({ heartbeatAt: '2026-11-11T08:00:05.000Z' }))).toMatchObject({
      at: '2026-11-11T08:00:05.000Z',
      atLabel: 'heartbeat',
    })
  })

  it('treats unknown, missing or garbage as not read, never up', () => {
    expect(endpointReading(up({ state: 'unknown', reachable: null }))).toMatchObject({ state: 'unavailable', word: 'Not read' })
    expect(endpointReading(null)).toEqual({ state: 'unavailable', word: 'Not read', at: null, atLabel: 'checked' })
    expect(endpointReading(up({ state: 'banana' })).state).toBe('unavailable')
  })
})

describe('servicesVerdict', () => {
  it('is healthy only when everything was read and nothing is down', () => {
    expect(servicesVerdict(data())).toEqual({
      state: 'healthy',
      text: 'All 2 services are running as expected',
      detail: '1 running · 1 idle',
    })
  })

  it('names down services', () => {
    const v = servicesVerdict(
      data({ services: [row({ state: 'down', pid: null }), row({ state: 'failed', pid: null, lastExitCode: 1 }), row()] }),
    )
    expect(v.state).toBe('critical')
    expect(v.text).toBe('2 services are down')
    expect(servicesVerdict(data({ services: [row({ state: 'down', pid: null })] })).text).toBe('1 service is down')
  })

  it('names unreachable endpoints, together with down services', () => {
    const v = servicesVerdict(data({ ollama: up({ state: 'down', reachable: false }) }))
    expect(v).toMatchObject({ state: 'critical', text: 'Ollama is not reachable' })
    const both = servicesVerdict(
      data({ services: [row({ state: 'down', pid: null })], ollama: up({ state: 'down', reachable: false }) }),
    )
    expect(both.text).toBe('1 service is down and Ollama is not reachable')
  })

  it('is not healthy when an endpoint or a service state was not read', () => {
    const endpoint = servicesVerdict(data({ ollama: up({ state: 'unknown', reachable: null }) }))
    expect(endpoint.state).toBe('unavailable')
    expect(endpoint.text).toContain('Ollama')
    expect(servicesVerdict(data({ gateways: null, ollama: null })).state).toBe('unavailable')
    expect(servicesVerdict(data({ services: [row({ state: 'weird' })] })).state).toBe('unavailable')
    expect(servicesVerdict(data({ gateways: { openclaw: up(), hermes: up({ state: 'stale' }) } })).state).toBe('warning')
  })

  it('is not healthy for a missing or empty service list', () => {
    expect(servicesVerdict(null)).toMatchObject({ state: 'unavailable' })
    expect(servicesVerdict(undefined).state).toBe('unavailable')
    expect(servicesVerdict(data({ services: null, counts: null })).state).toBe('unavailable')
    expect(servicesVerdict(data({ services: [] })).state).toBe('unavailable')
  })

  it('still reports unreachable endpoints when the service list is missing', () => {
    expect(servicesVerdict(data({ services: null, ollama: up({ state: 'down', reachable: false }) })).state).toBe('critical')
  })
})
