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

const unmeasuredTelemetry = {
  generatedAt: '2026-08-15T10:00:00Z',
  mode: 'unmeasured',
  estimated: false,
  telemetrySource: 'unmeasured',
  limitations: ['Per-model request counts, latency and errors are not measured by the Ollama inventory API.'],
  windowMs: null,
  models: [{
    name: 'llama3:8b', requestCount: null, errorCount: null, errorRate: null, avgLatencyMs: null, p95LatencyMs: null,
    requestsPerMinute: null, status: 'running', estimated: false,
  }],
}

let calls: string[] = []
let telemetryBody: unknown = telemetry
let modelBody: unknown | null = null
let costsBody: unknown = costs
let estimated = true
let root: Root | null = null
let host: HTMLElement | null = null

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost')
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    const bodies: Record<string, unknown> = {
      '/api/ollama/telemetry': telemetryBody,
      '/api/ollama/telemetry/history': { generatedAt: telemetry.generatedAt, history: [], total: 0 },
      '/api/ollama/telemetry/models': modelBody ?? modelTelemetry(estimated),
      '/api/costs': costsBody,
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
  telemetryBody = telemetry
  modelBody = null
  costsBody = costs
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
    expect(host!.textContent).toContain('4.20K tokens across these models')
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

describe('Local models page: unknown values stay unknown', () => {
  it('explains once, under the table, why the request columns are missing when nothing is measured', async () => {
    estimated = false
    modelBody = unmeasuredTelemetry
    await mount()
    const headers = Array.from(host!.querySelectorAll('th')).map(th => th.textContent)
    expect(headers).not.toContain('Requests/min')
    expect(headers).not.toContain('Error rate')
    const text = host!.textContent ?? ''
    expect(text).toContain('Requests per minute and error rate are not shown')
    expect(text.split('Requests per minute and error rate are not shown')).toHaveLength(2)
    expect(text).not.toContain('Request figures are not measured per model')
  })

  it('does not print a sampling window of "0 min" when the window is not reported', async () => {
    estimated = true
    modelBody = { ...modelTelemetry(true), windowMs: null }
    await mount()
    expect(host!.textContent).not.toMatch(/last 0 min/)
  })

  it('shows no request figures in the model drawer when they are null', async () => {
    estimated = false
    modelBody = unmeasuredTelemetry
    await mount()
    const row = Array.from(host!.querySelectorAll('tbody tr')).find(tr => tr.textContent?.includes('llama3:8b')) as HTMLElement
    await act(async () => { row.click() })
    const drawer = document.querySelector('[role="dialog"]') as HTMLElement
    expect(drawer.textContent).not.toContain('Requests/min')
    expect(drawer.textContent).not.toContain('Error rate')
    expect(drawer.textContent).not.toMatch(/Requests in window\s*0/)
  })

  it('says where the token figure comes from and counts only what the rows show', async () => {
    costsBody = {
      ...costs,
      byService: [
        { name: 'ollama/llama3:8b', tokens: 4200, sessions: 3, cost: 0, percentage: 50 },
        { name: 'Hermes / custom/Qwen3.8-Flash', tokens: 45220, cost: null, percentage: 50 },
      ],
    }
    await mount()
    const text = host!.textContent ?? ''
    expect(text).toContain('4.20K tokens across these models')
    expect(text).toContain('45.2K more by local endpoints not in this list')
    expect(text).not.toContain('49.4K')
  })

  it('does not claim tokens for the listed models when only other endpoints have usage', async () => {
    costsBody = { ...costs, byService: [{ name: 'Hermes / custom/Qwen3.8-Flash', tokens: 45220, cost: null }] }
    await mount()
    const text = host!.textContent ?? ''
    expect(text).toContain('No token usage recorded for these models')
    expect(text).toContain('45.2K more by local endpoints not in this list')
    expect(text).not.toMatch(/45\.2K tokens across these models/)
  })

  it('labels the Apple GPU counter as tiler load, and uses one decimal unit for sizes', async () => {
    telemetryBody = {
      ...telemetry,
      system: { ...telemetry.system, memory: { totalBytes: 137_438_953_472, freeBytes: 0, usedBytes: 93_805_674_496, usedPercent: 68 } },
      gpu: {
        available: true, platform: 'darwin', limited: false,
        devices: [{
          index: '0', name: 'Apple M4 Max', vendor: 'Apple', cores: '40', utilGpu: 0, utilMemory: 0,
          memTotalMiB: 4555, memUsedMiB: 1217, memFreeMiB: 3338, tempC: null, powerDraw: null, powerLimit: null,
          memUsedEstimate: false, metricSource: 'apple-ioreg', memorySource: 'apple-ioreg-unified-memory',
        }],
      },
    }
    await mount()
    const text = host!.textContent ?? ''
    expect(text).not.toContain('Memory pressure')
    expect(text).toContain('Tiler load')
    expect(text).toContain('93.8 GB of 137.4 GB')
    expect(text).toContain('1.3 GB of 4.8 GB allocated')
    expect(text).not.toMatch(/\bGiB\b/)
  })

  it('does not call a missing "can accept requests" flag a warning or a healthy state', async () => {
    telemetryBody = { ...telemetry, runtime: { runningModels: 1, totalModels: null } }
    await mount()
    const text = host!.textContent ?? ''
    expect(text).not.toContain('not accepting requests')
    expect(text).not.toContain('Ollama is running normally')
    expect(text).not.toContain('of null')
  })
})
