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

type Source = 'set' | 'unset' | 'unreadable'

function stubServer(heartbeat: string | null, heartbeatSource: Source, subagentSource: Source = 'set', subagent: string | null = 'a/b') {
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
      if (url === '/api/settings/model-routing') return json({ main: 'a/b', subagent, heartbeat, mainSource: 'set', subagentSource, heartbeatSource })
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

describe('Settings: unset and unreadable model routing', () => {
  it('says "Not read" when the server could not read the heartbeat model, never "Inherits the main model"', async () => {
    stubServer(null, 'unreadable')
    const { host, root } = await mount()
    expect(selectedText(heartbeatSelect(host))).toBe('Not read')
    expect(host.textContent).toContain('The current heartbeat model could not be read')
    await act(async () => root.unmount())
  })

  it('says "Inherits the main model" when the server reports the heartbeat model unset', async () => {
    stubServer(null, 'unset')
    const { host, root } = await mount()
    expect(selectedText(heartbeatSelect(host))).toBe('Inherits the main model')
    expect(host.textContent).not.toContain('could not be read')
    await act(async () => root.unmount())
  })

  it('shows an unset sub-agent model as inheriting, not as a copy of the main model', async () => {
    stubServer('a/b', 'set', 'unset', null)
    const { host, root } = await mount()
    const label = [...host.querySelectorAll('label')].find((l) => l.textContent === 'Sub-agent model') as HTMLLabelElement
    const select = host.querySelector(`#${label.htmlFor}`) as HTMLSelectElement
    expect(selectedText(select)).toBe('Inherits the main model')
    await act(async () => root.unmount())
  })

  it('shows an unreadable sub-agent model as not read', async () => {
    stubServer('a/b', 'set', 'unreadable', null)
    const { host, root } = await mount()
    const label = [...host.querySelectorAll('label')].find((l) => l.textContent === 'Sub-agent model') as HTMLLabelElement
    expect(selectedText(host.querySelector(`#${label.htmlFor}`) as HTMLSelectElement)).toBe('Not read')
    await act(async () => root.unmount())
  })

  it('shows a configured heartbeat model as that model', async () => {
    stubServer('a/b', 'set')
    const { host, root } = await mount()
    expect(selectedText(heartbeatSelect(host))).toBe('A B')
    expect(host.textContent).not.toContain('The current heartbeat model could not be read')
    await act(async () => root.unmount())
  })

  it('sends an empty value only when the person chooses "Inherits the main model"', async () => {
    const sent = stubServer('a/b', 'set')
    const { host, root } = await mount()
    const select = heartbeatSelect(host)
    const inherit = [...select.options].find((option) => option.textContent === 'Inherits the main model')
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

  it('does not send an unchanged unset heartbeat model when only another field is saved', async () => {
    const sent = stubServer(null, 'unset')
    const { host, root } = await mount()
    // Nothing changed: the save button stays disabled and nothing is sent.
    const save = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('Save routing')) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(sent).toEqual([])
    await act(async () => root.unmount())
  })
})
