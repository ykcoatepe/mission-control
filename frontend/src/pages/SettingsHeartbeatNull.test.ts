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

function stubServer(heartbeat: string | null) {
  const sent: Array<{ url: string; body: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://localhost').pathname
      if ((init?.method ?? 'GET').toUpperCase() !== 'GET') {
        sent.push({ url, body: JSON.parse(String(init?.body ?? 'null')) })
        return json({ status: 'saved' })
      }
      if (url === '/api/models') return json([{ id: 'a/b', name: 'A B' }])
      if (url === '/api/settings/model-routing') return json({ main: 'a/b', subagent: 'a/b', heartbeat })
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

const heartbeatSelect = (host: HTMLElement) => {
  const label = [...host.querySelectorAll('label')].find((l) => l.textContent === 'Heartbeat model') as HTMLLabelElement
  return host.querySelector(`#${label.htmlFor}`) as HTMLSelectElement
}
const selectedText = (select: HTMLSelectElement) => select.options[select.selectedIndex]?.textContent

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('Settings: an unread heartbeat model', () => {
  it('says "Not read" when the server reports null, never "Inherit from main model"', async () => {
    stubServer(null)
    const { host, root } = await mount()
    expect(selectedText(heartbeatSelect(host))).toBe('Not read')
    expect(host.textContent).toContain('The current heartbeat model could not be read')
    await act(async () => root.unmount())
  })

  it('shows a configured heartbeat model as that model', async () => {
    stubServer('a/b')
    const { host, root } = await mount()
    expect(selectedText(heartbeatSelect(host))).toBe('A B')
    expect(host.textContent).not.toContain('The current heartbeat model could not be read')
    await act(async () => root.unmount())
  })

  it('offers "Inherit from main model" only as an explicit choice, and sends an empty value for it', async () => {
    const sent = stubServer(null)
    const { host, root } = await mount()
    const select = heartbeatSelect(host)
    const inherit = [...select.options].find((option) => option.textContent === 'Inherit from main model')
    expect(inherit).toBeDefined()
    await act(async () => {
      select.value = inherit!.value
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Save routing')) as HTMLButtonElement
    await act(async () => save.click())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(sent).toEqual([{ url: '/api/settings/model-routing', body: { heartbeat: '' } }])
    await act(async () => root.unmount())
  })
})
