import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight, DollarSign } from 'lucide-react'
import GlassCard from '../../components/GlassCard'
import {
  formatCurrency,
  formatTokens,
  formatCompactTokenValue,
  monthNavigationState,
  monthPickerGrid,
  monthPickerYearBounds,
  nextSelectableIndex,
} from './lib'
import type { MonthAvailability, TrackedSpendPresentation } from './lib'
import type { CodexBarCostData } from './types'
import styles from './CostPulseHeader.module.css'

interface OverviewPill {
  label: string
  value: string
  accent: string
  title?: string
}

/** How far back the month navigator will walk from the current month. */
const MONTH_ANCHOR_HISTORY_MONTHS = 24

interface CostPulseHeaderProps {
  m: boolean
  period: 'day' | '7d' | 'month'
  setPeriod: (p: 'day' | '7d' | 'month') => void
  monthAnchor: string | null
  setMonthAnchor: (anchor: string | null) => void
  calendarNow: Date
  serverMonth: string | null
  monthAvailability: MonthAvailability[]
  monthAvailabilityKnown: boolean
  viewingPastMonth: boolean
  anchoredMonthLabel: string | null
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
  trackedSpend: TrackedSpendPresentation
  trackedValueAvailable: boolean
}

export default function CostPulseHeader({
  m,
  period,
  setPeriod,
  monthAnchor,
  setMonthAnchor,
  calendarNow,
  serverMonth,
  monthAvailability,
  monthAvailabilityKnown,
  viewingPastMonth,
  anchoredMonthLabel,
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
  trackedSpend,
  trackedValueAvailable,
}: CostPulseHeaderProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const monthPickerRef = useRef<HTMLDivElement>(null)
  const monthPickerDialogRef = useRef<HTMLDivElement>(null)
  const monthPickerTriggerRef = useRef<HTMLButtonElement>(null)
  const gridButtonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const formatApiEquivalent = (value: number | null) => value === null ? 'N/A' : formatCurrency(value)
  const isPartialApiEquivalent = apiEquivalentReliability === 'partial'
  const isNotApplicableApiEquivalent = apiEquivalentReliability === 'not_applicable'
  const hasNoApiEquivalentUsage = apiEquivalentReliability === 'no_usage'
  const trackedCoverageNote = [trackedSpend.valueQualifier, trackedSpend.coverageLabel].filter(Boolean).join(' · ')
  const monthNav = monthNavigationState(monthAnchor, calendarNow, MONTH_ANCHOR_HISTORY_MONTHS, serverMonth)
  const [pickerYear, setPickerYear] = useState(() => Number(monthNav.activeMonth.slice(0, 4)))
  const pickerYearBounds = monthPickerYearBounds(calendarNow, MONTH_ANCHOR_HISTORY_MONTHS, serverMonth)
  const pickerMonths = monthPickerGrid(
    pickerYear,
    monthAvailability,
    monthAvailabilityKnown,
    calendarNow,
    MONTH_ANCHOR_HISTORY_MONTHS,
    serverMonth,
  )
  // Stepping onto the current month clears the anchor so the request goes back to the
  // live (unanchored) window — the same cache entry as before this feature existed.
  const goToMonth = (next: string) => setMonthAnchor(next === monthNav.currentMonth ? null : next)
  const openMonthPicker = () => {
    setPickerYear(Number(monthNav.activeMonth.slice(0, 4)))
    if (pickerOpen) {
      setPickerOpen(false)
      monthPickerTriggerRef.current?.focus()
    } else {
      setPickerOpen(true)
    }
  }
  const closeMonthPicker = () => {
    setPickerOpen(false)
    monthPickerTriggerRef.current?.focus()
  }
  const chooseMonth = (month: string) => {
    goToMonth(month)
    closeMonthPicker()
  }
  const moveGridFocus = (index: number, delta: number) => {
    const next = nextSelectableIndex(pickerMonths, index, delta)
    if (next !== index) gridButtonRefs.current[next]?.focus()
  }
  const onMonthGridKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const column = index % 3
    if (event.key === 'ArrowLeft' && column > 0) {
      event.preventDefault()
      moveGridFocus(index, -1)
    } else if (event.key === 'ArrowRight' && column < 2) {
      event.preventDefault()
      moveGridFocus(index, 1)
    } else if (event.key === 'ArrowUp' && index >= 3) {
      event.preventDefault()
      moveGridFocus(index, -3)
    } else if (event.key === 'ArrowDown' && index < 9) {
      event.preventDefault()
      moveGridFocus(index, 3)
    }
  }

  useEffect(() => {
    if (!pickerOpen) return undefined
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!monthPickerRef.current?.contains(event.target as Node)) closeMonthPicker()
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeMonthPicker()
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [pickerOpen])
  useLayoutEffect(() => {
    if (!pickerOpen) return undefined
    const dialog = monthPickerDialogRef.current
    if (!dialog) return undefined
    let animationFrame: number | null = null
    const reclamp = () => {
      if (animationFrame !== null) return
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null
        const hadTransform = dialog.style.transform !== ''
        if (hadTransform) dialog.style.transform = ''
        const rect = dialog.getBoundingClientRect()
        const shift = Math.max(8 - rect.left, Math.min(0, window.innerWidth - 8 - rect.right))
        if (shift !== 0) dialog.style.transform = `translateX(${shift}px)`
      })
    }
    const resizeObserver = new ResizeObserver(reclamp)
    reclamp()
    window.addEventListener('resize', reclamp)
    resizeObserver.observe(document.body)
    resizeObserver.observe(dialog)
    return () => {
      window.removeEventListener('resize', reclamp)
      resizeObserver.disconnect()
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
    }
  }, [pickerOpen, monthAvailability, monthAvailabilityKnown, m])
  useEffect(() => {
    if (!pickerOpen) return
    const selectedIndex = pickerMonths.findIndex(item => item.month === monthNav.activeMonth && item.selectable)
    const firstSelectableIndex = pickerMonths.findIndex(item => item.selectable)
    const focusIndex = selectedIndex >= 0 ? selectedIndex : firstSelectableIndex
    if (focusIndex >= 0) gridButtonRefs.current[focusIndex]?.focus()
  }, [pickerMonths, pickerOpen, monthNav.activeMonth])
  const spendPeriodDescription = period === 'month'
    ? viewingPastMonth && anchoredMonthLabel
      ? `${anchoredMonthLabel} tracked spend`
      : 'Current month tracked spend'
    : `${activePeriodLabel} spend in view`
  return (
    <GlassCard delay={0} noPad overflowVisible={pickerOpen}>
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

          <div className={styles.periodRow}>
            <div className={styles.tabStrip}>
              {([
                ['day', 'Daily'],
                ['7d', '7 Days'],
                ['month', 'Monthly'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => {
                    if (key !== 'month') setPickerOpen(false)
                    setPeriod(key)
                  }}
                  className={period === key ? `${styles.tabBtn} ${styles.tabBtnActive}` : styles.tabBtn}
                >
                  {label}
                </button>
              ))}
            </div>

            {period === 'month' && (
              <div className={styles.monthNav} role="group" aria-label="Month navigation">
                <button
                  type="button"
                  onClick={() => goToMonth(monthNav.previousMonth)}
                  disabled={!monthNav.canGoBack}
                  aria-label={`Show ${monthNav.previousMonth}`}
                  title={monthNav.canGoBack ? 'Previous month' : 'No further history available'}
                  className={monthNav.canGoBack ? styles.monthNavBtn : `${styles.monthNavBtn} ${styles.monthNavBtnDisabled}`}
                >
                  <ChevronLeft size={14} />
                </button>
                <div className={styles.monthPickerAnchor} ref={monthPickerRef}>
                  <button
                    type="button"
                    onClick={openMonthPicker}
                    ref={monthPickerTriggerRef}
                    className={styles.monthNavLabel}
                    aria-live="polite"
                    aria-haspopup="dialog"
                    aria-expanded={pickerOpen}
                    aria-controls="costs-month-picker"
                  >
                    {monthNav.label}
                  </button>
                  {pickerOpen && (
                    <div
                      id="costs-month-picker"
                      role="dialog"
                      aria-label="Choose month"
                      className={styles.monthPicker}
                      ref={monthPickerDialogRef}
                    >
                      <div className={styles.monthPickerYearRow}>
                        <button
                          type="button"
                          className={styles.monthPickerYearButton}
                          onClick={() => setPickerYear(year => year - 1)}
                          disabled={pickerYear <= pickerYearBounds.minimumYear}
                          aria-label={`Show ${pickerYear - 1}`}
                        >
                          <ChevronLeft size={14} />
                        </button>
                        <span className={styles.monthPickerYear}>{pickerYear}</span>
                        <button
                          type="button"
                          className={styles.monthPickerYearButton}
                          onClick={() => setPickerYear(year => year + 1)}
                          disabled={pickerYear >= pickerYearBounds.maximumYear}
                          aria-label={`Show ${pickerYear + 1}`}
                        >
                          <ChevronRight size={14} />
                        </button>
                      </div>
                      <div className={styles.monthPickerGrid} aria-label={`${pickerYear} months`}>
                        {pickerMonths.map((item, index) => {
                          const selected = item.month === monthNav.activeMonth
                          const className = !item.selectable
                            ? `${styles.monthPickerMonth} ${styles.monthPickerMonthDisabled}`
                            : selected
                              ? `${styles.monthPickerMonth} ${styles.monthPickerMonthSelected}`
                              : styles.monthPickerMonth
                          return (
                            <button
                              key={item.month}
                              ref={element => { gridButtonRefs.current[index] = element }}
                              type="button"
                              className={className}
                              onClick={() => chooseMonth(item.month)}
                              onKeyDown={event => onMonthGridKeyDown(event, index)}
                              disabled={!item.selectable}
                              aria-disabled={!item.selectable}
                              aria-pressed={selected}
                              aria-label={`Show ${item.month}`}
                              title={item.outsideRange ? 'Outside the available history range' : item.unknown ? 'Availability is not fully scanned' : undefined}
                            >
                              {item.label}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => goToMonth(monthNav.nextMonth)}
                  disabled={!monthNav.canGoForward}
                  aria-label={`Show ${monthNav.nextMonth}`}
                  title={monthNav.canGoForward ? 'Next month' : 'Already viewing the current month'}
                  className={monthNav.canGoForward ? styles.monthNavBtn : `${styles.monthNavBtn} ${styles.monthNavBtnDisabled}`}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
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
                  {/* A finished month is a total, not a projection. */}
                  <div className={styles.codexbarCellLabel}>{viewingPastMonth ? 'API Month Total' : 'API Projection'}</div>
                  <div className={m ? `${styles.codexbarCellValue} ${styles.codexbarCellValueMobile}` : styles.codexbarCellValue}>
                    {formatApiEquivalent(apiEquivalentProjectedMonthly)}
                  </div>
                </div>
                <div className={styles.codexbarMiniCell} title={trackedCoverageNote || undefined}>
                  <div className={styles.codexbarCellLabel}>Tracked Spend</div>
                  <div className={m ? `${styles.codexbarCellValue} ${styles.codexbarCellValueMobile}` : styles.codexbarCellValue}>
                    {trackedValueAvailable ? formatCurrency(currentPeriodCost) : 'Unavailable'}
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
                    {trackedValueAvailable ? formatCurrency(currentPeriodCost) : 'Unavailable'}
                  </div>
                  <div className={styles.pulseDesc}>
                    {trackedValueAvailable ? spendPeriodDescription : 'No tracked billing source is available'}
                  </div>
                </div>

                <div className={styles.pulseMiniGrid}>
                  <div className={styles.pulseMiniCell}>
                    <div className={styles.pulseCellLabel}>Daily Pace</div>
                    <div className={styles.pulseCellValue}>{trackedValueAvailable ? formatCurrency(dailyAvg) : 'Unavailable'}</div>
                  </div>
                  <div className={styles.pulseMiniCell}>
                    {/* A finished month is a total, not a projection. */}
                    <div className={styles.pulseCellLabel}>{viewingPastMonth ? 'Month Total' : 'Projection'}</div>
                    <div className={styles.pulseCellValue}>{trackedValueAvailable ? formatCurrency(projectedMonthly) : 'Unavailable'}</div>
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
                      {period === 'month'
                        ? viewingPastMonth && anchoredMonthLabel
                          ? `${anchoredMonthLabel} local usage estimate`
                          : 'Current month local usage estimate'
                        : `${activePeriodLabel} local usage estimate`}
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
