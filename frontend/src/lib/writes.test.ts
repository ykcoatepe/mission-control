// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onWriteSucceeded, postForm, postJson, sendJson, useApi } from './hooks'
import { SIGNALS_URL } from './signals'
import { useAfterWriteRefresh } from './writes'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The shell: something reads /api/signals, and the app has mounted the after-write refresh once. */
function Shell() {
  useAfterWriteRefresh()
  useApi(SIGNALS_URL, 30_000)
  return null
}

function stub(options: { write?: () => Response; signals?: () => Response } = {}) {
  let signalReads = 0
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input, 'http://localhost').pathname
    if ((init?.method ?? 'GET') === 'GET') {
      if (path === SIGNALS_URL) {
        signalReads++
        return signalReads > 1 && options.signals ? options.signals() : json({ data: {}, meta: {} })
      }
      return json({})
    }
    return options.write ? options.write() : json({ ok: true })
  }))
  return { signalReads: () => signalReads }
}

async function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => root.render(createElement(QueryClientProvider, { client }, createElement(Shell))))
  await settle()
  return root
}
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)) })

afterEach(() => {
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('after a write, the shell signals are read again', () => {
  it('refetches /api/signals exactly once after a successful write', async () => {
    const server = stub()
    const root = await mount()
    expect(server.signalReads()).toBe(1)
    await act(async () => { await postJson('/api/anything', { a: 1 }) })
    await settle()
    expect(server.signalReads()).toBe(2)
    await act(async () => root.unmount())
  })

  it('does the same for every shared write helper', async () => {
    const server = stub()
    const root = await mount()
    await act(async () => { await sendJson('/api/x', 'PATCH', {}) })
    await settle()
    await act(async () => { await postForm('/api/y', new FormData()) })
    await settle()
    await act(async () => { await sendJson('/api/z', 'DELETE') })
    await settle()
    expect(server.signalReads()).toBe(4)
    await act(async () => root.unmount())
  })

  it('does not refetch after a failed write', async () => {
    const server = stub({ write: () => json({ error: { code: 'invalid', message: 'No' } }, 400) })
    const root = await mount()
    await act(async () => { await expect(postJson('/api/anything', {})).rejects.toMatchObject({ status: 400 }) })
    await settle()
    expect(server.signalReads()).toBe(1)
    await act(async () => root.unmount())
  })

  it('does not refetch for a read', async () => {
    const server = stub()
    const root = await mount()
    await act(async () => { await (await fetch('/api/x')).json() })
    expect(server.signalReads()).toBe(1)
    await act(async () => root.unmount())
  })

  it('a failing signals refetch never turns a successful write into an error', async () => {
    const server = stub({ signals: () => json({ error: { code: 'down', message: 'Signals are down' } }, 500) })
    const root = await mount()
    await expect(postJson('/api/anything', {})).resolves.toEqual({ ok: true })
    await settle()
    expect(server.signalReads()).toBe(2)
    await act(async () => root.unmount())
  })

  it('a listener that throws never fails the write, and a removed listener is not called', async () => {
    stub()
    const bad = vi.fn(() => { throw new Error('boom') })
    const gone = vi.fn()
    const offBad = onWriteSucceeded(bad)
    onWriteSucceeded(gone)()
    await expect(postJson('/api/anything', {})).resolves.toEqual({ ok: true })
    expect(bad).toHaveBeenCalledOnce()
    expect(gone).not.toHaveBeenCalled()
    offBad()
  })
})
