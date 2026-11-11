import { Notice, Stat, StatRow } from '../../components/ui'
import type { UiState } from '../../lib/state'
import { calculateTrend, formatCompactTokenValue, formatCurrency, formatTokens } from './lib'
import styles from './UsageSummary.module.css'

type Trend = ReturnType<typeof calculateTrend>

export interface UsageSummaryProps {
  /** `api-equivalent` = public-list-price estimate; `tracked` = live billing (AWS). */
  mode: 'tracked' | 'api-equivalent'
  /** "November 2026", "Today", "Last 7 days", "This month". */
  periodName: string
  periodCost: number | null
  previousPeriodCost: number | null
  trend: Trend
  /** "vs previous month". */
  compareLabel: string
  dailyPace: number | null
  projection: number | null
  /** A finished month is a total, not a projection: the projection stat is omitted. */
  completePeriod: boolean
  /** Billed / tracked spend for the period; null when billing coverage is unavailable. */
  trackedSpend: number | null
  trackedNote: string | null
  periodTokens: number
  reliability: string
  /** One sentence per source problem; empty when all sources were read. */
  sourceIssues: string[]
  sourceIssueTone: UiState | 'info'
}

function trendText(trend: Trend) {
  if (!trend) return null
  if (trend.label) return `${trend.direction === 'up' ? 'Up' : 'Down'} ${trend.label}`
  if (trend.percentage === null) return trend.direction === 'up' ? 'Up' : 'Down'
  return `${trend.direction === 'up' ? 'Up' : 'Down'} ${trend.percentage.toFixed(trend.percentage >= 100 ? 0 : 1)}%`
}

function estimateNotice(reliability: string): { tone: UiState | 'info'; title: string; body: string } {
  const note = 'API equivalent is what this usage would cost at public list prices. It is an estimate, not an invoice; tracked spend is what billing data shows.'
  switch (reliability) {
    case 'partial':
      return {
        tone: 'info',
        title: 'Partial estimate, not an invoice',
        body: `Models without an exact public price use a generic rate. ${note}`,
      }
    case 'not_applicable':
      return {
        tone: 'info',
        title: 'No public price to compare',
        body: 'All usage in this period came from local models, so there is no API equivalent.',
      }
    case 'no_usage':
      return {
        tone: 'info',
        title: 'No usage recorded',
        body: 'No model usage was recorded in this period.',
      }
    case 'estimated':
      return { tone: 'info', title: 'Estimate, not an invoice', body: note }
    default:
      return {
        tone: 'warning',
        title: 'Estimate unavailable',
        body: 'No public price is available for the models used in this period, so no API equivalent is shown.',
      }
  }
}

export default function UsageSummary({
  mode,
  periodName,
  periodCost,
  previousPeriodCost,
  trend,
  compareLabel,
  dailyPace,
  projection,
  completePeriod,
  trackedSpend,
  trackedNote,
  periodTokens,
  reliability,
  sourceIssues,
  sourceIssueTone,
}: UsageSummaryProps) {
  const isEstimate = mode === 'api-equivalent'
  const trendLine = trendText(trend)
  const headlineHint = previousPeriodCost === null
    ? 'No previous period to compare'
    : `${trendLine ? `${trendLine} ` : ''}${compareLabel} (${formatCurrency(previousPeriodCost)})`
  const notice = isEstimate ? estimateNotice(reliability) : null

  return (
    <>
      <div className={styles.strip}>
      <StatRow aria-label={`Usage for ${periodName}`}>
        <Stat
          className={styles.headline}
          label={`${periodName} · ${isEstimate ? 'API equivalent' : 'billed'}`}
          value={periodCost === null ? null : <span className={styles.headlineValue}>{formatCurrency(periodCost)}</span>}
          hint={periodCost === null ? undefined : headlineHint}
        />
        <Stat
          label="Daily pace"
          value={dailyPace === null ? null : formatCurrency(dailyPace)}
          hint="Average per day"
        />
        {!completePeriod && (
          <Stat
            label="Projection"
            value={projection === null ? null : formatCurrency(projection)}
            hint="30 days at this pace"
          />
        )}
        {isEstimate && (
          <Stat
            label="Tracked spend"
            value={trackedSpend === null ? null : formatCurrency(trackedSpend)}
            hint={trackedSpend === null ? 'Billing coverage not available' : trackedNote ?? 'From billing data'}
          />
        )}
        <Stat
          label="Tokens"
          value={formatCompactTokenValue(periodTokens)}
          hint={`${formatTokens(periodTokens)} in this period`}
        />
      </StatRow>
      </div>

      {notice && (
        <Notice tone={notice.tone} title={notice.title}>
          {notice.body}
        </Notice>
      )}

      {sourceIssues.length > 0 && (
        <Notice tone={sourceIssueTone} title={sourceIssueTone === 'info' ? 'Refreshing' : 'Some usage may be missing'}>
          {sourceIssues.join(' ')}
        </Notice>
      )}
    </>
  )
}
