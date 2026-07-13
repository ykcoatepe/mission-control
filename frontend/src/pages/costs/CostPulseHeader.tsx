import type { CSSProperties } from 'react'
import { DollarSign } from 'lucide-react'
import GlassCard from '../../components/GlassCard'
import { formatCurrency, formatTokens, formatCompactTokenValue } from './lib'
import type { CodexBarCostData } from './types'
import styles from './CostPulseHeader.module.css'

interface OverviewPill {
  label: string
  value: string
  accent: string
  title?: string
}

interface CostPulseHeaderProps {
  m: boolean
  period: 'day' | '7d' | 'month'
  setPeriod: (p: 'day' | '7d' | 'month') => void
  activePeriodLabel: string
  hasAwsData: boolean
  ledgerActive: boolean
  costSourceLabel: string
  overviewPills: OverviewPill[]
  codexbarActive: boolean
  codexbarCosts: CodexBarCostData | null
  codexbarPeriodTokens: number
  currentPeriodCost: number
  dailyAvg: number
  projectedMonthly: number
  apiEquivalentPeriodCost: number | null
  apiEquivalentDailyAvg: number | null
  apiEquivalentProjectedMonthly: number | null
  apiEquivalentReliability: string
}

export default function CostPulseHeader({
  m,
  period,
  setPeriod,
  activePeriodLabel,
  hasAwsData,
  ledgerActive,
  costSourceLabel,
  overviewPills,
  codexbarActive,
  codexbarCosts,
  codexbarPeriodTokens,
  currentPeriodCost,
  dailyAvg,
  projectedMonthly,
  apiEquivalentPeriodCost,
  apiEquivalentDailyAvg,
  apiEquivalentProjectedMonthly,
  apiEquivalentReliability,
}: CostPulseHeaderProps) {
  const formatApiEquivalent = (value: number | null) => value === null ? 'N/A' : formatCurrency(value)
  const isPartialApiEquivalent = apiEquivalentReliability === 'partial'
  const isNotApplicableApiEquivalent = apiEquivalentReliability === 'not_applicable'
  const hasNoApiEquivalentUsage = apiEquivalentReliability === 'no_usage'
  return (
    <GlassCard delay={0} noPad>
      <div className={m ? `${styles.outer} ${styles.outerMobile}` : styles.outer}>
        <div className={styles.leftCol}>
          <div className={styles.titleRow}>
            <div>
              <h1 className={`text-title ${styles.titleHeading}`}>
                <DollarSign size={m ? 24 : 28} className={styles.titleIconColor} />
                Cost Tracker
              </h1>
              <p className={`text-body ${styles.titleSubtitle}`}>
                {activePeriodLabel} view with budget tracking, daily movement, and the biggest cost drivers.
              </p>
            </div>
            <div className={m ? `${styles.badgeRow} ${styles.badgeRowMobile}` : styles.badgeRow}>
              <span className="macos-badge macos-badge-blue">{activePeriodLabel}</span>
              <span className={`macos-badge ${hasAwsData ? 'macos-badge-green' : ledgerActive ? 'macos-badge-blue' : 'macos-badge-orange'}`}>
                {costSourceLabel}
              </span>
            </div>
          </div>

          <div className={styles.tabStrip}>
            {([
              ['day', 'Daily'],
              ['7d', '7 Days'],
              ['month', 'Monthly'],
            ] as const).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setPeriod(key)}
                className={period === key ? `${styles.tabBtn} ${styles.tabBtnActive}` : styles.tabBtn}
              >
                {label}
              </button>
            ))}
          </div>

          <div
            className={styles.pillsGrid}
            style={{ '--pills-cols': m ? '1fr 1fr' : 'repeat(3, minmax(0, 1fr))' } as CSSProperties}
          >
            {overviewPills.map(pill => (
              <div
                key={pill.label}
                title={pill.title}
                className={m ? `${styles.pill} ${styles.pillMobile}` : styles.pill}
              >
                <div className={styles.pillLabel}>{pill.label}</div>
                <div className={m ? `${styles.pillValue} ${styles.pillValueMobile}` : styles.pillValue}>{pill.value}</div>
              </div>
            ))}
          </div>
        </div>

        <div className={styles.rightCol}>
          {ledgerActive || codexbarActive ? (
            <div className={m ? `${styles.codexbarCard} ${styles.codexbarCardMobile}` : styles.codexbarCard}>
              <div className={styles.codexbarTopRow}>
                <div>
                  <div className={styles.codexbarSubLabel}>All-source API Equivalent</div>
                  <div className={m ? `${styles.codexbarAmount} ${styles.codexbarAmountMobile}` : styles.codexbarAmount}>
                    {formatApiEquivalent(apiEquivalentPeriodCost)}
                  </div>
                  <div className={styles.codexbarDesc}>
                    {isPartialApiEquivalent
                      ? 'Partial public-list-price estimate; some models are unpriced'
                      : isNotApplicableApiEquivalent
                        ? 'API comparison does not apply to local-only usage'
                      : hasNoApiEquivalentUsage
                        ? 'No model usage was recorded for this period'
                      : apiEquivalentPeriodCost === null
                        ? 'No public rate card is available for this usage mix'
                        : 'Public-list-price estimate; not tracked subscription spend'}
                  </div>
                </div>
                <span className="macos-badge macos-badge-orange">
                  {isPartialApiEquivalent
                    ? 'PARTIAL ESTIMATE'
                    : isNotApplicableApiEquivalent
                      ? 'NOT APPLICABLE'
                      : hasNoApiEquivalentUsage
                        ? 'NO USAGE'
                      : apiEquivalentPeriodCost === null
                        ? 'UNAVAILABLE'
                        : 'LOCAL ESTIMATE'}
                </span>
              </div>

              <div className={styles.codexbarMiniGrid}>
                <div className={styles.codexbarMiniCell}>
                  <div className={styles.codexbarCellLabel}>API Daily Pace</div>
                  <div className={m ? `${styles.codexbarCellValue} ${styles.codexbarCellValueMobile}` : styles.codexbarCellValue}>
                    {formatApiEquivalent(apiEquivalentDailyAvg)}
                  </div>
                </div>
                <div className={styles.codexbarMiniCell}>
                  <div className={styles.codexbarCellLabel}>API Projection</div>
                  <div className={m ? `${styles.codexbarCellValue} ${styles.codexbarCellValueMobile}` : styles.codexbarCellValue}>
                    {formatApiEquivalent(apiEquivalentProjectedMonthly)}
                  </div>
                </div>
                <div className={styles.codexbarMiniCell}>
                  <div className={styles.codexbarCellLabel}>Tracked Spend</div>
                  <div className={m ? `${styles.codexbarCellValue} ${styles.codexbarCellValueMobile}` : styles.codexbarCellValue}>
                    {formatCurrency(currentPeriodCost)}
                  </div>
                </div>
                <div title={`${formatTokens(codexbarPeriodTokens)} tokens`} className={styles.codexbarMiniCell}>
                  <div className={styles.codexbarCellLabel}>Period Tokens</div>
                  <div className={m ? `${styles.codexbarCellValue} ${styles.codexbarCellValueMobile}` : styles.codexbarCellValue}>
                    {formatCompactTokenValue(codexbarPeriodTokens)}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className={m ? `${styles.pulseCard} ${styles.pulseCardMobile}` : styles.pulseCard}>
                <div>
                  <div className={styles.pulseSubLabel}>Current Pulse</div>
                  <div className={m ? `${styles.pulseAmount} ${styles.pulseAmountMobile}` : styles.pulseAmount}>
                    {formatCurrency(currentPeriodCost)}
                  </div>
                  <div className={styles.pulseDesc}>
                    {period === 'month' ? 'Current month tracked spend' : `${activePeriodLabel} spend in view`}
                  </div>
                </div>

                <div className={styles.pulseMiniGrid}>
                  <div className={styles.pulseMiniCell}>
                    <div className={styles.pulseCellLabel}>Daily Pace</div>
                    <div className={styles.pulseCellValue}>{formatCurrency(dailyAvg)}</div>
                  </div>
                  <div className={styles.pulseMiniCell}>
                    <div className={styles.pulseCellLabel}>Projection</div>
                    <div className={styles.pulseCellValue}>{formatCurrency(projectedMonthly)}</div>
                  </div>
                </div>
              </div>

              <div className={m ? `${styles.inactivePanel} ${styles.inactivePanelMobile}` : styles.inactivePanel}>
                <div className={styles.inactiveTopRow}>
                  <div>
                    <div className={styles.inactiveSubLabel}>
                      CodexBar Local Costs
                    </div>
                    <div className={m ? `${styles.inactiveAmount} ${styles.inactiveAmountMobile}` : styles.inactiveAmount}>
                      {formatCurrency(0)}
                    </div>
                    <div className={styles.inactiveDesc}>
                      {period === 'month' ? 'Current month local usage estimate' : `${activePeriodLabel} local usage estimate`}
                    </div>
                  </div>
                  <span className={`macos-badge ${styles.badgeDimmed}`}>
                    LOCAL ESTIMATE
                  </span>
                </div>

                <div className={styles.inactiveMiniGrid}>
                  <div className={styles.inactiveMiniCell}>
                    <div className={styles.inactiveCellLabel}>Session Today</div>
                    <div className={styles.inactiveCellValue}>
                      {formatCurrency(codexbarCosts?.sessionCostUSD || 0)}
                    </div>
                  </div>
                  <div title="0 tokens" className={styles.inactiveMiniCell}>
                    <div className={styles.inactiveCellLabel}>Period Tokens</div>
                    <div className={styles.inactiveCellValue}>
                      {formatCompactTokenValue(0)}
                    </div>
                  </div>
                </div>

                <div className={styles.inactiveNote}>
                  No CodexBar local Codex or Claude usage data is active yet for this view.
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </GlassCard>
  )
}
