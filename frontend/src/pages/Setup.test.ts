// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageTitleProvider, ToastProvider } from '../components/ui'
import Setup from './Setup'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const STATUS = {
  needsSetup: true,
  gatewayRunning: null,
  gatewayPort: 18789,
  gatewayVersion: null,
  detectedConfig: { dashboardName: 'Mission Control', model: 'amazon-bedrock/claude', channels: null, agentName: 'Mudur', workspacePath: '/work', gatewayTokenConfigured: true },
}

interface Sent {
  url: string
  method: string
  headers: Headers
  body: string
}

function stubServer(write: () => Response | Promise<Response>) {
  const sent: Sent[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost').pathname
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET') return json(STATUS)
      sent.push({ url, method, headers: new Headers(init?.headers), body: String(init?.body) })
      return write()
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
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          null,
          createElement(ToastProvider, null, createElement(PageTitleProvider, null, createElement(Setup))),
        ),
      ),
    ),
  )
  await flush()
  return { host, root }
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find(
    (b) => b.textContent?.includes(text) || b.getAttribute('aria-label') === text,
  ) as HTMLButtonElement

async function click(host: HTMLElement, text: string) {
  await act(async () => button(host, text).click())
  await flush()
}

const tokenInput = (host: HTMLElement) => host.querySelector('input[autocomplete="off"]') as HTMLInputElement

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Setup', () => {
  it('has no Scout step and no module choices, and keeps name and gateway detection', async () => {
    stubServer(() => json({ success: true }))
    const { host, root } = await mount()
    expect(host.textContent).toContain('OpenClaw gateway')
    expect(host.textContent).toContain('18789')
    // The server did not measure the gateway: it says so instead of "Not detected".
    expect(host.textContent).toContain('Not checked here')
    expect(host.textContent).toContain('Configured locally')
    await click(host, 'Continue')
    expect(host.textContent).toContain('Dashboard name')
    const all = host.textContent ?? ''
    for (const word of ['Scout', 'scout', 'Modules', 'workshop', 'skills', 'office', 'team', 'agents', 'chat', 'docs', 'AWS']) {
      expect(all, word).not.toContain(word)
    }
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    await act(async () => root.unmount())
  })

  it('shows the gateway token as a password field with a show/hide control, and never fills it', async () => {
    stubServer(() => json({ success: true }))
    const { host, root } = await mount()
    await click(host, 'Continue')
    const input = tokenInput(host)
    expect(input.type).toBe('password')
    expect(input.value).toBe('')
    expect(input.placeholder).toBe('Keep the configured token')
    await click(host, 'Show token')
    expect(tokenInput(host).type).toBe('text')
    await click(host, 'Hide token')
    expect(tokenInput(host).type).toBe('password')
    await act(async () => root.unmount())
  })

  it('does not say it is complete before anything is saved, and sends only the name', async () => {
    let finish: (response: Response) => void = () => undefined
    const pending = new Promise<Response>((resolve) => {
      finish = resolve
    })
    const sent = stubServer(() => pending)
    const { host, root } = await mount()
    await click(host, 'Continue')
    expect(host.textContent).not.toContain('Setup saved')
    await act(async () => button(host, 'Save and finish').click())
    // The request is in flight: still no "saved".
    expect(sent).toHaveLength(1)
    expect(host.textContent).not.toContain('Setup saved')
    expect(sent[0].url).toBe('/api/setup')
    expect(sent[0].headers.get('x-mc-request')).toBe('1')
    expect(JSON.parse(sent[0].body)).toEqual({ dashboardName: 'Mission Control' })
    await act(async () => finish(json({ success: true })))
    await flush()
    expect(host.textContent).toContain('Setup saved')
    await act(async () => root.unmount())
  })

  it('shows a failed save with the server message and stays on the form', async () => {
    stubServer(() => json({ error: { code: 'invalid_config', message: 'Invalid configuration' } }, 400))
    const { host, root } = await mount()
    await click(host, 'Continue')
    await click(host, 'Save and finish')
    expect(host.textContent).toContain('Nothing was saved')
    expect(host.textContent).toContain('Invalid configuration')
    expect(host.textContent).not.toContain('Setup saved')
    expect(button(host, 'Save and finish')).toBeDefined()
    await act(async () => root.unmount())
  })

  it('sends a typed token, and only then', async () => {
    const sent = stubServer(() => json({ success: true }))
    const { host, root } = await mount()
    await click(host, 'Continue')
    const input = tokenInput(host)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'typed-token')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(host, 'Save and finish')
    expect(JSON.parse(sent[0].body)).toEqual({ dashboardName: 'Mission Control', gateway: { token: 'typed-token' } })
    await act(async () => root.unmount())
  })

  it('shows an error state, not a form, when the machine could not be read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'settings_config_unavailable', message: 'OpenClaw configuration could not be read' } }, 503)))
    const { host, root } = await mount()
    expect(host.textContent).toContain('This machine could not be read')
    expect(host.textContent).toContain('OpenClaw configuration could not be read')
    expect(button(host, 'Continue')).toBeUndefined()
    await act(async () => root.unmount())
  })
})
