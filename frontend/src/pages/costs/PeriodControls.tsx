import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { IconButton, SegmentedControl } from '../../components/ui'
import {
  dayPickerGrid,
  formatCurrency,
  formatCompactTokenValue,
  monthKeyLabel,
  monthNavigationState,
  monthPickerGrid,
  monthPickerYearBounds,
  nextSelectableIndex,
  shiftMonthKey,
} from './lib'
import type { DayUsageEntry, MonthAvailability } from './lib'
import styles from './PeriodControls.module.css'

export type UsagePeriod = 'day' | '7d' | 'month'

const PERIOD_OPTIONS: Array<{ value: UsagePeriod; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: '7d', label: '7 days' },
  { value: 'month', label: 'Month' },
]

/** How far back the month navigator will walk from the current month. */
const MONTH_ANCHOR_HISTORY_MONTHS = 24

const WEEKDAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

interface PeriodControlsProps {
  period: UsagePeriod
  setPeriod: (p: UsagePeriod) => void
  monthAnchor: string | null
  setMonthAnchor: (anchor: string | null) => void
  calendarNow: Date
  serverMonth: string | null
  monthAvailability: MonthAvailability[]
  monthAvailabilityKnown: boolean
  /** Per-day usage of the month currently in view, feeding the day grid's heat. */
  dayUsage: DayUsageEntry[]
  activeChartDate: string | null
  onSelectDay: (date: string) => void
}

/** Period switch plus month navigator and day picker. Lives in the page actions row. */
export default function PeriodControls({
  period,
  setPeriod,
  monthAnchor,
  setMonthAnchor,
  calendarNow,
  serverMonth,
  monthAvailability,
  monthAvailabilityKnown,
  dayUsage,
  activeChartDate,
  onSelectDay,
}: PeriodControlsProps) {
  const [pickerOpen, setPickerOpen] = useState(false)
  // 'days' is the landing view; 'months' is the zoomed-out month/year grid.
  const [pickerView, setPickerView] = useState<'days' | 'months'>('days')
  const monthPickerRef = useRef<HTMLDivElement>(null)
  const monthPickerDialogRef = useRef<HTMLDivElement>(null)
  const monthPickerTriggerRef = useRef<HTMLButtonElement>(null)
  const gridButtonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const dayButtonRefs = useRef<Array<HTMLButtonElement | null>>([])
  const wasPickerState = useRef<{ open: boolean; view: 'days' | 'months'; month: string }>({ open: false, view: 'days', month: '' })
  const monthNav = monthNavigationState(monthAnchor, calendarNow, MONTH_ANCHOR_HISTORY_MONTHS, serverMonth)
  const [pickerYear, setPickerYear] = useState(() => Number(monthNav.activeMonth.slice(0, 4)))
  // The month the DAY grid is browsing — decoupled from the anchored month so
  // paging through the calendar never launches a month scan by itself.
  const [pickerMonth, setPickerMonth] = useState(() => monthNav.activeMonth)
  const pickerYearBounds = monthPickerYearBounds(calendarNow, MONTH_ANCHOR_HISTORY_MONTHS, serverMonth)
  const pickerMonths = monthPickerGrid(
    pickerYear,
    monthAvailability,
    monthAvailabilityKnown,
    calendarNow,
    MONTH_ANCHOR_HISTORY_MONTHS,
    serverMonth,
  )
  // Heat only exists for the month whose rows are actually loaded; a browsed
  // month renders neutral cells until it is selected (and thereby fetched).
  const pickerMonthIsActive = pickerMonth === monthNav.activeMonth
  const pickerDays = dayPickerGrid(
    pickerMonth,
    pickerMonthIsActive ? dayUsage : [],
    calendarNow,
    MONTH_ANCHOR_HISTORY_MONTHS,
    serverMonth,
  )
  // Stepping onto the current month clears the anchor so the request goes back to the
  // live (unanchored) window — the same cache entry as before this feature existed.
  const goToMonth = (next: string) => setMonthAnchor(next === monthNav.currentMonth ? null : next)
  const openMonthPicker = () => {
    setPickerYear(Number(monthNav.activeMonth.slice(0, 4)))
    setPickerMonth(monthNav.activeMonth)
    setPickerView('days')
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
    // Anchor the month and zoom into its days: the heat fills in as the month's
    // rows land, and a day click from here drills straight into that day.
    goToMonth(month)
    setPickerMonth(month)
    setPickerView('days')
  }
  const chooseDay = (date: string) => {
    onSelectDay(date)
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
  const moveDayFocus = (index: number, delta: number) => {
    const next = nextSelectableIndex(pickerDays.cells, index, delta)
    if (next !== index) dayButtonRefs.current[next]?.focus()
  }
  const onDayGridKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }
    const step = steps[event.key]
    if (step === undefined) return
    event.preventDefault()
    moveDayFocus(index, step)
  }
  const canBrowsePreviousMonth = pickerMonth > pickerYearBounds.floor
  const canBrowseNextMonth = pickerMonth < pickerYearBounds.current
  const browsePickerMonth = (delta: number) => setPickerMonth(shiftMonthKey(pickerMonth, delta))

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
  }, [pickerOpen, monthAvailability, monthAvailabilityKnown])
  useEffect(() => {
    const previous = wasPickerState.current
    const justOpened = pickerOpen && !previous.open
    const viewChanged = pickerOpen && previous.view !== pickerView
    const monthBrowsed = pickerOpen && pickerView === 'days' && previous.month !== pickerMonth
    wasPickerState.current = { open: pickerOpen, view: pickerView, month: pickerMonth }
    // Focus is a transition side effect (open / view switch / month page); re-running
    // it on data re-renders steals focus from the header controls mid-navigation.
    if (!justOpened && !viewChanged && !monthBrowsed) return
    if (pickerView === 'months') {
      const selectedIndex = pickerMonths.findIndex(item => item.month === monthNav.activeMonth && item.selectable)
      const firstSelectableIndex = pickerMonths.findIndex(item => item.selectable)
      const focusIndex = selectedIndex >= 0 ? selectedIndex : firstSelectableIndex
      if (focusIndex >= 0) gridButtonRefs.current[focusIndex]?.focus()
      return
    }
    // A month page-turn only needs focus rescued when it left with the old grid.
    if (monthBrowsed && !justOpened && !viewChanged
      && monthPickerDialogRef.current?.contains(document.activeElement)) return
    const cells = pickerDays.cells
    const selectedIndex = cells.findIndex(cell => cell.date === activeChartDate && cell.selectable)
    const todayIndex = cells.findIndex(cell => cell.isToday && cell.selectable)
    let focusIndex = selectedIndex >= 0 ? selectedIndex : todayIndex
    if (focusIndex < 0) {
      for (let index = cells.length - 1; index >= 0; index -= 1) {
        if (cells[index].selectable) { focusIndex = index; break }
      }
    }
    if (focusIndex >= 0) dayButtonRefs.current[focusIndex]?.focus()
  }, [activeChartDate, pickerDays, pickerMonth, pickerMonths, pickerOpen, pickerView, monthNav.activeMonth])
  const changePeriod = (key: UsagePeriod) => {
    if (key !== 'month') setPickerOpen(false)
    setPeriod(key)
  }
  return (
    <div className={styles.controls}>
      <SegmentedControl<UsagePeriod>
        ariaLabel="Period"
        options={PERIOD_OPTIONS}
        value={period}
        onChange={changePeriod}
      />

      {period === 'month' && (
        <div className={styles.monthNav} role="group" aria-label="Month navigation">
          <IconButton
            variant="secondary"
            label={`Show ${monthKeyLabel(monthNav.previousMonth)}`}
            title={monthNav.canGoBack ? 'Previous month' : 'No further history available'}
            icon={<ChevronLeft size={14} aria-hidden="true" />}
            onClick={() => goToMonth(monthNav.previousMonth)}
            disabled={!monthNav.canGoBack}
          />
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
                aria-label={pickerView === 'days' ? 'Choose day' : 'Choose month'}
                className={styles.monthPicker}
                ref={monthPickerDialogRef}
              >
                {pickerView === 'days' ? (
                  <>
                    <div className={styles.pickerHeader}>
                      <button
                        type="button"
                        className={styles.pickerStep}
                        onClick={() => browsePickerMonth(-1)}
                        disabled={!canBrowsePreviousMonth}
                        aria-label={`Browse ${shiftMonthKey(pickerMonth, -1)}`}
                      >
                        <ChevronLeft size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={styles.pickerTitle}
                        onClick={() => {
                          setPickerYear(Number(pickerMonth.slice(0, 4)))
                          setPickerView('months')
                        }}
                        aria-label={`Choose a different month (currently ${monthKeyLabel(pickerMonth)})`}
                      >
                        {monthKeyLabel(pickerMonth)}
                      </button>
                      <button
                        type="button"
                        className={styles.pickerStep}
                        onClick={() => browsePickerMonth(1)}
                        disabled={!canBrowseNextMonth}
                        aria-label={`Browse ${shiftMonthKey(pickerMonth, 1)}`}
                      >
                        <ChevronRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                    <div className={styles.weekHeader} aria-hidden="true">
                      {WEEKDAY_LABELS.map(label => (
                        <span key={label} className={styles.weekday}>{label}</span>
                      ))}
                    </div>
                    <div className={styles.dayGrid} aria-label={`${monthKeyLabel(pickerMonth)} days`}>
                      {Array.from({ length: pickerDays.leadingBlanks }, (_, index) => (
                        <span key={`blank-${index}`} aria-hidden="true" />
                      ))}
                      {pickerDays.cells.map((cell, index) => {
                        const selected = pickerMonthIsActive && cell.date === activeChartDate
                        const className = [
                          styles.day,
                          selected ? styles.daySelected : '',
                          cell.isToday ? styles.dayToday : '',
                        ].filter(Boolean).join(' ')
                        return (
                          <button
                            key={cell.date}
                            ref={element => { dayButtonRefs.current[index] = element }}
                            type="button"
                            className={className}
                            style={cell.intensity > 0
                              ? ({ '--heat': (0.12 + cell.intensity * 0.55).toFixed(3) } as CSSProperties)
                              : undefined}
                            data-heat={cell.intensity > 0 ? 'true' : undefined}
                            onClick={() => chooseDay(cell.date)}
                            onKeyDown={event => onDayGridKeyDown(event, index)}
                            disabled={!cell.selectable}
                            aria-disabled={!cell.selectable}
                            aria-pressed={selected}
                            aria-label={`Show ${cell.date} usage`}
                            title={cell.hasUsage
                              ? `${cell.date} — ${cell.cost > 0 ? formatCurrency(cell.cost) : 'no priced cost'} · ${formatCompactTokenValue(cell.tokens)} tokens`
                              : pickerMonthIsActive ? `${cell.date} — no recorded usage` : cell.date}
                          >
                            {cell.dayOfMonth}
                          </button>
                        )
                      })}
                    </div>
                    <p className={styles.hint}>
                      {pickerMonthIsActive
                        ? dayUsage.length > 0
                          ? 'Shading follows each day’s usage. Pick a day to inspect it below.'
                          : 'No per-day usage is loaded for this month yet.'
                        : `Pick a day to load ${monthKeyLabel(pickerMonth)}.`}
                    </p>
                  </>
                ) : (
                  <>
                    <div className={styles.pickerHeader}>
                      <button
                        type="button"
                        className={styles.pickerStep}
                        onClick={() => setPickerYear(year => year - 1)}
                        disabled={pickerYear <= pickerYearBounds.minimumYear}
                        aria-label={`Show ${pickerYear - 1}`}
                      >
                        <ChevronLeft size={14} aria-hidden="true" />
                      </button>
                      <span className={styles.pickerYear}>{pickerYear}</span>
                      <button
                        type="button"
                        className={styles.pickerStep}
                        onClick={() => setPickerYear(year => year + 1)}
                        disabled={pickerYear >= pickerYearBounds.maximumYear}
                        aria-label={`Show ${pickerYear + 1}`}
                      >
                        <ChevronRight size={14} aria-hidden="true" />
                      </button>
                    </div>
                    <div className={styles.monthGrid} aria-label={`${pickerYear} months`}>
                      {pickerMonths.map((item, index) => {
                        const selected = item.month === monthNav.activeMonth
                        return (
                          <button
                            key={item.month}
                            ref={element => { gridButtonRefs.current[index] = element }}
                            type="button"
                            className={selected ? `${styles.monthCell} ${styles.monthCellSelected}` : styles.monthCell}
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
                  </>
                )}
              </div>
            )}
          </div>
          <IconButton
            variant="secondary"
            label={`Show ${monthKeyLabel(monthNav.nextMonth)}`}
            title={monthNav.canGoForward ? 'Next month' : 'Already viewing the current month'}
            icon={<ChevronRight size={14} aria-hidden="true" />}
            onClick={() => goToMonth(monthNav.nextMonth)}
            disabled={!monthNav.canGoForward}
          />
        </div>
      )}
    </div>
  )
}
