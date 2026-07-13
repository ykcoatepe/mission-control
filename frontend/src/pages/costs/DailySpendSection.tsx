import { useEffect, useRef, useState, type CSSProperties } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import GlassCard from '../../components/GlassCard'
import {
  formatCurrency,
  formatTokens,
  formatPreciseCurrency,
  estimateCost,
  canonicalModelName,
  isLocalModel,
} from './lib'
import type { ChartDataRow, ChartSeriesItem, AWSSCostData } from './types'
import styles from './DailySpendSection.module.css'

// Internal tooltip — shared between this file and MobileDailySpendChart which lives in Costs.tsx
// We re-declare it here locally because we can't import it from Costs.tsx (would create circular dep).
interface TooltipPayloadItem {
  value?: string | number
  name?: string
  dataKey?: string | number
  color?: string
  payload?: Record<string, string | number | undefined>
}

function CustomChartTooltip({
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
    .filter((entry) => Number(entry.value || 0) > 0)
    .sort((a, b) => Number(b.value || 0) - Number(a.value || 0))
  if (!rows.length) return null
  const data = payload[0]?.payload || {}
  return (
    <div
      style={{
        padding: '12px 14px',
        borderRadius: 12,
        background: 'rgba(22,22,24,0.96)',
        border: '1px solid rgba(255,255,255,0.12)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.35)',
        minWidth: 220,
      }}
    >
      <div style={{ color: 'rgba(255,255,255,0.92)', fontSize: 13, fontWeight: 700, marginBottom: 6 }}>{label}</div>
      <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginBottom: 10 }}>
        Total: {formatCurrency(Number(data.total || 0))} · Tokens: {formatTokens(Number(data.totalTokens || 0))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        {rows.map((entry) => {
          const dataKey = String(entry.dataKey || '')
          const model = String(entry.name || dataKey)
          const tokenKey = `${dataKey}__tokens`
          const tokens = Number(data[tokenKey] || 0)
          const local = isLocalModel(model)
          return (
            <div key={dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ width: 10, height: 10, borderRadius: 999, background: entry.color || '#8E8E93', flexShrink: 0 }} />
                <span style={{ color: 'rgba(255,255,255,0.78)', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {canonicalModelName(model)}
                </span>
              </div>
              <span style={{ color: 'rgba(255,255,255,0.96)', fontSize: 11, fontWeight: 600, textAlign: 'right' }}>
                {local ? `${formatTokens(tokens)} tok` : `${formatCurrency(Number(entry.value || 0))} · ${formatTokens(tokens)} tok`}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface SessionEstimateDay {
  day: string
  fullDate: string
  estimatedCost: number
  tokens: number
  intensity: number
}

interface SessionEstimateChartLocal {
  data: SessionEstimateDay[]
  activeDate: string | null
  onSelect: (date: string) => void
}

function SessionEstimateChartLocal({ data, activeDate, onSelect }: SessionEstimateChartLocal) {
  const activeDay = data.find(day => day.fullDate === activeDate) || data[data.length - 1] || null
  return (
    <div className={styles.seChart}>
      <div
        className={styles.seBarGrid}
        style={{
          gridTemplateColumns: `repeat(${data.length}, minmax(0, 1fr))`,
          gap: 10,
        }}
      >
        {data.map(day => {
          const isActive = day.fullDate === activeDay?.fullDate
          const height = Math.max(day.intensity * 168, day.tokens > 0 ? 18 : 12)
          return (
            <button
              key={day.fullDate}
              type="button"
              onClick={() => onSelect(day.fullDate)}
              aria-pressed={isActive}
              className={styles.seBarBtn}
              style={{
                border: isActive ? '1px solid rgba(94,92,230,0.55)' : '1px solid rgba(255,255,255,0.08)',
                background: isActive
                  ? 'linear-gradient(180deg, rgba(94,92,230,0.22) 0%, rgba(20,24,38,0.86) 100%)'
                  : 'linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(12,14,22,0.7) 100%)',
                boxShadow: isActive ? '0 18px 44px rgba(94,92,230,0.24)' : 'none',
              }}
            >
              <div className={styles.seBarCost}>
                {day.estimatedCost > 0 ? formatCurrency(day.estimatedCost) : 'idle'}
              </div>
              <div
                className={styles.seBarTrack}
                style={{ height }}
              >
                <div
                  className={styles.seBarFill}
                  style={{
                    background: day.tokens > 0
                      ? 'linear-gradient(180deg, rgba(94,92,230,0.95) 0%, rgba(191,90,242,0.92) 52%, rgba(255,149,0,0.92) 100%)'
                      : 'rgba(255,255,255,0.12)',
                    opacity: day.tokens > 0 ? 1 : 0.4,
                  }}
                />
              </div>
              <span
                className={styles.seBarDay}
                style={{
                  color: isActive ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.5)',
                  fontWeight: isActive ? 700 : 500,
                }}
              >
                {day.day}
              </span>
            </button>
          )
        })}
      </div>
      {activeDay && (
        <div className={styles.seDetailBox}>
          <div>
            <div className={styles.seDetailLabel}>Date</div>
            <div className={styles.seDetailValue}>{activeDay.fullDate}</div>
          </div>
          <div>
            <div className={styles.seDetailLabel}>Estimated Spend</div>
            <div className={styles.seDetailValue}>{formatCurrency(activeDay.estimatedCost)}</div>
          </div>
          <div>
            <div className={styles.seDetailLabel}>Tokens</div>
            <div className={styles.seDetailValue}>{formatTokens(activeDay.tokens)}</div>
          </div>
        </div>
      )}
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

function MobileDailySpendChartLocal({
  chartData,
  chartSeries,
  activeDate,
  onSelect,
}: {
  chartData: ChartDataRow[]
  chartSeries: ChartSeriesItem[]
  activeDate: string | null
  onSelect: (date: string) => void
}) {
  const maxTotal = Math.max(...chartData.map(day => Number(day.total || 0)), 1)
  const activeDay = chartData.find(day => day.fullDate === activeDate) || chartData[chartData.length - 1] || null
  const activeSegments = activeDay ? buildDaySegments(activeDay, chartSeries) : []
  return (
    <div className={styles.mobileChartWrap}>
      <div className={styles.mobileChartNote}>
        Mobile uses a touch-first stacked view to avoid Safari/Recharts blank bars.
      </div>
      <div
        className={styles.mobileBarGrid}
        style={{
          gridTemplateColumns: `repeat(${chartData.length}, minmax(0, 1fr))`,
          gap: 8,
        }}
      >
        {chartData.map(day => {
          const total = Number(day.total || 0)
          const segments = buildDaySegments(day, chartSeries)
          const isActive = day.fullDate === activeDay?.fullDate
          const columnHeight = total > 0 ? Math.max((total / maxTotal) * 168, 18) : 14
          return (
            <button
              key={day.fullDate}
              type="button"
              onClick={() => onSelect(day.fullDate)}
              aria-pressed={isActive}
              aria-label={`Select ${day.fullDate} daily spend`}
              className={styles.mobileBarBtn}
              style={{
                border: isActive ? '1px solid rgba(10,132,255,0.5)' : '1px solid rgba(255,255,255,0.08)',
                background: isActive ? 'rgba(10,132,255,0.14)' : 'rgba(255,255,255,0.03)',
                boxShadow: isActive ? '0 10px 28px rgba(10,132,255,0.18)' : 'none',
              }}
            >
              <span className={styles.mobileBarCost}>
                {formatCurrency(total)}
              </span>
              <div
                className={styles.mobileBarStack}
                style={{ height: columnHeight }}
              >
                {segments.length > 0 ? (
                  segments.map(segment => {
                    const style: CSSProperties = {
                      height: `${Math.max((segment.value / total) * 100, 14)}%`,
                      background: segment.color,
                      minHeight: 8,
                    }
                    return <div key={segment.key} style={style} />
                  })
                ) : (
                  <div className={styles.mobileBarEmptyFill} />
                )}
              </div>
              <span
                className={styles.mobileBarDay}
                style={{
                  color: isActive ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.5)',
                  fontWeight: isActive ? 700 : 500,
                }}
              >
                {String(day.day)}
              </span>
            </button>
          )
        })}
      </div>
      {activeDay && (
        <div className={styles.mobileDetailBox}>
          <div className={styles.mobileDetailHeader}>
            <div>
              <div className={styles.mobileDetailDate}>{activeDay.fullDate}</div>
              <div className={styles.mobileDetailHint}>Tap another bar to inspect that day.</div>
            </div>
            <div className={styles.mobileDetailTotal}>{formatCurrency(Number(activeDay.total || 0))}</div>
          </div>
          <div className={styles.mobileDetailSegments}>
            {activeSegments.map(segment => (
              <div key={segment.key} className={styles.mobileDetailSegmentRow}>
                <div className={styles.mobileDetailSegmentLabel}>
                  <span className={styles.mobileDetailDot} style={{ background: segment.color }} />
                  <span className={styles.mobileDetailModelName}>
                    {segment.label}
                  </span>
                </div>
                <span className={styles.mobileDetailValue}>
                  {segment.local ? `${formatCurrency(0)} · ${formatTokens(segment.tokens)} tokens` : formatCurrency(segment.value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className={styles.mobileLegend}>
        {chartSeries.map(series => (
          <div key={series.key} className={styles.mobileLegendItem}>
            <span className={styles.mobileLegendDot} style={{ background: series.color }} />
            <span className={styles.mobileLegendLabel}>{series.model}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

interface BlendedCostItem {
  name: string
  amount: number
  share: number
  color: string
  secondary: string
  local?: boolean
}

export interface DailySpendSectionProps {
  m: boolean
  chartData: ChartDataRow[]
  chartSeries: ChartSeriesItem[]
  hasChartBars: boolean
  useMobileDailyChart: boolean
  activeChartDate: string | null
  setActiveChartDate: (d: string) => void
  chartDayCount: number
  codexbarActive: boolean
  ledgerActive: boolean
  hasAwsData: boolean
  awsCosts: AWSSCostData | null
  hasSessionEstimateChart: boolean
  sessionEstimateData: SessionEstimateDay[]
  projectedMonthly: number
  totalTokens: number
  tokenBasedCost: number
  blendedCostBreakdown: BlendedCostItem[]
  apiEquivalentReliability: string
}

export default function DailySpendSection({
  m,
  chartData,
  chartSeries,
  hasChartBars,
  useMobileDailyChart,
  activeChartDate,
  setActiveChartDate,
  chartDayCount,
  codexbarActive,
  ledgerActive,
  hasAwsData,
  awsCosts,
  hasSessionEstimateChart,
  sessionEstimateData,
  projectedMonthly,
  totalTokens,
  tokenBasedCost,
  blendedCostBreakdown,
  apiEquivalentReliability,
}: DailySpendSectionProps) {
  const chartFrameRef = useRef<HTMLDivElement | null>(null)
  const [chartSize, setChartSize] = useState({ width: 0, height: 0 })
  const chartHeight = m ? 300 : 360
  const apiEquivalentUnavailable = ledgerActive && (
    apiEquivalentReliability === 'unavailable' ||
    apiEquivalentReliability === 'not_applicable' ||
    apiEquivalentReliability === 'no_usage'
  )

  useEffect(() => {
    if (useMobileDailyChart || !hasChartBars) {
      return
    }

    const node = chartFrameRef.current
    if (!node) return

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
    if (typeof ResizeObserver === 'undefined') {
      return
    }

    const observer = new ResizeObserver(updateChartReady)
    observer.observe(node)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      observer.disconnect()
    }
  }, [chartData.length, hasChartBars, useMobileDailyChart])

  return (
    <div className={m ? `${styles.outerGrid} ${styles.outerGridMobile}` : styles.outerGrid}>
      <GlassCard delay={0.2} noPad>
        <div className={m ? `${styles.cardInner} ${styles.cardInnerMobile}` : styles.cardInner}>
          <div className={m ? `${styles.cardTitleBlock} ${styles.cardTitleBlockMobile}` : styles.cardTitleBlock}>
            <h3 className={m ? `${styles.cardTitle} ${styles.cardTitleMobile}` : styles.cardTitle}>
              Daily API Equivalent
            </h3>
            <div className={styles.cardSubtitle}>
              {chartDayCount > 0
                ? ledgerActive
                  ? apiEquivalentReliability === 'partial'
                    ? `${chartDayCount}-day partial public-list-price estimate; unpriced models are excluded.`
                    : apiEquivalentReliability === 'not_applicable'
                      ? 'API comparison does not apply to the all-local usage in this period.'
                      : apiEquivalentReliability === 'no_usage'
                        ? 'No model usage was recorded for this period.'
                      : apiEquivalentReliability === 'unavailable'
                        ? 'API equivalent is unavailable because this period has no priced model usage.'
                        : `${chartDayCount}-day all-source public-list-price estimate; included tracked spend remains separate.`
                  : codexbarActive
                    ? `${chartDayCount}-day CodexBar Codex + Claude estimate.`
                    : hasSessionEstimateChart && !ledgerActive && !hasAwsData
                    ? `${chartDayCount}-day activity view estimated from session token flow.`
                    : `${chartDayCount}-day usage-ledger spend movement; unknown/included costs are excluded from billable bars.`
                : 'Waiting for daily spend history.'}
            </div>
          </div>

          {apiEquivalentUnavailable ? (
            <div
              className={styles.tokenFallbackWrap}
              style={{ height: m ? '180px' : '240px' }}
            >
              <div className={styles.tokenFallbackTitle}>
                {apiEquivalentReliability === 'not_applicable'
                  ? 'API comparison not applicable'
                  : apiEquivalentReliability === 'no_usage'
                    ? 'No usage recorded'
                    : 'API equivalent unavailable'}
              </div>
              <div className={styles.tokenFallbackSub}>
                {apiEquivalentReliability === 'not_applicable'
                  ? 'This period contains local-model usage only, so there is no public API price to compare.'
                  : apiEquivalentReliability === 'no_usage'
                    ? 'There is no model activity to price for the selected period.'
                  : 'No public rate card is available for the models used in this period.'}
              </div>
            </div>
          ) : chartData.length > 0 ? (
            useMobileDailyChart ? (
              <MobileDailySpendChartLocal
                chartData={chartData}
                chartSeries={chartSeries}
                activeDate={activeChartDate}
                onSelect={setActiveChartDate}
              />
            ) : hasChartBars ? (
              <div
                ref={chartFrameRef}
                className={styles.rechartsWrap}
                style={{ height: chartHeight, minHeight: chartHeight }}
              >
                {chartSize.width > 0 && chartSize.height > 0 ? (
                  <BarChart
                    width={chartSize.width}
                    height={chartSize.height}
                    data={chartData}
                    margin={{ top: 8, right: 8, left: m ? -24 : -8, bottom: m ? 28 : 12 }}
                  >
                    <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                    <XAxis dataKey="fullDate" tickFormatter={val => { const d = new Date(val); return `${d.getMonth()+1}/${d.getDate()}` }} tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: m ? 10 : 11 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={value => formatPreciseCurrency(Number(value || 0))} tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: m ? 10 : 11 }} axisLine={false} tickLine={false} width={m ? 52 : 70} />
                    <Tooltip content={<CustomChartTooltip />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                    <Legend
                      verticalAlign="bottom"
                      align="center"
                      formatter={value => <span style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11 }}>{canonicalModelName(value)}</span>}
                      iconType="circle"
                      wrapperStyle={{ paddingTop: 12, fontSize: 11 }}
                    />
                    {chartSeries.map(series => (
                      <Bar
                        key={series.key}
                        dataKey={series.key}
                        name={series.model}
                        stackId="daily"
                        fill={series.color}
                        radius={[4, 4, 0, 0]}
                        minPointSize={3}
                        stroke="rgba(255,255,255,0.18)"
                        strokeWidth={0.6}
                      >
                        {chartData.map((_, index) => (
                          <Cell key={`${series.key}-${index}`} fill={series.color} />
                        ))}
                      </Bar>
                    ))}
                  </BarChart>
                ) : (
                  <div className={styles.chartSizingPlaceholder} aria-hidden="true" />
                )}
              </div>
            ) : (
              <div className={styles.fallbackWrap}>
                <div className={styles.fallbackNote}>
                  {codexbarActive
                    ? 'No local Codex or Claude spend was recorded for this period.'
                    : 'Recharts received data but visible bar height resolved to zero. Showing guaranteed CSS fallback.'}
                </div>
                <div
                  className={styles.fallbackBarList}
                  style={{ gap: m ? 4 : 6, height: m ? 220 : 260 }}
                >
                  {(() => {
                    const maxTotal = Math.max(...chartData.map(day => Number(day.total || 0)), 1)
                    return chartData.map(day => {
                      const total = Number(day.total || 0)
                      const segments = chartSeries
                        .map(series => ({
                          key: series.key,
                          label: series.model,
                          value: Number(day[series.key] || 0),
                          color: series.color,
                        }))
                        .filter(segment => segment.value > 0)
                      const columnHeight = total > 0 ? Math.max((total / maxTotal) * (m ? 180 : 220), 8) : 0
                      return (
                        <div key={String(day.fullDate)} className={styles.fallbackBarCol}>
                          <div
                            className={styles.fallbackBarStack}
                            style={{
                              height: columnHeight,
                              minHeight: total > 0 ? 8 : 0,
                            }}
                          >
                            {segments.map(segment => {
                              const style: CSSProperties = {
                                height: `${Math.max((segment.value / total) * 100, 14)}%`,
                                background: segment.color,
                                minHeight: 6,
                              }
                              return <div key={segment.key} style={style} title={`${segment.label}: ${formatCurrency(segment.value)}`} />
                            })}
                          </div>
                          <span
                            className={styles.fallbackBarLabel}
                            style={{ fontSize: m ? 9 : 10 }}
                          >{String(day.day)}</span>
                        </div>
                      )
                    })
                  })()}
                </div>
              </div>
            )
          ) : hasSessionEstimateChart ? (
            <div className={styles.sessionEstimateWrap}>
              <div
                className={styles.sessionEstimateStatGrid}
                style={{ gridTemplateColumns: m ? '1fr' : 'repeat(3, minmax(0, 1fr))' }}
              >
                <div className={styles.sessionEstimateStatCell}>
                  <div className={styles.sessionEstimateStatLabel}>Fallback Mode</div>
                  <div className={styles.sessionEstimateStatValue}>Session activity estimate</div>
                </div>
                <div className={styles.sessionEstimateStatCell}>
                  <div className={styles.sessionEstimateStatLabel}>Monthly Estimate</div>
                  <div className={styles.sessionEstimateStatValue}>{formatCurrency(projectedMonthly)}</div>
                </div>
                <div className={styles.sessionEstimateStatCell}>
                  <div className={styles.sessionEstimateStatLabel}>Observed Tokens</div>
                  <div className={styles.sessionEstimateStatValue}>{formatTokens(totalTokens)}</div>
                </div>
              </div>
              <SessionEstimateChartLocal
                data={sessionEstimateData}
                activeDate={activeChartDate}
                onSelect={setActiveChartDate}
              />
            </div>
          ) : hasAwsData && awsCosts ? (
            <div
              className={styles.awsBarList}
              style={{ height: m ? '180px' : '240px', gap: m ? '2px' : '4px', paddingTop: '20px' }}
            >
              {awsCosts.daily.map(day => {
                const maxCost = Math.max(...awsCosts.daily.map(d => d.cost), 10)
                const height = Math.max((day.cost / maxCost) * (m ? 140 : 200), 2)
                return (
                  <div key={day.date} className={styles.awsBarCol}>
                    <div
                      className={styles.awsBarFill}
                      style={{ height: `${height}px` }}
                      title={`${day.date}: ${formatCurrency(day.cost)}`}
                    />
                    <span
                      className={styles.awsBarLabel}
                      style={{ fontSize: m ? '7px' : '10px' }}
                    >
                      {new Date(day.date).toLocaleDateString('en-US', { day: 'numeric' })}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : (
            <div
              className={styles.tokenFallbackWrap}
              style={{ height: m ? '180px' : '240px' }}
            >
              <div className={styles.tokenFallbackTitle}>Using token-based cost estimation</div>
              <div className={styles.tokenFallbackSub}>
                Daily model history is not available yet.<br />
                Estimated {formatCurrency(tokenBasedCost)} this month from {formatTokens(totalTokens)} tokens.
              </div>
            </div>
          )}
        </div>
      </GlassCard>

      <GlassCard delay={0.25} noPad>
        <div className={m ? `${styles.cardInner} ${styles.cardInnerMobile}` : styles.cardInner}>
          <div className={m ? `${styles.cardTitleBlock} ${styles.cardTitleBlockMobile}` : styles.cardTitleBlock}>
            <h3 className={m ? `${styles.cardTitle} ${styles.cardTitleMobile}` : styles.cardTitle}>
              Spend Composition
            </h3>
            <div className={styles.cardSubtitle}>
              {hasAwsData ? 'Ranked from live AWS billing for the selected period.' : ledgerActive ? 'Ranked by all-source API-equivalent estimate for the selected period.' : codexbarActive ? 'Ranked from the latest local CodexBar Codex + Claude snapshot.' : 'Ranked view of the biggest drivers in the current view.'}
            </div>
          </div>
          <div
            className={styles.compositionList}
            style={{ gap: m ? '12px' : '16px' }}
          >
            {blendedCostBreakdown.length > 0 ? (
              blendedCostBreakdown.slice(0, m ? 5 : 7).map(item => (
                <div key={item.name} className={styles.compositionRow}>
                  <div className={styles.compositionTopLine}>
                    <div className={styles.compositionNameGroup}>
                      <span className={styles.compositionDot} style={{ background: item.color }} />
                      <span className={m ? `${styles.compositionName} ${styles.compositionNameMobile}` : styles.compositionName}>
                        {item.name}
                      </span>
                      {item.local ? <span className="macos-badge macos-badge-blue">Local</span> : null}
                    </div>
                    <span className={m ? `${styles.compositionSecondary} ${styles.compositionSecondaryMobile}` : styles.compositionSecondary}>
                      {item.secondary}
                    </span>
                  </div>
                  <div className={styles.compositionProgressTrack}>
                    <div
                      className={styles.compositionProgressFill}
                      style={{ width: `${Math.max(item.share, 2)}%`, background: item.color }}
                    />
                  </div>
                  <div
                    className={styles.compositionShareNote}
                    style={{ color: codexbarActive ? 'rgba(255,149,0,0.8)' : 'rgba(255,255,255,0.4)' }}
                  >{item.share.toFixed(1)}% of current mix</div>
                </div>
              ))
            ) : totalTokens > 0 ? (
              <div className={styles.compositionFallback}>
                <div className={styles.compositionFallbackRow}>
                  <span
                    className={styles.compositionFallbackLabel}
                    style={{ fontSize: m ? '12px' : '14px' }}
                  >OpenClaw Sessions</span>
                  <span
                    className={styles.compositionFallbackValue}
                    style={{ fontSize: m ? '12px' : '14px' }}
                  >
                    {formatCurrency(estimateCost(totalTokens, 'sonnet'))}
                  </span>
                </div>
                <div className={styles.compositionFallbackTrack}>
                  <div className={styles.compositionFallbackFill} />
                </div>
              </div>
            ) : (
              <div className={styles.compositionEmpty}>No usage data yet</div>
            )}
          </div>
        </div>
      </GlassCard>
    </div>
  )
}

export type { SessionEstimateDay, BlendedCostItem }
