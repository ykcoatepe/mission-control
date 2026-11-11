import { describe, expect, it } from 'vitest'
import {
  describeExit,
  endpointReading,
  filterCounts,
  filterServices,
  formatInterval,
  isAbnormal,
  scheduleNote,
  parseServiceFilter,
  serviceHint,
  serviceStatus,
  servicesVerdict,
  sortServices,
} from './lib'
import type { Endpoint, ServiceRow, ServicesData, ServicesSummary } from './types'

const row = (over: Partial<ServiceRow> = {}): ServiceRow => ({
  label: 'ai.example.job',
  kind: 'keepalive',
  identified: true,
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

// What the server's `summary` would say for these rows (test fixture only; the page never computes it).
const summaryFor = (rows: ServiceRow[]): ServicesSummary => ({
  total: rows.length,
  running: rows.filter((r) => r.state === 'running').length,
  idle: rows.filter((r) => r.state === 'idle').length,
  down: rows.filter((r) => r.state === 'down' || r.state === 'failed').length,
  unidentified: rows.filter((r) => !r.identified).length,
})

const data = (over: Partial<ServicesData> = {}): ServicesData => {
  const services = over.services !== undefined
    ? over.services
    : [row({ label: 'a' }), row({ label: 'b', kind: 'interval', pid: null, state: 'idle', intervalSeconds: 600 })]
  return {
    services,
    counts: { total: 2, running: 1, idle: 1, down: 0, failed: 0 },
    summary: services ? summaryFor(services) : null,
    gateways: { openclaw: up(), hermes: up({ heartbeatAt: '2026-11-11T08:00:05.000Z' }) },
    ollama: up(),
    ...over,
  }
}

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
    row({ label: 'm-unknown', state: 'weird', kind: null, identified: false }),
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

  it('filters unidentified rows by the server flag, not by guessing from kind', () => {
    expect(filterServices(rows, 'unidentified', '').map((r) => r.label)).toEqual(['m-unknown'])
    const flagged = [row({ label: 'k', kind: 'keepalive', identified: false }), row({ label: 'n', kind: null, identified: true })]
    expect(filterServices(flagged, 'unidentified', '').map((r) => r.label)).toEqual(['k'])
  })

  it('takes All, Down and Unidentified from the server summary and counts only the kinds', () => {
    // Deliberately not what the rows say: the chips must show the server's tally.
    const summary = { total: 40, running: 30, idle: 6, down: 3, unidentified: 4 }
    expect(filterCounts(rows, summary)).toEqual({
      all: 40, down: 3, unidentified: 4, keepalive: 2, interval: 1, 'one-shot': 1,
    })
  })

  it('shows no number for a chip the server gave none for', () => {
    expect(filterCounts(rows, null)).toMatchObject({ all: null, down: null, unidentified: null, keepalive: 2 })
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
    expect(serviceHint(row({ kind: null, identified: false, plist: 'not-found' }))).toContain('not found')
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
  const texts = (v: ReturnType<typeof servicesVerdict>) => v.lines.map((l) => l.text)

  it('is healthy only when everything was read and nothing is down', () => {
    const v = servicesVerdict(data())
    expect(v).toMatchObject({
      state: 'healthy',
      text: 'No service is down (2 read)',
      detail: '1 running · 1 idle',
      note: null,
    })
    expect(v.lines).toEqual([{ state: 'healthy', text: 'No service is down (2 read)', reason: null, link: null }])
  })

  it('keeps services without a definition file as a calm note, never as an amber headline', () => {
    const unidentified = servicesVerdict(
      data({ services: [row({ label: 'a' }), row({ label: 'b', kind: null, identified: false, plist: 'not-found' }), row({ label: 'c', kind: null, identified: false, plist: 'unreadable' })] }),
    )
    expect(unidentified.state).toBe('healthy')
    expect(unidentified.text).toBe('No service is down (3 read)')
    expect(unidentified.note).toEqual({
      text: '2 services have no definition file, so their kind is unknown.',
      filter: 'unidentified',
      actionLabel: 'Show them',
    })
    const one = servicesVerdict(data({ services: [row({ kind: null, identified: false, plist: 'not-found' })] }))
    expect(one.note?.text).toBe('1 service has no definition file, so its kind is unknown.')
  })

  it('makes the unidentified note part of the state only through something actually down', () => {
    const v = servicesVerdict(
      data({ services: [row({ state: 'down', pid: null }), row({ kind: null, identified: false, plist: 'not-found' })] }),
    )
    expect(v.state).toBe('critical')
    expect(texts(v)).toEqual(['1 service is down'])
    expect(v.note).not.toBeNull()
  })

  it('gives a gateway warning its own line with the system reason and a link to where it is shown', () => {
    const v = servicesVerdict(data(), {
      openclaw: { state: 'warning', reason: 'OpenClaw status evidence is unavailable.', detailHref: '/services' },
      hermes: { state: 'healthy' },
    })
    expect(v.state).toBe('warning')
    expect(texts(v)).toEqual(['OpenClaw is reporting a warning', 'No service is down (2 read)'])
    expect(v.lines[0]).toEqual({
      state: 'warning',
      text: 'OpenClaw is reporting a warning',
      reason: 'OpenClaw status evidence is unavailable.',
      link: { kind: 'anchor', to: '#gateway-readings', label: 'See the gateway readings' },
    })
  })

  it('links to another screen when the system names one, and ignores an external address', () => {
    const away = servicesVerdict(data(), { hermes: { state: 'warning', reason: 'Board is stale.', detailHref: '/automations' } })
    expect(away.lines[0].link).toEqual({ kind: 'route', to: '/automations', label: 'See details' })
    const external = servicesVerdict(data(), { hermes: { state: 'warning', detailHref: 'https://example.com/x' } })
    expect(external.lines[0].link).toEqual({ kind: 'anchor', to: '#gateway-readings', label: 'See the gateway readings' })
    expect(external.lines[0].reason).toBeNull()
  })

  it('orders one short sentence per condition by severity', () => {
    const v = servicesVerdict(
      data({ services: [row({ state: 'down', pid: null }), row()], ollama: up({ state: 'down', reachable: false }) }),
      { openclaw: { state: 'warning', reason: 'r' }, hermes: { state: 'critical', reason: 'h' } },
    )
    expect(v.state).toBe('critical')
    expect(v.lines.map((l) => [l.state, l.text])).toEqual([
      ['critical', '1 service is down'],
      ['critical', 'Ollama is not reachable'],
      ['critical', 'Hermes is reporting a critical state'],
      ['warning', 'OpenClaw is reporting a warning'],
    ])
  })

  it('stays healthy when the shell reports the gateways healthy, unread or not at all', () => {
    expect(servicesVerdict(data(), { openclaw: { state: 'healthy' }, hermes: null }).state).toBe('healthy')
    expect(servicesVerdict(data(), { openclaw: { state: 'unavailable' } }).state).toBe('healthy')
    expect(servicesVerdict(data(), null).state).toBe('healthy')
  })

  it('reads down, unidentified and the detail line from the server summary', () => {
    // Rows say everything is running; the summary (the server's tally) is what the verdict reports.
    const v = servicesVerdict(data({ summary: { total: 9, running: 5, idle: 1, down: 3, unidentified: 0 } }))
    expect(v).toMatchObject({ state: 'critical', text: '3 services are down', detail: '5 running · 1 idle' })
    const u = servicesVerdict(data({ summary: { total: 9, running: 5, idle: 4, down: 0, unidentified: 2 } }))
    expect(u.text).toBe('No service is down (9 read)')
    expect(u.note?.text).toBe('2 services have no definition file, so their kind is unknown.')
    expect(servicesVerdict(data({ summary: { total: 9, running: 5, idle: 4, down: 0, unidentified: 0 } })).note).toBeNull()
  })

  it('is unavailable, not healthy, when the server sent rows but no summary', () => {
    const v = servicesVerdict(data({ summary: null }))
    expect(v).toMatchObject({ state: 'unavailable', text: 'The service summary could not be read' })
  })

  it('names down services', () => {
    const v = servicesVerdict(
      data({ services: [row({ state: 'down', pid: null }), row({ state: 'failed', pid: null, lastExitCode: 1 }), row()] }),
    )
    expect(v.state).toBe('critical')
    expect(v.text).toBe('2 services are down')
    expect(servicesVerdict(data({ services: [row({ state: 'down', pid: null })] })).text).toBe('1 service is down')
  })

  it('names unreachable endpoints on their own line, after down services', () => {
    const v = servicesVerdict(data({ ollama: up({ state: 'down', reachable: false }) }))
    expect(v).toMatchObject({ state: 'critical', text: 'Ollama is not reachable' })
    const both = servicesVerdict(
      data({ services: [row({ state: 'down', pid: null })], ollama: up({ state: 'down', reachable: false }) }),
    )
    expect(texts(both)).toEqual(['1 service is down', 'Ollama is not reachable'])
  })

  it('is not healthy when an endpoint or a service state was not read', () => {
    const endpoint = servicesVerdict(data({ ollama: up({ state: 'unknown', reachable: null }) }))
    expect(endpoint.state).toBe('unavailable')
    expect(texts(endpoint)).toContain('Ollama could not be read')
    expect(servicesVerdict(data({ gateways: null, ollama: null })).state).toBe('unavailable')
    const weird = servicesVerdict(data({ services: [row({ state: 'weird' })] }))
    expect(weird.state).toBe('unavailable')
    expect(texts(weird)).not.toContain('No service is down (1 read)')
    const stale = servicesVerdict(data({ gateways: { openclaw: up(), hermes: up({ state: 'stale' }) } }))
    expect(stale.state).toBe('warning')
    expect(texts(stale)[0]).toBe('Hermes gateway has not reported recently')
  })

  it('is not healthy for a missing or empty service list', () => {
    expect(servicesVerdict(null)).toMatchObject({ state: 'unavailable' })
    expect(servicesVerdict(undefined).state).toBe('unavailable')
    expect(servicesVerdict(data({ services: null, counts: null, summary: null })).state).toBe('unavailable')
    expect(servicesVerdict(data({ services: [] })).state).toBe('unavailable')
  })

  it('still reports unreachable endpoints when the service list is missing', () => {
    expect(servicesVerdict(data({ services: null, ollama: up({ state: 'down', reachable: false }) })).state).toBe('critical')
  })
})

describe('parseServiceFilter', () => {
  it('accepts the known filters and falls back to all', () => {
    expect(parseServiceFilter('down')).toBe('down')
    expect(parseServiceFilter('one-shot')).toBe('one-shot')
    expect(parseServiceFilter('unidentified')).toBe('unidentified')
    expect(parseServiceFilter('bogus')).toBe('all')
    expect(parseServiceFilter(null)).toBe('all')
  })
})
