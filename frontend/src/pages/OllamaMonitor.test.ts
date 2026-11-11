// @vitest-environment jsdom

// The Local models page is a read-only surface: it reads telemetry and token usage,
// never changes Ollama, and does not present sampled figures as measured ones.

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import OllamaMonitor from './OllamaMonitor'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const telemetry = {
  generatedAt: '2026-08-15T10:00:00Z',
  healthScore: 96,
  alerts: [],
  server: { baseUrl: 'http://127.0.0.1:11434', status: 'online', enabled: true, host: '127.0.0.1', port: 11434, latencyMs: 12, version: '0.5.0' },
  runtime: { runningModels: 1, totalModels: 1, canAcceptRequests: true },
  models: [{ name: 'llama3:8b', status: 'running', sizeLabel: '4.7 GB' }],
  system: {
    cpu: { cores: 8, load1: 1, load5: 1, load15: 1, usagePercent: 10 },
    memory: { totalBytes: 16e9, freeBytes: 8e9, usedBytes: 8e9, usedPercent: 50 },
    node: { uptimeSeconds: 1000 },
    measuredAt: '2026-08-15T10:00:00Z',
  },
  gpu: { available: false, devices: [] },
}

const modelTelemetry = (estimated: boolean) => ({
  generatedAt: '2026-08-15T10:00:00Z',
  mode: estimated ? 'probe' : 'log',
  estimated,
  telemetrySource: estimated ? 'health probe' : 'request log',
  windowMs: 900_000,
  models: [{
    name: 'llama3:8b', requestCount: 12, errorCount: 1, errorRate: 0.08, avgLatencyMs: 100, p95LatencyMs: 200,
    requestsPerMinute: 0.8, status: 'running', estimated,
  }],
})

const costs = {
  source: 'token-usage.csv',
  period: { key: 'month' },
  summary: { periodTokens: 4200 },
  byService: [{ name: 'ollama/llama3:8b', tokens: 4200, sessions: 3, cost: 0, percentage: 100 }],
  meta: { updatedAt: '2026-08-15T10:00:00Z' },
}

let calls: string[] = []
let estimated = true
let root: Root | null = null
let host: HTMLElement | null = null

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    const bodies: Record<string, unknown> = {
      '/api/ollama/telemetry': telemetry,
      '/api/ollama/telemetry/history': { generatedAt: telemetry.generatedAt, history: [], total: 0 },
      '/api/ollama/telemetry/models': modelTelemetry(estimated),
      '/api/costs': costs,
    }
    const body = bodies[url.pathname] ?? {}
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    }
  }))
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root!.render(createElement(MemoryRouter, null, createElement(QueryClientProvider, { client }, createElement(OllamaMonitor)))))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
}

const count = (path: string) => calls.filter(call => call === `GET ${path}`).length

beforeEach(() => {
  calls = []
  estimated = true
  stubFetch()
})

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  host?.remove()
  host = null
  vi.unstubAllGlobals()
})

describe('Local models page', () => {
  it('shows the model with its token usage for the period', async () => {
    await mount()
    expect(host!.textContent).toContain('llama3:8b')
    expect(host!.textContent).toContain('4.20K tokens by local models')
  })

  it('refreshes health, history, model telemetry and token usage together on manual refresh', async () => {
    await mount()
    const before = {
      telemetry: count('/api/ollama/telemetry'),
      history: count('/api/ollama/telemetry/history'),
      models: count('/api/ollama/telemetry/models'),
      costs: count('/api/costs?period=month'),
    }
    const refresh = Array.from(host!.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Refresh')
    expect(refresh).toBeDefined()
    await act(async () => { refresh!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(count('/api/ollama/telemetry')).toBe(before.telemetry + 1)
    expect(count('/api/ollama/telemetry/history')).toBe(before.history + 1)
    expect(count('/api/ollama/telemetry/models')).toBe(before.models + 1)
    expect(count('/api/costs?period=month')).toBe(before.costs + 1)
  })

  it('says sampled model telemetry is not measured per model, and withholds request and error figures', async () => {
    estimated = true
    await mount()
    const text = host!.textContent ?? ''
    expect(text).toContain('Request figures are not measured per model')
    expect(text).toContain('samples')
    expect(text).not.toMatch(/estimated telemetry/i)
    const headers = Array.from(host!.querySelectorAll('th')).map(th => th.textContent)
    expect(headers).not.toContain('Requests/min')
    expect(headers).not.toContain('Error rate')
  })

  it('shows request and error figures only when they are measured', async () => {
    estimated = false
    await mount()
    expect(host!.textContent).not.toContain('Request figures are not measured per model')
    const headers = Array.from(host!.querySelectorAll('th')).map(th => th.textContent)
    expect(headers).toEqual(expect.arrayContaining(['Requests/min', 'Error rate']))
  })

  it('stays read-only: it only reads, and offers no optimization controls', async () => {
    await mount()
    const refresh = Array.from(host!.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Refresh')
    await act(async () => { refresh!.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter(call => !call.startsWith('GET '))).toEqual([])
    expect(calls.some(call => call.includes('/api/ollama/optimization'))).toBe(false)
    expect(host!.textContent).not.toContain('Save to apply')
    expect(host!.textContent).not.toContain('Rolling back')
  })
})
