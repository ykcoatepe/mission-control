// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import DailySpendSection from '../pages/costs/DailySpendSection'
import type { ChartDataRow, ChartSeriesItem } from '../pages/costs/types'
import { CHART_TOOLTIP_PROPS } from './chartTooltip'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

describe('chart tooltips do not travel', () => {
  it('the shared configuration has no position animation and keeps the card inside the chart', () => {
    expect(CHART_TOOLTIP_PROPS.isAnimationActive).toBe(false)
    expect(CHART_TOOLTIP_PROPS.animationDuration).toBe(0)
    expect(CHART_TOOLTIP_PROPS.allowEscapeViewBox).toEqual({ x: false, y: false })
  })

  it('every file that draws a Recharts tooltip applies it', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx$/.test(name)) files.push(path)
      }
    }
    walk(join(__dirname, '..'))
    const users = files.filter((file) => /import[^;]*\bTooltip\b[^;]*from 'recharts'/s.test(readFileSync(file, 'utf8')))
    expect(users.length).toBeGreaterThan(0)
    for (const file of users) {
      const tooltips = readFileSync(file, 'utf8').match(/<Tooltip\b[^>]*?\/>/gs) ?? []
      expect(tooltips.length, file).toBeGreaterThan(0)
      for (const tag of tooltips) expect(tag, file).toContain('{...CHART_TOOLTIP_PROPS}')
    }
  })
})

describe('the Daily usage tooltip as rendered', () => {
  const series: ChartSeriesItem[] = [{ model: 'claude-sonnet', identity: 'sonnet', key: 'm0', color: 'var(--chart-1)', totalCost: 9, totalTokens: 9000 }]
  const rows = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04'].map((fullDate, i) => ({
    day: String(i + 1),
    fullDate,
    total: 2 + i,
    totalTokens: 1000 * (i + 1),
    m0: 2 + i,
    m0__tokens: 1000 * (i + 1),
  })) as unknown as ChartDataRow[]
  const props = {
    chartData: rows,
    chartSeries: series,
    hasChartBars: true,
    activeChartDate: null,
    setActiveChartDate: () => {},
    chartDayCount: 4,
    codexbarActive: false,
    ledgerActive: true,
    hasAwsData: false,
    awsCosts: null,
    hasSessionEstimateChart: false,
    sessionEstimateData: [],
    totalTokens: 10000,
    apiEquivalentReliability: 'complete',
  }

  const realRect = Element.prototype.getBoundingClientRect
  const RealObserver = globalThis.ResizeObserver
  const realFrame = window.requestAnimationFrame

  beforeEach(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    }
    Element.prototype.getBoundingClientRect = function (this: Element) {
      return { left: 0, top: 0, right: 600, bottom: 280, width: 600, height: 280, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    }
  })

  afterEach(() => {
    Element.prototype.getBoundingClientRect = realRect
    globalThis.ResizeObserver = RealObserver
    window.requestAnimationFrame = realFrame
    document.body.innerHTML = ''
  })

  it('moves with the pointer, with no transition on the wrapper', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(DailySpendSection, props)))
    const wrapper = host.querySelector('.recharts-tooltip-wrapper') as HTMLElement | null
    expect(wrapper).not.toBeNull()
    const chart = host.querySelector('.recharts-wrapper') as HTMLElement
    await act(async () => {
      chart.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 500, clientY: 100 }))
    })
    expect(wrapper?.style.transition ?? '').toBe('')
    await act(async () => root.unmount())
  })
})
