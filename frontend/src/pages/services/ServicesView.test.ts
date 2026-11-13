// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ServicesView from './ServicesView'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const NOW = new Date().toISOString()
const META = { ok: true, stale: false, observedAt: NOW, ageMs: 0, error: null }
const up = { state: 'up', reachable: true, error: null, observedAt: NOW }

const SERVICES = {
  data: {
    services: [
      { label: 'ai.a', kind: 'keepalive', identified: true, pid: 1, lastExitCode: 0, state: 'running', runAtLoad: true, intervalSeconds: null, calendar: false, plist: 'read' },
      { label: 'ai.b', kind: null, identified: false, pid: 2, lastExitCode: null, state: 'running', runAtLoad: null, intervalSeconds: null, calendar: null, plist: 'not-found' },
    ],
    counts: null,
    summary: { total: 2, running: 2, idle: 0, down: 0, unidentified: 1 },
    gateways: { openclaw: up, hermes: up },
    ollama: up,
  },
  meta: META,
}

function signals(openclaw: unknown) {
  return {
    data: {
      systems: { gbrain: null, hermes: { state: 'healthy', observedAt: NOW, reason: null, detailHref: '/services' }, openclaw },
      attention: null,
      automations: null,
      loops: null,
      services: null,
      usage: null,
    },
    meta: META,
  }
}

async function mount(openclaw: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://localhost').pathname
      if (url === '/api/services') return json(SERVICES)
      if (url === '/api/signals') return json(signals(openclaw))
      return json({ error: { code: 'not_found', message: 'No API route' } }, 404)
    }),
  )
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, null, createElement(ServicesView)))),
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { host, root }
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('ServicesView verdict', () => {
  it('keeps unidentified services as a calm note and a healthy headline', async () => {
    const { host, root } = await mount({ state: 'healthy', observedAt: NOW, reason: null, detailHref: '/services' })
    const lines = [...host.querySelectorAll('[aria-label="Verdict"] li')]
    expect(lines).toHaveLength(1)
    expect(lines[0].getAttribute('data-state')).toBe('healthy')
    expect(lines[0].textContent).toBe('No service is down (2 read)')
    expect(host.textContent).toContain('1 service has no definition file, so its kind is unknown.')
    await act(async () => root.unmount())
  })

  it('raises one alarm line for a gateway warning, with the system reason and one action to the readings', async () => {
    const { host, root } = await mount({
      state: 'warning',
      observedAt: NOW,
      reason: 'OpenClaw status is unavailable.',
      detailHref: '/services',
    })
    const alarms = host.querySelectorAll('[role="status"][data-state="warning"], [role="alert"]')
    expect(alarms).toHaveLength(1)
    const alarm = alarms[0]
    expect(alarm.textContent).toContain('Caution')
    expect(alarm.textContent).toContain('OpenClaw is reporting a warning')
    expect(alarm.textContent).toContain('OpenClaw status is unavailable.')
    const actions = alarm.querySelectorAll('button')
    expect(actions).toHaveLength(1)
    expect(actions[0].textContent).toContain('See the gateway readings')
    expect(host.querySelector('#gateway-readings')).not.toBeNull()
    // The calm sentence stays, without colour or a second alarm.
    expect(host.textContent).toContain('No service is down (2 read)')
    await act(async () => root.unmount())
  })

  it('shows no alarm line when nothing is abnormal', async () => {
    const { host, root } = await mount({ state: 'healthy', observedAt: NOW, reason: null, detailHref: '/services' })
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(host.querySelector('[data-state="warning"]')).toBeNull()
    expect(host.querySelector('[data-state="critical"]')).toBeNull()
    await act(async () => root.unmount())
  })

  it('lists services as rows with a mark and a word, and annotates a fresh reading with nothing', async () => {
    const { host, root } = await mount(null)
    const row = [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('ai.a'))!
    expect(row.textContent).toContain('Running')
    expect(row.querySelector('svg[data-shape="circle"]')).not.toBeNull()
    expect(host.textContent).not.toMatch(/as of|not read/)
    await act(async () => root.unmount())
  })

  it('has no separate Note column: a note wraps under the service name', async () => {
    const { host, root } = await mount(null)
    expect([...host.querySelectorAll('th')].map((th) => th.textContent)).not.toContain('Note')
    const row = [...host.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.includes('ai.b'))!
    expect(row.querySelector('td')?.textContent).toContain('Definition file not found')
    await act(async () => root.unmount())
  })
})
