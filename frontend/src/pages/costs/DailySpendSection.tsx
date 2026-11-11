import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Bar, BarChart, CartesianGrid, Cell, Tooltip, XAxis, YAxis } from 'recharts'
import { EmptyState, Mono, Panel } from '../../components/ui'
import {
  formatCurrency,
  formatPreciseCurrency,
  formatTokens,
  formatTokenPhrase,
  canonicalModelName,
  isLocalModel,
} from './lib'
import type { ChartDataRow, ChartSeriesItem, AWSSCostData } from './types'
import styles from './DailySpendSection.module.css'

interface TooltipPayloadItem {
  value?: string | number
  name?: string
  dataKey?: string | number
  color?: string
  payload?: Record<string, string | number | undefined>
}

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: TooltipPayloadItem[]
  label?: string
}) {
  if (!active || !payload?.length) return null
  const rows = payload
    .filter(entry => Number(entry.value || 0) > 0)
    .sort((a, b) => Number(b.value || 0) - Number(a.value || 0))
  if (!rows.length) return null
  const data = payload[0]?.payload || {}
  return (
    <div className={styles.tooltip}>
      <div className={styles.tooltipDate}>{label}</div>
      <div className={styles.tooltipTotal}>
        {formatCurrency(Number(data.total || 0))} · {formatTokens(Number(data.totalTokens || 0))} tokens
      </div>
      <ul className={styles.tooltipRows}>
        {rows.map(entry => {
          const dataKey = String(entry.dataKey || '')
          const model = String(entry.name || dataKey)
          const tokens = Number(data[`${dataKey}__tokens`] || 0)
          const local = isLocalModel(model)
          return (
            <li key={dataKey} className={styles.tooltipRow}>
              <span className={styles.tooltipName}>
                <span className={styles.dot} style={{ background: entry.color }} />
                <span className={styles.nameText}>{canonicalModelName(model)}</span>
              </span>
              <Mono>
                {local ? `${formatTokens(tokens)} tok` : `${formatCurrency(Number(entry.value || 0))} · ${formatTokens(tokens)} tok`}
              </Mono>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

interface SessionEstimateDay {
  day: string
  fullDate: string
  estimatedCost: number | null
  tokens: number
  intensity: number
}

interface BarStripItem {
  key: string
  day: string
  /** 0..1 height relative to the busiest day. */
  share: number
  title: string
}

/** Token-only or AWS-cost bars for the sources that have no per-model rows. */
function BarStrip({
  items,
  activeKey,
  onSelect,
  label,
}: {
  items: BarStripItem[]
  activeKey: string | null
  onSelect?: (key: string) => void
  label: string
}) {
  return (
    <div
      className={styles.strip}
      style={{ '--cols': items.length } as CSSProperties}
      role="group"
      aria-label={label}
    >
      {items.map(item => {
        const active = item.key === activeKey
        const body = (
          <>
            <span className={styles.stripTrack}>
              <span className={styles.stripFill} style={{ height: `${Math.max(item.share * 100, item.share > 0 ? 2 : 0)}%` }} />
            </span>
            <span className={styles.stripDay}>{item.day}</span>
          </>
        )
        return onSelect ? (
          <button
            key={item.key}
            type="button"
            className={styles.stripBar}
            aria-pressed={active}
            title={item.title}
            onClick={() => onSelect(item.key)}
          >
            {body}
          </button>
        ) : (
          <div key={item.key} className={styles.stripBar} title={item.title}>
            {body}
          </div>
        )
      })}
    </div>
  )
}

function buildDaySegments(day: ChartDataRow, chartSeries: ChartSeriesItem[]) {
  return chartSeries
    .map(series => ({
      key: series.key,
      label: series.model,
      value: Number(day[series.key] || 0),
      tokens: Number(day[`${series.key}__tokens`] || 0),
      color: series.color,
      local: isLocalModel(series.model),
    }))
    .filter(segment => segment.value > 0 || segment.tokens > 0)
}

export interface DailySpendSectionProps {
  chartData: ChartDataRow[]
  chartSeries: ChartSeriesItem[]
  hasChartBars: boolean
  activeChartDate: string | null
  setActiveChartDate: (d: string) => void
  chartDayCount: number
  codexbarActive: boolean
  ledgerActive: boolean
  hasAwsData: boolean
  awsCosts: AWSSCostData | null
  hasSessionEstimateChart: boolean
  sessionEstimateData: SessionEstimateDay[]
  /** Null when the period's token total was not read. */
  totalTokens: number | null
  apiEquivalentReliability: string
}

const CHART_HEIGHT = 280

export default function DailySpendSection({
  chartData,
  chartSeries,
  hasChartBars,
  activeChartDate,
  setActiveChartDate,
  chartDayCount,
  codexbarActive,
  ledgerActive,
  hasAwsData,
  awsCosts,
  hasSessionEstimateChart,
  sessionEstimateData,
  totalTokens,
  apiEquivalentReliability,
}: DailySpendSectionProps) {
  const chartFrameRef = useRef<HTMLDivElement | null>(null)
  const [chartSize, setChartSize] = useState({ width: 0, height: 0 })
  const apiEquivalentUnavailable = ledgerActive && (
    apiEquivalentReliability === 'unavailable' ||
    apiEquivalentReliability === 'not_applicable' ||
    apiEquivalentReliability === 'no_usage'
  )

  // Selected-day drill-down, rendered under every branch that has per-day rows,
  // including the all-local ledger and the zero-cost fallback, where the
  // calendar's local-only heat would otherwise lead to a dead end.
  const activeDay = chartData.find(day => day.fullDate === activeChartDate) || null
  const activeDaySegments = activeDay ? buildDaySegments(activeDay, chartSeries) : []
  const dayDetailPanel = activeDay ? (
    <div className={styles.detail} data-testid="day-detail-panel">
      <div className={styles.detailHead}>
        <Mono>{String(activeDay.fullDate)}</Mono>
        <span className={styles.detailTotals}>
          {Number(activeDay.total || 0) > 0 && <Mono>{formatCurrency(Number(activeDay.total || 0))}</Mono>}
          <Mono muted>{formatTokens(Number(activeDay.totalTokens || 0))} tokens</Mono>
        </span>
      </div>
      {activeDaySegments.length > 0 && (
        <ul className={styles.segments}>
          {activeDaySegments.map(segment => (
            <li key={segment.key} className={styles.segment}>
              <span className={styles.dot} style={{ background: segment.color }} />
              <span className={styles.nameText}>{canonicalModelName(segment.label)}</span>
              <Mono muted>{segment.local ? `${formatTokens(segment.tokens)} tok` : formatCurrency(segment.value)}</Mono>
            </li>
          ))}
        </ul>
      )}
      <p className={styles.hint}>Select a bar or a calendar day to inspect another day.</p>
    </div>
  ) : null

  useEffect(() => {
    if (!hasChartBars) return undefined
    const node = chartFrameRef.current
    if (!node) return undefined

    let animationFrame = 0
    const updateChartReady = () => {
      window.cancelAnimationFrame(animationFrame)
      animationFrame = window.requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect()
        const width = Math.floor(rect.width)
        const height = Math.floor(rect.height)
        setChartSize(current => (
          current.width === width && current.height === height
            ? current
            : { width, height }
        ))
      })
    }

    updateChartReady()
    if (typeof ResizeObserver === 'undefined') return undefined

    const observer = new ResizeObserver(updateChartReady)
    observer.observe(node)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      observer.disconnect()
    }
  }, [chartData.length, hasChartBars])

  const dayWord = chartDayCount === 1 ? '1 day' : `${chartDayCount} days`
  const description = chartDayCount > 0
    ? ledgerActive
      ? apiEquivalentUnavailable
        ? dayWord
        : `${dayWord} · API equivalent${apiEquivalentReliability === 'partial' ? ', partial estimate' : ''}`
      : codexbarActive
        ? `${dayWord} · CodexBar estimate`
        : hasSessionEstimateChart
          ? `${dayWord} · tokens only, no cost data`
          : dayWord
    : 'Waiting for daily history.'

  let body
  if (apiEquivalentUnavailable) {
    body = (
      <>
        <EmptyState
          title={
            apiEquivalentReliability === 'not_applicable'
              ? 'No public price to compare'
              : apiEquivalentReliability === 'no_usage'
                ? 'No usage recorded'
                : 'API equivalent unavailable'
          }
          description={
            apiEquivalentReliability === 'not_applicable'
              ? 'This period has local-model usage only, so there is no spend to chart.'
              : apiEquivalentReliability === 'no_usage'
                ? 'There was no model activity to price in this period.'
                : 'No public price is available for the models used in this period.'
          }
        />
        {dayDetailPanel}
      </>
    )
  } else if (chartData.length > 0 && hasChartBars) {
    body = (
      <>
        <div ref={chartFrameRef} className={styles.chartFrame} style={{ height: CHART_HEIGHT }}>
          {chartSize.width > 0 && chartSize.height > 0 ? (
            <BarChart
              width={chartSize.width}
              height={chartSize.height}
              data={chartData}
              margin={{ top: 8, right: 8, left: 0, bottom: 4 }}
              onClick={state => {
                const label = (state as { activeLabel?: string | number } | null)?.activeLabel
                if (label !== undefined && label !== null) setActiveChartDate(String(label))
              }}
            >
              <CartesianGrid stroke="var(--line)" vertical={false} />
              <XAxis
                dataKey="fullDate"
                tickFormatter={val => { const d = new Date(val); return `${d.getMonth() + 1}/${d.getDate()}` }}
                tick={{ fill: 'var(--text-3)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tickFormatter={value => formatPreciseCurrency(Number(value || 0))}
                tick={{ fill: 'var(--text-3)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={64}
              />
              <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--surface-2)' }} />
              {chartSeries.map(series => (
                <Bar
                  key={series.key}
                  dataKey={series.key}
                  name={series.model}
                  stackId="daily"
                  fill={series.color}
                  minPointSize={2}
                  isAnimationActive={false}
                >
                  {chartData.map((row, index) => (
                    <Cell
                      key={`${series.key}-${index}`}
                      fill={series.color}
                      stroke={row.fullDate === activeChartDate ? 'var(--text-1)' : undefined}
                      strokeWidth={row.fullDate === activeChartDate ? 1.5 : undefined}
                    />
                  ))}
                </Bar>
              ))}
            </BarChart>
          ) : (
            <div className={styles.chartPlaceholder} aria-hidden="true" />
          )}
        </div>
        <ul className={styles.legend} aria-label="Models in the chart">
          {chartSeries.map(series => (
            <li key={series.key} className={styles.legendItem}>
              <span className={styles.dot} style={{ background: series.color }} />
              <span className={styles.nameText}>{canonicalModelName(series.model)}</span>
            </li>
          ))}
        </ul>
        {dayDetailPanel}
      </>
    )
  } else if (chartData.length > 0) {
    body = (
      <>
        <EmptyState
          title="No spend recorded"
          description={
            codexbarActive
              ? 'No local Codex or Claude spend was recorded in this period.'
              : 'No priced usage was recorded in this period.'
          }
        />
        {dayDetailPanel}
      </>
    )
  } else if (hasSessionEstimateChart) {
    const maxTokens = Math.max(...sessionEstimateData.map(day => day.tokens), 1)
    const activeSession = sessionEstimateData.find(day => day.fullDate === activeChartDate)
      || sessionEstimateData[sessionEstimateData.length - 1]
      || null
    body = (
      <>
        <BarStrip
          label="Tokens per day"
          items={sessionEstimateData.map(day => ({
            key: day.fullDate,
            day: day.day,
            share: day.tokens / maxTokens,
            title: `${day.fullDate} · ${formatTokens(day.tokens)} tokens`,
          }))}
          activeKey={activeSession?.fullDate ?? null}
          onSelect={setActiveChartDate}
        />
        {activeSession && (
          <div className={styles.detail}>
            <div className={styles.detailHead}>
              <Mono>{activeSession.fullDate}</Mono>
              <span className={styles.detailTotals}>
                <Mono muted>{formatTokens(activeSession.tokens)} tokens</Mono>
              </span>
            </div>
            <p className={styles.hint}>
              Session activity only: no cost is available for this period{totalTokens === null ? '.' : ` (${formatTokenPhrase(totalTokens, 'tokens observed')}).`}
            </p>
          </div>
        )}
      </>
    )
  } else if (hasAwsData && awsCosts) {
    const maxCost = Math.max(...awsCosts.daily.map(d => d.cost), 0)
    body = (
      <BarStrip
        label="AWS cost per day"
        items={awsCosts.daily.map(day => ({
          key: day.date,
          day: new Date(day.date).toLocaleDateString('en-US', { day: 'numeric' }),
          share: maxCost > 0 ? day.cost / maxCost : 0,
          title: `${day.date}: ${formatCurrency(day.cost)}`,
        }))}
        activeKey={null}
      />
    )
  } else {
    body = (
      <EmptyState
        title="Daily history is not available yet"
        description={
          totalTokens !== null && totalTokens > 0
            ? `No priced model ledger is available for ${formatTokens(totalTokens)} tokens.`
            : 'No usage has been recorded for this period.'
        }
      />
    )
  }

  return (
    <Panel title="Daily usage" description={description}>
      <div className={styles.body}>{body}</div>
    </Panel>
  )
}

export type { SessionEstimateDay }
