import type { ReactNode } from 'react'
import { Stat, StatRow, StateMark } from '../../components/ui'
import type { UiState } from '../../lib/state'
import { BILLING_NOT_READ, calculateTrend, formatCompactTokenValue, formatCurrency, formatTokens, NO_PROVIDER_ISSUES, providerCoverageSentences } from './lib'
import type { ProviderCoverage } from './lib'
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
  /**
   * False while the period is part-way and the previous one is whole (Day): the headline then says
   * "so far" and gives the previous total without a percentage. Default true.
   */
  likeForLike?: boolean
  /** False in Day view: an average per day of one part-way day is not a pace. Default true. */
  showPace?: boolean
  /** Why no projection is shown (part-way day, first days of a month); null when it may be. */
  projectionWithheld?: string | null
  /** Billed / tracked spend for the period; null when billing coverage is unavailable. */
  trackedSpend: number | null
  trackedNote: string | null
  /** Null when no platform could be read: shown as "not read", never 0. */
  periodTokens: number | null
  reliability: string
  /** One sentence per source problem; empty when all sources were read. */
  sourceIssues: string[]
  sourceIssueTone: UiState | 'info'
  /** Which platforms are unread, partial or stale; makes the estimate notice say the total is partial. */
  platformCoverage?: ProviderCoverage
  /** Rendered directly under the headline strip (the Platforms panel). */
  children?: ReactNode
}

function trendText(trend: Trend) {
  if (!trend) return null
  if (trend.label) return `${trend.direction === 'up' ? 'Up' : 'Down'} ${trend.label}`
  if (trend.percentage === null) return trend.direction === 'up' ? 'Up' : 'Down'
  return `${trend.direction === 'up' ? 'Up' : 'Down'} ${trend.percentage.toFixed(trend.percentage >= 100 ? 0 : 1)}%`
}

function estimateNotice(reliability: string, coverage: ProviderCoverage): { tone: UiState | 'info'; title: string; body: string } {
  const base = baseEstimateNotice(reliability)
  if (!coverage.hasIssues) return base
  const partialEstimate = reliability === 'estimated' || reliability === 'partial'
  return {
    // A platform that was not read (or a gap nothing explains) is a reading that is missing: the hollow
    // mark. Partial records and stale readings are quiet notes; a failed scan has the alarm line.
    tone: coverage.unread.length > 0 || coverage.unexplained ? 'unavailable' : 'info',
    title: partialEstimate ? 'Partial estimate, not an invoice' : base.title,
    body: `${providerCoverageSentences(coverage).join(' ')} ${base.body}`,
  }
}

function baseEstimateNotice(reliability: string): { tone: UiState | 'info'; title: string; body: string } {
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
        tone: 'unavailable',
        title: 'Estimate unavailable',
        body: 'No public price is available for the models used in this period, so no API equivalent is shown.',
      }
  }
}

/** A quiet note under the figures. Only a reading that is missing carries a mark (the hollow circle). */
function Note({ tone, title, children }: { tone: UiState | 'info'; title: string; children: ReactNode }) {
  const unread = tone === 'unavailable'
  return (
    <div className={styles.note} data-tone={unread ? 'unread' : 'info'} role="status">
      {unread && <StateMark state="unavailable" className={styles.noteMark} />}
      <p className={styles.noteText}>
        <span className={styles.noteTitle}>{title}.</span> {children}
      </p>
    </div>
  )
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
  likeForLike = true,
  showPace = true,
  projectionWithheld = null,
  trackedSpend,
  trackedNote,
  periodTokens,
  reliability,
  sourceIssues,
  sourceIssueTone,
  platformCoverage = NO_PROVIDER_ISSUES,
  children,
}: UsageSummaryProps) {
  const isEstimate = mode === 'api-equivalent'
  const trendLine = trendText(trend)
  const comparisonHint = previousPeriodCost === null
    ? 'No previous period to compare'
    : likeForLike
      ? `${trendLine ? `${trendLine} ` : ''}${compareLabel} (${formatCurrency(previousPeriodCost)})`
      : `${periodName} so far, not compared with the whole previous day (${formatCurrency(previousPeriodCost)})`
  // With no pace stat (Day), the reason for the missing projection goes under the headline instead.
  const headlineHint = !showPace && projectionWithheld ? `${comparisonHint}. ${projectionWithheld}` : comparisonHint
  const paceHint = projectionWithheld && !completePeriod ? `Average per day. ${projectionWithheld}` : 'Average per day'
  const notice = isEstimate ? estimateNotice(reliability, platformCoverage) : null

  return (
    <>
      <StatRow aria-label={`Usage for ${periodName}`}>
        <Stat
          className={styles.headline}
          label={`${periodName} · ${isEstimate ? 'API equivalent' : 'billed'}`}
          value={periodCost === null ? null : <span className={styles.headlineValue}>{formatCurrency(periodCost)}</span>}
          hint={periodCost === null ? undefined : headlineHint}
        />
        {showPace && (
          <Stat
            label="Daily pace"
            value={dailyPace === null ? null : formatCurrency(dailyPace)}
            hint={paceHint}
          />
        )}
        {!completePeriod && projectionWithheld === null && (
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
            hint={trackedSpend === null ? BILLING_NOT_READ : trackedNote ?? 'From billing data'}
          />
        )}
        <Stat
          label="Tokens"
          value={periodTokens === null ? null : formatCompactTokenValue(periodTokens)}
          hint={periodTokens === null
            ? 'No platform could be read'
            : `${formatTokens(periodTokens)} in this period`}
        />
      </StatRow>

      {children}

      {notice && (
        <Note tone={notice.tone} title={notice.title}>
          {notice.body}
        </Note>
      )}

      {sourceIssues.length > 0 && (
        <Note tone={sourceIssueTone} title={sourceIssueTone === 'info' ? 'Refreshing' : 'Some usage may be missing'}>
          {sourceIssues.join(' ')}
        </Note>
      )}
    </>
  )
}
