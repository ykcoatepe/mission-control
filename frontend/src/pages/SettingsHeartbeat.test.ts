// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/ui'
import Settings from './Settings'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** `heartbeat`: what GET /api/settings/heartbeat answers; 'fail' answers 503 (the config could not be read). */
function stubServer(heartbeat: unknown) {
  const sent: Array<{ url: string; body: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost').pathname
      if ((init?.method ?? 'GET').toUpperCase() !== 'GET') {
        sent.push({ url, body: JSON.parse(String(init?.body ?? 'null')) })
        return json({ status: 'saved' })
      }
      if (url === '/api/models') return json([])
      if (url === '/api/settings/model-routing') {
        return json({ main: 'a/b', subagent: 'a/b', heartbeat: 'a/b', mainSource: 'set', subagentSource: 'set', heartbeatSource: 'set' })
      }
      if (url === '/api/settings/heartbeat') {
        return heartbeat === 'fail'
          ? json({ error: { code: 'settings_config_unavailable', message: 'OpenClaw configuration could not be read' } }, 503)
          : json({ interval: heartbeat })
      }
      if (url === '/api/settings') return json({ gateway_port: 18789, system: {} })
      return json({ error: { code: 'not_found', message: 'No API route' } }, 404)
    }),
  )
  return sent
}

async function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(ToastProvider, null, createElement(Settings)))),
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { host, root }
}

const panel = (host: HTMLElement) =>
  [...host.querySelectorAll('section')].find((s) => s.textContent?.includes('How often the assistant checks in')) as HTMLElement
const select = (host: HTMLElement) => panel(host).querySelector('select') as HTMLSelectElement
const selectedText = (el: HTMLSelectElement) => el.options[el.selectedIndex]?.textContent
const saveButton = (host: HTMLElement) =>
  [...panel(host).querySelectorAll('button')].find((b) => b.textContent?.includes('Save interval')) as HTMLButtonElement

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Settings: heartbeat interval', () => {
  it('reads and shows the configured interval', async () => {
    stubServer('30m')
    const { host, root } = await mount()
    expect(selectedText(select(host))).toBe('Every 30 minutes')
    expect(panel(host).textContent).toContain('Currently every 30 minutes.')
    expect(saveButton(host).disabled).toBe(true)
    await act(async () => root.unmount())
  })

  it('shows an interval that is not a preset, and calls a zero interval off', async () => {
    stubServer('45s')
    const first = await mount()
    expect(selectedText(select(first.host))).toBe('Every 45 seconds')
    await act(async () => first.root.unmount())
    document.body.innerHTML = ''

    stubServer('0m')
    const second = await mount()
    expect(selectedText(select(second.host))).toBe('Off (0m)')
    expect(panel(second.host).textContent).toContain('Heartbeat checks are off')
    expect(panel(second.host).textContent).not.toContain('Every 0')
    await act(async () => second.root.unmount())
  })

  it('says nothing is set when the server reports no interval, and "could not be read" only for a failed read', async () => {
    stubServer(null)
    const unset = await mount()
    expect(panel(unset.host).textContent).toContain('No interval is set.')
    expect(panel(unset.host).textContent).not.toContain('could not be read')
    expect(selectedText(select(unset.host))).toBe('Choose an interval')
    await act(async () => unset.root.unmount())
    document.body.innerHTML = ''

    stubServer('fail')
    const failed = await mount()
    expect(panel(failed.host).textContent).toContain('The current interval could not be read.')
    await act(async () => failed.root.unmount())
  })

  it('sends only a chosen interval, and only once it differs from the configured one', async () => {
    const sent = stubServer('30m')
    const { host, root } = await mount()
    const el = select(host)
    await act(async () => {
      el.value = '1h'
      el.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(saveButton(host).disabled).toBe(false)
    await act(async () => saveButton(host).click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(sent).toEqual([{ url: '/api/settings/heartbeat', body: { interval: '1h' } }])
    await act(async () => root.unmount())
  })
})
