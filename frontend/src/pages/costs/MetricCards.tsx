import { Calendar, DollarSign, Target, TrendingDown, TrendingUp } from 'lucide-react'
import GlassCard from '../../components/GlassCard'
import AnimatedCounter from '../../components/AnimatedCounter'
import { formatCurrency, formatComparisonValue, calculateTrend } from './lib'
import type { AWSSCostData } from './types'
import styles from './MetricCards.module.css'

function TrendBadge({ trend }: { trend: ReturnType<typeof calculateTrend> }) {
  if (!trend) return null
  const positiveIsBad = trend.direction === 'up'
  const Icon = trend.direction === 'up' ? TrendingUp : TrendingDown
  const color = positiveIsBad ? '#FF453A' : '#32D74B'
  const bg = positiveIsBad ? 'rgba(255,69,58,0.14)' : 'rgba(50,215,75,0.14)'
  return (
    <div
      className={styles.trendBadge}
      style={{ background: bg, color }}
    >
      <Icon size={12} />
      {trend.label || `${trend.percentage!.toFixed(trend.percentage! >= 100 ? 0 : 1)}%`}
    </div>
  )
}

interface MetricCardsProps {
  m: boolean
  isAwsEnabled: boolean
  hasAwsData: boolean
  awsCosts: AWSSCostData | null
  metricMode: 'tracked' | 'api-equivalent'
  currentPeriodCost: number | null
  dailyAvg: number | null
  projectedMonthly: number | null
  previousPeriodCost: number | null
  previousDailyAvg: number | null
  monthlyTrend: ReturnType<typeof calculateTrend>
  dailyTrend: ReturnType<typeof calculateTrend>
  compareLabel: { period: string; daily: string }
  period: 'day' | '7d' | 'month'
  labels: { thisMonth: string; creditsLeft: string; dailyAvg: string; projected: string }
  activePeriodLabel: string
  apiEquivalentReliability: string
  /** A finished calendar month: the third card shows the month TOTAL, not a projection. */
  completePeriod?: boolean
}

export default function MetricCards({
  m,
  isAwsEnabled,
  hasAwsData,
  awsCosts,
  metricMode,
  currentPeriodCost,
  dailyAvg,
  projectedMonthly,
  previousPeriodCost,
  previousDailyAvg,
  monthlyTrend,
  dailyTrend,
  compareLabel,
  period,
  labels,
  activePeriodLabel,
  apiEquivalentReliability,
  completePeriod = false,
}: MetricCardsProps) {
  const isApiEquivalent = metricMode === 'api-equivalent'
  const estimateNote = apiEquivalentReliability === 'partial'
    ? 'Partial estimate · Public API prices; not your invoice'
    : 'Estimate · Public API prices; not your invoice'
  // A month that has already ended is reported, not extrapolated.
  const projectionLabel = isApiEquivalent
    ? completePeriod ? 'API-Equivalent Month Total' : 'Projected API Equivalent'
    : labels.projected
  const projectionNote = isApiEquivalent
    ? estimateNote
    : completePeriod ? 'Final tracked spend for the month in view' : 'Projected if the current pace holds'

  return (
    <div
      className={m ? `${styles.grid} ${styles.gridMobile}` : styles.grid}
      style={{
        gridTemplateColumns: isAwsEnabled && hasAwsData
          ? (m ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)')
          : (m ? '1fr' : 'repeat(3, 1fr)'),
      }}
    >
      <GlassCard delay={0} noPad>
        <div className={m ? `${styles.cardInner} ${styles.cardInnerMobile}` : styles.cardInner}>
          <div className={styles.cardTop}>
            <div className={`${m ? `${styles.iconWrap} ${styles.iconWrapMobile}` : styles.iconWrap} ${styles.iconWrapBlue}`}>
              <Calendar size={m ? 16 : 20} className={styles.iconBlue} />
            </div>
            <span className={m ? `${styles.cardLabel} ${styles.cardLabelMobile}` : styles.cardLabel}>
              {isApiEquivalent ? 'API-Equivalent Daily Average' : labels.dailyAvg}
            </span>
          </div>
          <p className={m ? `${styles.cardValue} ${styles.cardValueMobile}` : styles.cardValue}>
            {dailyAvg === null ? 'Unavailable' : <AnimatedCounter end={dailyAvg} formatter={formatCurrency} />}
          </p>
          <div className={styles.trendRow}>
            <div className={styles.trendLabel}>
              {compareLabel.daily} {formatComparisonValue(previousDailyAvg)}
            </div>
            <TrendBadge trend={dailyTrend} />
          </div>
          {isApiEquivalent && <div className={styles.cardNote}>{estimateNote}</div>}
        </div>
      </GlassCard>

      <GlassCard delay={0.05} noPad>
        <div className={m ? `${styles.cardInner} ${styles.cardInnerMobile}` : styles.cardInner}>
          <div className={styles.cardTop}>
            <div
              className={m ? `${styles.iconWrap} ${styles.iconWrapMobile}` : styles.iconWrap}
              style={{ background: Number(currentPeriodCost || 0) > 100 ? 'rgba(255,149,0,0.15)' : 'rgba(50,215,75,0.15)' }}
            >
              <DollarSign size={m ? 16 : 20} style={{ color: Number(currentPeriodCost || 0) > 100 ? '#FF9500' : '#32D74B' }} />
            </div>
            <span className={m ? `${styles.cardLabel} ${styles.cardLabelMobile}` : styles.cardLabel}>
              {isApiEquivalent
                ? `${activePeriodLabel} API Equivalent`
                : period === 'month' ? `${labels.thisMonth} Tracked` : `${activePeriodLabel} Tracked`}
            </span>
          </div>
          <p className={m ? `${styles.cardValue} ${styles.cardValueMobile}` : styles.cardValue}>
            {currentPeriodCost === null ? 'Unavailable' : <AnimatedCounter end={currentPeriodCost} formatter={formatCurrency} />}
          </p>
          <div className={styles.trendRow}>
            <div className={styles.trendLabel}>
              {compareLabel.period} {formatComparisonValue(previousPeriodCost)}
            </div>
            <TrendBadge trend={monthlyTrend} />
          </div>
          {isApiEquivalent && <div className={styles.cardNote}>{estimateNote}</div>}
        </div>
      </GlassCard>

      {isAwsEnabled && hasAwsData && awsCosts && (
        <GlassCard delay={0.1} noPad>
          <div className={m ? `${styles.cardInner} ${styles.cardInnerMobile}` : styles.cardInner}>
            <div className={styles.cardTop}>
              <div className={`${m ? `${styles.iconWrap} ${styles.iconWrapMobile}` : styles.iconWrap} ${styles.iconWrapGreen}`}>
                <Target size={m ? 16 : 20} className={styles.iconGreen} />
              </div>
              <span className={m ? `${styles.cardLabel} ${styles.cardLabelMobile}` : styles.cardLabel}>
                {labels.creditsLeft}
              </span>
            </div>
            <p className={m ? `${styles.cardValue} ${styles.cardValueMobile}` : styles.cardValue}>
              <AnimatedCounter end={awsCosts.remaining} formatter={formatCurrency} />
            </p>
            <div className={styles.cardNote}>
              Remaining AWS credit balance
            </div>
          </div>
        </GlassCard>
      )}

      <GlassCard delay={0.15} noPad>
        <div className={m ? `${styles.cardInner} ${styles.cardInnerMobile}` : styles.cardInner}>
          <div className={styles.cardTop}>
            <div className={`${m ? `${styles.iconWrap} ${styles.iconWrapMobile}` : styles.iconWrap} ${styles.iconWrapOrange}`}>
              <TrendingUp size={m ? 16 : 20} className={styles.iconOrange} />
            </div>
            <span className={m ? `${styles.cardLabel} ${styles.cardLabelMobile}` : styles.cardLabel}>
              {projectionLabel}
            </span>
          </div>
          <p className={m ? `${styles.cardValue} ${styles.cardValueMobile}` : styles.cardValue}>
            {projectedMonthly === null ? 'Unavailable' : <AnimatedCounter end={projectedMonthly} formatter={formatCurrency} />}
          </p>
          <div className={styles.cardNote}>
            {projectionNote}
          </div>
        </div>
      </GlassCard>
    </div>
  )
}
