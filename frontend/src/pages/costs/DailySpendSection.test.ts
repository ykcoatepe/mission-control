// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import DailySpendSection from './DailySpendSection'
import type { ChartDataRow, ChartSeriesItem } from './types'

const localSeries: ChartSeriesItem[] = [
  { model: 'ollama/llama3', identity: 'llama3', key: 'm0', color: 'var(--series-6)', totalCost: 0, totalTokens: 9000 },
]

const localOnlyRows = [
  { day: '1', fullDate: '2026-08-01', total: 0, totalTokens: 4000, m0: 0, m0__tokens: 4000 },
  { day: '2', fullDate: '2026-08-02', total: 0, totalTokens: 5000, m0: 0, m0__tokens: 5000 },
] as unknown as ChartDataRow[]

const baseProps = {
  chartData: localOnlyRows,
  chartSeries: localSeries,
  hasChartBars: false,
  activeChartDate: '2026-08-02',
  setActiveChartDate: () => {},
  chartDayCount: 2,
  codexbarActive: false,
  ledgerActive: true,
  hasAwsData: false,
  awsCosts: null,
  hasSessionEstimateChart: false,
  sessionEstimateData: [],
  totalTokens: 9000,
  apiEquivalentReliability: 'not_applicable',
}

async function renderSection(props: typeof baseProps) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(createElement(DailySpendSection, props)))
  return { host, root }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('DailySpendSection selected-day detail reachability', () => {
  it('shows the day detail panel for an all-local ledger period', async () => {
    // The calendar deliberately gives local-only days heat; clicking one lands
    // here on the not_applicable branch, which must still offer the drill-down.
    const { host } = await renderSection(baseProps)
    const panel = host.querySelector('[data-testid="day-detail-panel"]')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('2026-08-02')
    expect(panel?.textContent).toContain('5,000 tokens')
  })

  it('shows the day detail panel on the zero-cost CSS fallback branch', async () => {
    const { host } = await renderSection({
      ...baseProps,
      ledgerActive: false,
      codexbarActive: true,
      apiEquivalentReliability: 'estimated',
    })
    const panel = host.querySelector('[data-testid="day-detail-panel"]')
    expect(panel).not.toBeNull()
    expect(panel?.textContent).toContain('2026-08-02')
  })
})

describe('DailySpendSection chart accessibility', () => {
  const rows = [
    { day: '1', fullDate: '2026-08-01', total: 10, totalTokens: 100, m0: 10, m0__tokens: 100 },
    { day: '2', fullDate: '2026-08-02', total: 30, totalTokens: 300, m0: 30, m0__tokens: 300 },
  ] as unknown as ChartDataRow[]

  it('is a named picture: role img with a summary, and nothing inside it takes Tab focus', async () => {
    const { host } = await renderSection({
      ...baseProps,
      chartData: rows,
      hasChartBars: true,
      ledgerActive: true,
      apiEquivalentReliability: 'estimated',
    })
    const chart = host.querySelector('[role="img"]')
    expect(chart).not.toBeNull()
    expect(chart?.getAttribute('aria-label')).toBe('Daily spend, 2 days, $40.00 in total. Busiest day 2026-08-02, $30.00.')
    expect(chart?.querySelectorAll('[tabindex]:not([tabindex="-1"])').length).toBe(0)
    expect(chart?.getAttribute('tabindex')).toBeNull()
  })
})
