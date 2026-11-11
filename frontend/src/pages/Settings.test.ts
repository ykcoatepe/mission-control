// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToastProvider } from '../components/ui'
import Settings from './Settings'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

interface Sent {
  url: string
  method: string
  headers: Headers
  body: BodyInit | null | undefined
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A fake server: reads answer, writes are recorded and answered by `onWrite`. */
function stubServer(onWrite: (sent: Sent) => Response) {
  const sent: Sent[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost').pathname
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method !== 'GET') {
        const record = { url, method, headers: new Headers(init?.headers), body: init?.body }
        sent.push(record)
        return onWrite(record)
      }
      if (url === '/api/models') return json([{ id: 'a/b', name: 'A B' }, { id: 'c/d', name: 'C D' }])
      if (url === '/api/settings/model-routing') return json({ main: 'a/b', subagent: null, heartbeat: null, mainSource: 'set', subagentSource: 'unset', heartbeatSource: 'unset' })
      if (url === '/api/settings') return json({ gateway_port: 18789, system: { node_version: 'v24' } })
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

const labelFor = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('label')].find((label) => label.textContent === text) as HTMLLabelElement
const select = (host: HTMLElement, text: string) => host.querySelector(`#${labelFor(host, text).htmlFor}`) as HTMLSelectElement
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement

async function choose(input: HTMLSelectElement, value: string) {
  await act(async () => {
    input.value = value
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Settings: model routing', () => {
  it('sends only the changed field, with the write header', async () => {
    const sent = stubServer(() => json({ status: 'saved' }))
    const { host, root } = await mount()
    await choose(select(host, 'Heartbeat model'), 'c/d')
    await act(async () => button(host, 'Save routing').click())
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('/api/settings/model-routing')
    expect(JSON.parse(String(sent[0].body))).toEqual({ heartbeat: 'c/d' })
    expect(sent[0].headers.get('x-mc-request')).toBe('1')
    await act(async () => root.unmount())
  })

  it('does not send the inherited sub-agent model when only main changed', async () => {
    const sent = stubServer(() => json({ status: 'saved' }))
    const { host, root } = await mount()
    await choose(select(host, 'Main model'), 'c/d')
    await act(async () => button(host, 'Save routing').click())
    await flush()
    expect(JSON.parse(String(sent[0].body))).toEqual({ main: 'c/d' })
    await act(async () => root.unmount())
  })

  it('shows the server 400 next to the field that was sent', async () => {
    stubServer(() => json({ error: { code: 'invalid_model', message: 'Model fields must contain a valid model identifier' } }, 400))
    const { host, root } = await mount()
    await choose(select(host, 'Heartbeat model'), 'c/d')
    await act(async () => button(host, 'Save routing').click())
    await flush()
    const describedBy = select(host, 'Heartbeat model').getAttribute('aria-describedby') ?? ''
    const message = describedBy.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
    expect(message).toContain('Model fields must contain a valid model identifier')
    expect(select(host, 'Heartbeat model').getAttribute('aria-invalid')).toBe('true')
    expect(select(host, 'Main model').getAttribute('aria-invalid')).toBeNull()
    await act(async () => root.unmount())
  })
})

describe('Settings: heartbeat', () => {
  it('offers only durations the server accepts', async () => {
    stubServer(() => json({ status: 'saved' }))
    const { host, root } = await mount()
    const values = [...select(host, 'Check interval').options].map((option) => option.value).filter(Boolean)
    expect(values.length).toBeGreaterThan(0)
    for (const value of values) expect(value).toMatch(/^\d+(?:ms|s|m|h|d)$/)
    await act(async () => root.unmount())
  })

  it('posts the chosen interval', async () => {
    const sent = stubServer(() => json({ status: 'saved' }))
    const { host, root } = await mount()
    await choose(select(host, 'Check interval'), '30m')
    await act(async () => button(host, 'Save interval').click())
    await flush()
    expect(JSON.parse(String(sent[0].body))).toEqual({ interval: '30m' })
    await act(async () => root.unmount())
  })
})

describe('Settings: import', () => {
  async function importFile(host: HTMLElement) {
    const input = host.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['{}'], 'mc-config.json', { type: 'application/json' })
    Object.defineProperty(input, 'files', { value: [file], configurable: true })
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
  }

  it('uploads the file as a guarded form post and keeps the restart notice after success', async () => {
    const sent = stubServer(() => json({ status: 'imported', message: 'Configuration imported successfully. Restart required.' }))
    const { host, root } = await mount()
    await importFile(host)
    expect(sent[0].url).toBe('/api/settings/import')
    expect(sent[0].body).toBeInstanceOf(FormData)
    expect(sent[0].headers.get('x-mc-request')).toBe('1')
    expect(sent[0].headers.get('content-type')).toBeNull()
    expect(host.textContent).toContain('Restart required')
    await act(async () => root.unmount())
  })

  it('shows the 400 that names the path, and no restart notice', async () => {
    stubServer(() => json({ error: { code: 'invalid_config', message: 'Ambiguous redacted value at gateway.token' } }, 400))
    const { host, root } = await mount()
    await importFile(host)
    expect(host.textContent).toContain('This file was not imported')
    expect(host.textContent).toContain('Ambiguous redacted value at gateway.token')
    expect(host.textContent).not.toContain('Restart required')
    await act(async () => root.unmount())
  })
})
