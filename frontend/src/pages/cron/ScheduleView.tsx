import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, Pencil, Plus, RefreshCw } from 'lucide-react'
import {
  AlarmLine,
  Block,
  Button,
  Dialog,
  Drawer,
  ErrorState,
  FilterChips,
  IconButton,
  Mono,
  Notice,
  SearchInput,
  SegmentedControl,
  Skeleton,
  StateDot,
  StatePill,
  Switch,
  TimeAgo,
  cx,
  useToast,
} from '../../components/ui'
import { useQueryClient } from '@tanstack/react-query'
import { describeApiError, postJson, sendJson, useApi, writeFailureMessage } from '../../lib/hooks'
import { applyCommitted, isStaleWrite } from '../../lib/writes'
import { StaleWriteNote } from '../../components/StaleWriteNote'
import { useNow } from '../../lib/useNow'
import { Link } from 'react-router-dom'
import { scheduleDisplay } from './cronSchedule'
import { lastRunMarkerDays, planWeek } from './weekPlan'
import { isInternalKey } from './jobWords'
import { oneOf, useQueryParam, useQueryParams } from './urlState'
import EntryDialog from './EntryDialog'
import type { EntryChange } from './EntryDialog'
import type { CalendarEntry, CalendarPayload, CalendarWriteResponse, RepairResult } from './scheduleLib'
import {
  applyCalendarWrite,
  describeEntryChanges,
  diffEntries,
  weekOffsetFor,
  ASSIGNEE_OPTIONS,
  SOURCE_OPTIONS,
  calendarNotices,
  repairDescription,
  repairOffer,
  repairResultMessage,
  entryState,
  entryStatusLabel,
  formatDayHeader,
  formatTimeLabel,
  formatWeekRange,
  isDisabledEntry,
  isLinkedEntry,
  jobHref,
  sourceLabel,
  startOfWeek,
  toDayKey,
  writesBlocked,
} from './scheduleLib'
import styles from './ScheduleView.module.css'

type Mode = 'week' | 'today'

const MAX_PER_DAY = 8

const MODES = ['week', 'today'] as const

/** How long the "Saved" tag stays on an entry that was just written. */
const SAVED_TAG_MS = 6000

/** Where an entry that was just written is, for the person looking at the page. */
type SavedPlace =
  | { kind: 'visible'; key: string; recurring: boolean }
  | { kind: 'elsewhere'; date: Date }
  | { kind: 'filtered'; why: string }
  | { kind: 'listed' }

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'today', label: 'Today' },
]

function toggleChip(current: string | null, value: string) {
  return current === value ? null : value
}

/** The week grid of scheduled and recurring entries. Rendered as a view body: no header of its own. */
export default function ScheduleView() {
  const { data, loading, error, refetch } = useApi<CalendarPayload>('/api/calendar', 15000)
  const toast = useToast()
  const queryClient = useQueryClient()
  const now = useNow()
  // The last write succeeded but the server could not confirm its follow-up reading yet.
  const [catchingUp, setCatchingUp] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [repairOpen, setRepairOpen] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ entry: CalendarEntry | null } | null>(null)
  // Range, week, filters and search live in the URL, so a reload or a shared link keeps them.
  const [rangeParam, setRangeParam] = useQueryParam('range')
  const [weekParam, setWeekParam] = useQueryParam('week')
  const [findParam, setFindParam] = useQueryParam('find')
  const setQueryParams = useQueryParams()
  const [disabledParam, setDisabledParam] = useQueryParam('disabled')
  const [sourceParam, setSourceParam] = useQueryParam('source')
  const [assigneeParam, setAssigneeParam] = useQueryParam('assignee')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set())
  // The entry that was just written: tagged for a few seconds, scrolled to and focused once it is on screen.
  const [justSaved, setJustSaved] = useState<{ id: string; key: string } | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ id: string; key: string; nonce: number } | null>(null)
  const focused = useRef(0)
  // A write whose entry is not on the screen right now: said, with a way to it.
  const [savedNote, setSavedNote] = useState<{ id: string; title: string; place: SavedPlace } | null>(null)

  const mode: Mode = oneOf(rangeParam, MODES, 'week')
  const parsedWeek = Number.parseInt(weekParam ?? '', 10)
  const weekOffset = Number.isFinite(parsedWeek) ? Math.max(-52, Math.min(52, parsedWeek)) : 0
  const searchQuery = findParam ?? ''
  const hideDisabled = disabledParam !== 'show'
  const sourceFilter = (SOURCE_OPTIONS as string[]).includes(sourceParam ?? '') ? sourceParam : null
  const assigneeFilter = (ASSIGNEE_OPTIONS as string[]).includes(assigneeParam ?? '') ? assigneeParam : null
  const setMode = (value: Mode) => setRangeParam(value === 'week' ? null : value)
  const setWeekOffset = (update: (previous: number) => number) => {
    const next = update(weekOffset)
    setWeekParam(next === 0 ? null : String(next))
  }
  const setSearchQuery = (value: string) => setFindParam(value.trim() === '' ? null : value)
  const setHideDisabled = (value: boolean) => setDisabledParam(value ? null : 'show')
  const setSourceFilter = (update: (previous: string | null) => string | null) => setSourceParam(update(sourceFilter))
  const setAssigneeFilter = (update: (previous: string | null) => string | null) => setAssigneeParam(update(assigneeFilter))

  const entries = useMemo(() => data?.entries || [], [data])
  const detailEntry = useMemo(
    () => (detailId ? entries.find((entry) => entry.id === detailId) ?? null : null),
    [detailId, entries],
  )

  useEffect(() => {
    if (!copiedId) return
    const timer = window.setTimeout(() => setCopiedId(null), 1200)
    return () => window.clearTimeout(timer)
  }, [copiedId])

  const today = useMemo(() => new Date(now), [now])
  const todayKey = toDayKey(today)

  const weekDays = useMemo(() => {
    const base = startOfWeek(new Date(now))
    base.setDate(base.getDate() + (mode === 'today' ? 0 : weekOffset * 7))
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(base)
      day.setDate(base.getDate() + index)
      return day
    })
  }, [mode, now, weekOffset])

  const visibleDays = useMemo(
    () => (mode === 'today' ? [today] : weekDays),
    [mode, today, weekDays],
  )

  const matchesFilters = (entry: CalendarEntry) => {
    const query = searchQuery.trim().toLowerCase()
    if (sourceFilter && entry.source !== sourceFilter) return false
    if (assigneeFilter && entry.assignee !== assigneeFilter) return false
    if (query && !String(entry.title || '').toLowerCase().includes(query)) return false
    return true
  }

  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return entries.filter((entry) => {
      if (sourceFilter && entry.source !== sourceFilter) return false
      if (assigneeFilter && entry.assignee !== assigneeFilter) return false
      if (query && !String(entry.title || '').toLowerCase().includes(query)) return false
      return true
    })
  }, [assigneeFilter, entries, searchQuery, sourceFilter])

  const todayStart = useMemo(() => {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    return start
  }, [now])

  const plan = useMemo(
    () => planWeek(filteredEntries, weekDays, { hideDisabled, todayStart }),
    [filteredEntries, hideDisabled, todayStart, weekDays],
  )
  const dayBuckets = plan.byDay
  // A job's last run result goes on its next occurrence only; the days after it are not failures.
  const markerDays = useMemo(
    () => lastRunMarkerDays(plan.byDay, weekDays.map(toDayKey), todayKey),
    [plan.byDay, todayKey, weekDays],
  )
  const hiddenDisabledCount = plan.hiddenDisabled

  const weekLabel = formatWeekRange(weekDays)

  /** Shows what the server committed at once (the entry is in the grid before the refetch lands), then refetches. */
  const showCommitted = async (response: CalendarWriteResponse | null) => {
    setCatchingUp(isStaleWrite(response))
    await applyCommitted<CalendarPayload>(queryClient, '/api/calendar', (current) => applyCalendarWrite(current, response))
  }

  const handleSync = async () => {
    setSyncing(true)
    try {
      const response = await postJson<CalendarWriteResponse>('/api/calendar/sync-cron')
      const changes = Array.isArray(response?.entries) ? describeEntryChanges(diffEntries(entries, response.entries)) : null
      await showCommitted(response)
      if (changes) toast.show('success', `Schedule synced from cron. ${changes}`)
    } catch (err) {
      toast.show('error', writeFailureMessage('Schedule sync failed', err))
    } finally {
      setSyncing(false)
    }
  }

  const closeRepair = () => {
    if (repairing) return
    setRepairOpen(false)
    setRepairError(null)
  }

  /** One POST, after the person confirmed. A refusal (409: the file cannot be parsed) keeps the dialog open with the server's words. */
  const handleRepair = async () => {
    setRepairing(true)
    setRepairError(null)
    try {
      const result = await postJson<RepairResult & CalendarWriteResponse>('/api/calendar/repair')
      setRepairOpen(false)
      const changes = Array.isArray(result?.entries) ? diffEntries(entries, result.entries) : null
      const changed = changes ? changes.added + changes.updated + changes.removed : 0
      toast.show('success', `${repairResultMessage(result)}${changed > 0 && changes ? ` ${describeEntryChanges(changes)}` : ''}`, { duration: 12000 })
      await showCommitted(result)
    } catch (err) {
      setRepairError(describeApiError(err))
    } finally {
      setRepairing(false)
    }
  }

  /** Throws when the server refuses, so the dialog can show its message and stay open. */
  const saveEntry = async (change: EntryChange, options: { reveal?: boolean } = {}) => {
    const response =
      change.kind === 'create'
        ? await postJson<CalendarWriteResponse>('/api/calendar', change.payload)
        : await sendJson<CalendarWriteResponse>(`/api/calendar/${encodeURIComponent(change.id)}`, 'PATCH', change.patch)
    await showCommitted(response)
    const saved = response?.entry ?? entries.find((entry) => change.kind === 'update' && entry.id === change.id)
    const id = response?.entry?.id ?? (change.kind === 'update' ? change.id : null)
    if (id && options.reveal !== false) {
      // The drawer must not reopen over the entry that was just saved.
      setDetailId(null)
      showSaved(id, saved ?? null)
    }
  }

  /** Where the entry is on screen now. A recurring entry lands on the first visible day its schedule runs. */
  const placeSaved = (entry: CalendarEntry): SavedPlace => {
    if (!matchesFilters(entry)) return { kind: 'filtered', why: 'the current search or filters' }
    const placed = planWeek([entry], visibleDays, { hideDisabled, todayStart })
    const key = visibleDays.map(toDayKey).find((day) => placed.byDay[day]?.length)
    if (key) return { kind: 'visible', key, recurring: Boolean(placed.byDay[key]?.some((item) => item.recurring)) }
    if (hideDisabled && isDisabledEntry(entry)) return { kind: 'filtered', why: '"Hide disabled"' }
    const startsAt = entry.startsAt ? new Date(entry.startsAt) : null
    if (startsAt && !Number.isNaN(startsAt.getTime()) && !String(entry.schedule ?? '').trim()) return { kind: 'elsewhere', date: startsAt }
    return { kind: 'listed' }
  }

  const focusEntry = (id: string, key: string, expand = false) => {
    // Dated entries are always listed; only a recurring occurrence can sit behind "Show N more".
    if (expand) setExpandedDays((prev) => new Set(prev).add(key))
    setJustSaved({ id, key })
    setFocusRequest({ id, key, nonce: Date.now() + Math.random() })
  }

  /** After a create or an edit: show the entry (day opened, tagged, focused), or say where it went. */
  const showSaved = (id: string, entry: CalendarEntry | null) => {
    setSavedNote(null)
    if (!entry) return
    const place = placeSaved(entry)
    if (place.kind === 'visible') focusEntry(id, place.key, place.recurring)
    else if (place.kind !== 'listed') setSavedNote({ id, title: entry.title, place })
  }

  const goToSavedWeek = (note: { id: string; place: SavedPlace }) => {
    if (note.place.kind !== 'elsewhere') return
    const date = note.place.date
    const offset = weekOffsetFor(date, new Date(now))
    setQueryParams({ range: null, week: offset === 0 ? null : String(offset) })
    focusEntry(note.id, toDayKey(date))
    setSavedNote(null)
  }

  const showSavedAnyway = (note: { id: string; place: SavedPlace }) => {
    setQueryParams({ find: null, source: null, assignee: null, disabled: 'show' })
    const entry = entries.find((candidate) => candidate.id === note.id)
    const placed = entry ? planWeek([entry], visibleDays, { hideDisabled: false, todayStart }) : null
    const key = placed ? visibleDays.map(toDayKey).find((day) => placed.byDay[day]?.length) : undefined
    setSavedNote(null)
    if (key) focusEntry(note.id, key)
  }

  // The tag goes away by itself.
  useEffect(() => {
    if (!justSaved) return
    const timer = window.setTimeout(() => setJustSaved(null), SAVED_TAG_MS)
    return () => window.clearTimeout(timer)
  }, [justSaved])

  // Scroll to the entry and move focus to it, once it is rendered and the dialog that saved it has closed.
  useEffect(() => {
    if (!focusRequest || editing || focused.current === focusRequest.nonce) return
    const target = [...document.querySelectorAll<HTMLElement>('[data-entry-id]')].find(
      (element) => element.dataset.entryId === focusRequest.id && element.dataset.day === focusRequest.key,
    )
    if (!target) return
    focused.current = focusRequest.nonce
    target.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    target.focus({ preventScroll: true })
  })

  // Only an entry nobody links to the scheduler has a status of its own. A linked
  // entry's status is the job's: its switch is in Jobs, not here.
  const handleToggleDetailStatus = async () => {
    if (!detailEntry || isLinkedEntry(detailEntry)) return
    const nextStatus = isDisabledEntry(detailEntry) ? 'scheduled' : 'disabled'
    try {
      await saveEntry({ kind: 'update', id: detailEntry.id, patch: { status: nextStatus } }, { reveal: false })
    } catch (err) {
      toast.show('error', writeFailureMessage('Schedule save failed', err))
    }
  }

  const handleCopyJobId = async () => {
    if (!detailEntry) return
    const value = detailEntry.linkedJobId || detailEntry.id
    try {
      await navigator.clipboard.writeText(value)
      setCopiedId(value)
    } catch {
      toast.show('error', `Copy failed. Job id: ${value}`)
    }
  }

  const toggleExpanded = (key: string) => {
    setExpandedDays((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  if (loading && !data) {
    return (
      <div className={styles.view}>
        <Skeleton variant="block" label="Loading schedule" />
      </div>
    )
  }

  if (error && !data) {
    return <ErrorState title="Schedule could not be read" message={error} onRetry={refetch} />
  }

  const detailState = detailEntry ? entryState(detailEntry.status) : null
  const notices = calendarNotices(data)
  const offer = repairOffer(data)
  // One button, on the first notice about the rows a repair would move.
  const repairNoticeId = offer ? notices.find((notice) => notice.id === 'quarantined' || notice.id === 'duplicates')?.id : undefined
  const blocked = writesBlocked(data)
  // The one alarm line of the page: the first notice that says something is wrong with the schedule rows.
  const alarmNotice = notices.find((notice) => notice.tone === 'warning') ?? null
  const detailJobHref = detailEntry && isLinkedEntry(detailEntry) ? jobHref(detailEntry) : null

  return (
    <div className={styles.view}>
      {alarmNotice && (
        <AlarmLine
          state="warning"
          title={alarmNotice.title}
          detail={alarmNotice.body}
          action={alarmNotice.id === repairNoticeId ? { label: 'Repair calendar', onClick: () => setRepairOpen(true) } : undefined}
        />
      )}
      <StaleWriteNote show={catchingUp} />
      {savedNote?.place.kind === 'elsewhere' && (
        <Notice
          tone="info"
          title={`Saved for ${formatDayHeader(savedNote.place.date).weekday} ${formatDayHeader(savedNote.place.date).date}`}
          action={<Button size="sm" onClick={() => goToSavedWeek(savedNote)}>Go to that week</Button>}
        >
          “{savedNote.title}” is not in the week you are looking at.
        </Notice>
      )}
      {savedNote?.place.kind === 'filtered' && (
        <Notice
          tone="info"
          title="Saved, but hidden"
          action={<Button size="sm" onClick={() => showSavedAnyway(savedNote)}>Show it</Button>}
        >
          “{savedNote.title}” is hidden by {savedNote.place.why}.
        </Notice>
      )}
      <div className={styles.toolbar}>
        <div className={styles.nav}>
          <IconButton
            variant="secondary"
            label="Previous week"
            icon={<ChevronLeft size={16} />}
            disabled={mode === 'today'}
            onClick={() => setWeekOffset((prev) => prev - 1)}
          />
          <IconButton
            variant="secondary"
            label="Next week"
            icon={<ChevronRight size={16} />}
            disabled={mode === 'today'}
            onClick={() => setWeekOffset((prev) => prev + 1)}
          />
          {mode === 'week' && weekOffset !== 0 && (
            <Button size="sm" variant="ghost" onClick={() => setWeekOffset(() => 0)}>
              This week
            </Button>
          )}
          <span className={styles.range}>{mode === 'today' ? 'Today' : weekLabel}</span>
          <SegmentedControl ariaLabel="Schedule range" options={MODE_OPTIONS} value={mode} onChange={setMode} />
        </div>
        <div className={styles.toolbarEnd}>
          <SearchInput
            className={styles.search}
            value={searchQuery}
            onChange={setSearchQuery}
            label="Search schedule"
            placeholder="Search by title"
          />
          <Button
            icon={<RefreshCw size={14} />}
            loading={syncing}
            disabled={blocked}
            onClick={handleSync}
            title="Refresh the schedule from the cron jobs"
          >
            Sync from cron
          </Button>
          <Button variant="primary" icon={<Plus size={14} />} disabled={blocked} onClick={() => setEditing({ entry: null })}>
            New entry
          </Button>
        </div>
      </div>

      <div className={styles.filters}>
        <FilterChips
          ariaLabel="Filter by source"
          options={SOURCE_OPTIONS.map((source) => ({ value: source, label: sourceLabel(source) }))}
          value={sourceFilter ?? ''}
          onChange={(value) => setSourceFilter((prev) => toggleChip(prev, value))}
        />
        <span className={styles.divider} aria-hidden="true" />
        <FilterChips
          ariaLabel="Filter by assignee"
          options={ASSIGNEE_OPTIONS.map((assignee) => ({ value: assignee, label: assignee }))}
          value={assigneeFilter ?? ''}
          onChange={(value) => setAssigneeFilter((prev) => toggleChip(prev, value))}
        />
        <div className={styles.filtersEnd}>
          <Switch
            checked={hideDisabled}
            onChange={setHideDisabled}
            label={hiddenDisabledCount > 0 ? `Hide disabled (${hiddenDisabledCount} hidden)` : 'Hide disabled'}
          />
        </div>
      </div>

      {notices
        .filter((notice) => notice !== alarmNotice)
        .map((notice) => (
          <Notice key={notice.id} tone={notice.tone} title={notice.title}>
            {notice.body}
          </Notice>
        ))}

      <Dialog
        open={repairOpen && offer !== null}
        onClose={closeRepair}
        role="alertdialog"
        title="Repair the calendar?"
        description={offer ? repairDescription(offer) : undefined}
        actions={
          <>
            <Button data-autofocus onClick={closeRepair} disabled={repairing}>
              Cancel
            </Button>
            <Button variant="primary" loading={repairing} onClick={handleRepair}>
              Repair calendar
            </Button>
          </>
        }
      >
        {repairError && (
          <Notice tone="critical" title="The calendar was not repaired">
            {repairError}
          </Notice>
        )}
      </Dialog>

      <div className={styles.agenda}>
        {visibleDays.map((day) => {
          const key = toDayKey(day)
          const list = dayBuckets[key] || []
          const header = formatDayHeader(day)
          const isToday = key === todayKey
          const isPast = day.getTime() < todayStart.getTime()
          const expanded = expandedDays.has(key)
          // Dated one-off entries are always listed, in time order. Only the recurring occurrences collapse.
          const dated = list.filter((placed) => !placed.recurring)
          const recurring = list.filter((placed) => placed.recurring)
          const shownRecurring = expanded ? recurring : recurring.slice(0, MAX_PER_DAY)
          const renderEntry = (placed: (typeof list)[number]) => {
            const { entry } = placed
            const rawState = entryState(entry.status)
            // A repeating entry's "failed" is its last run's result: shown once, quietly, on the next occurrence.
            const lastRunFailed = placed.recurring && rawState === 'critical'
            const showLastRunFailed = lastRunFailed && markerDays.get(entry.id) === key
            const state = lastRunFailed ? null : rawState
            const fresh = justSaved?.id === entry.id && justSaved.key === key
            return (
              <button
                key={`${key}:${entry.id}`}
                type="button"
                className={styles.entry}
                data-entry-id={entry.id}
                data-day={key}
                data-just-saved={fresh || undefined}
                data-state={state ?? undefined}
                data-dim={isDisabledEntry(entry) || undefined}
                title={entry.schedule ? `Schedule: ${entry.schedule}` : undefined}
                onClick={() => setDetailId(entry.id)}
              >
                <span className={styles.entryTitle}>
                  {entry.title}
                  {fresh && <span className={styles.savedTag}>Saved</span>}
                </span>
                <span className={styles.entryTime}>
                  <Mono muted>{placed.label}</Mono>
                </span>
                <span className={styles.entryStatus}>
                  {state && state !== 'healthy' && (
                    <>
                      <StateDot state={state} />
                      {entryStatusLabel(entry.status)}
                    </>
                  )}
                  {showLastRunFailed && <span className={styles.lastRun}>Last run failed</span>}
                </span>
              </button>
            )
          }
          return (
            <Block
              key={key}
              className={cx(styles.day, isToday && styles.dayToday)}
              aria-label={`${header.weekday} ${header.date}`}
              titleAs="h3"
              title={
                <>
                  {mode === 'today' ? 'Today' : header.weekday} <span className={styles.date}>{header.date}</span>
                  {isToday && mode === 'week' && <span className={styles.todayTag}>Today</span>}
                </>
              }
              meta={list.length}
              padding="none"
            >
              <div className={styles.dayBody}>
                {list.length === 0 ? (
                  <p className={styles.dayEmpty}>{isPast ? 'No dated entries.' : 'Nothing scheduled.'}</p>
                ) : (
                  <>
                    {dated.length > 0 && <p className={styles.groupLabel}>Entries</p>}
                    {dated.map(renderEntry)}
                    {dated.length > 0 && recurring.length > 0 && <p className={styles.groupLabel}>Recurring</p>}
                    {shownRecurring.map(renderEntry)}
                  </>
                )}
                {recurring.length > MAX_PER_DAY && (
                  <Button size="sm" variant="ghost" onClick={() => toggleExpanded(key)}>
                    {expanded ? 'Show fewer' : `Show ${recurring.length - MAX_PER_DAY} more`}
                  </Button>
                )}
              </div>
            </Block>
          )
        })}
      </div>

      <p className={styles.footnote}>
        Recurring jobs appear on the days their schedule runs them, from today on, in your local time. A job that runs
        many times a day is shown once with its run count. Past days show dated entries only.
      </p>

      {plan.unplaced.length > 0 && (
        <Block
          title="Schedule not understood"
          meta={plan.unplaced.length}
          titleAs="h3"
          aria-label="Schedule not understood"
          padding="none"
          className={styles.unplaced}
        >
          <p className={styles.unplacedNote}>
            {plan.unplaced.length === 1 ? 'This entry has' : `These ${plan.unplaced.length} entries have`} a schedule that
            cannot be placed on a day, so {plan.unplaced.length === 1 ? 'it is' : 'they are'} not in the week above.
          </p>
          <ul className={styles.unplacedList}>
            {plan.unplaced.map(({ entry, reason }) => {
              const schedule = scheduleDisplay(entry.schedule, entry.scheduleKind)
              return (
                <li key={entry.id}>
                  <button type="button" className={styles.unplacedItem} onClick={() => setDetailId(entry.id)}>
                    <span className={styles.entryTitle}>{entry.title}</span>
                    <span className={styles.unplacedMeta}>
                      {schedule.raw ? <Mono muted>{schedule.text}</Mono> : null}
                      <span>{reason}</span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </Block>
      )}

      <Drawer
        open={detailEntry !== null && editing === null}
        onClose={() => setDetailId(null)}
        title={detailEntry?.title ?? ''}
        description={detailEntry ? `${sourceLabel(detailEntry.source)} · ${detailEntry.assignee || 'Unassigned'}` : undefined}
        footer={
          detailEntry ? (
            <div className={styles.footer}>
              <Button icon={<Pencil size={14} />} disabled={blocked} onClick={() => setEditing({ entry: detailEntry })}>
                Edit
              </Button>
              <Button icon={<Copy size={14} />} onClick={handleCopyJobId}>
                {copiedId === (detailEntry.linkedJobId || detailEntry.id) ? 'Copied' : 'Copy job id'}
              </Button>
              {!isLinkedEntry(detailEntry) && (
                <Button
                  variant={isDisabledEntry(detailEntry) ? 'primary' : 'secondary'}
                  disabled={blocked}
                  onClick={handleToggleDetailStatus}
                >
                  {isDisabledEntry(detailEntry) ? 'Enable' : 'Disable'}
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        {detailEntry && (
          <div className={styles.detail}>
            <dl className={styles.facts}>
              <div className={styles.fact}>
                <dt>State</dt>
                <dd>
                  {detailState ? (
                    <StatePill
                      state={detailState}
                      label={detailState === 'critical' && isLinkedEntry(detailEntry) ? 'Last run failed' : entryStatusLabel(detailEntry.status)}
                    />
                  ) : (
                    entryStatusLabel(detailEntry.status)
                  )}
                </dd>
              </div>
              <div className={styles.fact}>
                <dt>Schedule</dt>
                <dd>
                  {detailEntry.schedule ? (
                    scheduleDisplay(detailEntry.schedule, detailEntry.scheduleKind).raw ? (
                      <Mono>{detailEntry.schedule}</Mono>
                    ) : (
                      scheduleDisplay(detailEntry.schedule, detailEntry.scheduleKind).text
                    )
                  ) : (
                    formatTimeLabel(detailEntry.startsAt)
                  )}
                </dd>
              </div>
              {detailEntry.startsAt && (
                <div className={styles.fact}>
                  <dt>Starts</dt>
                  <dd>
                    <TimeAgo value={detailEntry.startsAt} />
                  </dd>
                </div>
              )}
              <div className={styles.fact}>
                <dt>Last updated</dt>
                <dd>
                  <TimeAgo value={detailEntry.updatedAt} />
                </dd>
              </div>
              {detailEntry.linkedJobId && (
                <div className={styles.fact}>
                  <dt>Job id</dt>
                  <dd>
                    <Mono>{detailEntry.linkedJobId}</Mono>
                  </dd>
                </div>
              )}
              {detailEntry.linkedTaskId && (
                <div className={styles.fact}>
                  <dt>Task id</dt>
                  <dd>
                    <Mono>{detailEntry.linkedTaskId}</Mono>
                  </dd>
                </div>
              )}
            </dl>
            {detailJobHref && (
              <p className={styles.notesBody}>
                Status and next run come from the scheduler. Turn this job on or off in{' '}
                <Link to={detailJobHref}>Automations, Jobs</Link>.
              </p>
            )}
            {detailEntry.notes && isInternalKey(detailEntry.notes) && (
              <section className={styles.notes} aria-label="Built-in job">
                <h3 className={styles.notesTitle}>Built-in job</h3>
                <p className={styles.notesBody}>
                  The scheduler runs this one itself and gives it no description. Internal name:{' '}
                  <Mono muted>{detailEntry.notes.trim()}</Mono>
                </p>
              </section>
            )}
            {detailEntry.notes && !isInternalKey(detailEntry.notes) && (
              <section className={styles.notes} aria-label="Notes">
                <h3 className={styles.notesTitle}>Notes</h3>
                <p className={styles.notesBody}>{detailEntry.notes}</p>
              </section>
            )}
          </div>
        )}
      </Drawer>

      {editing && (
        <EntryDialog
          key={editing.entry?.id ?? 'new'}
          entry={editing.entry}
          onClose={() => setEditing(null)}
          onSave={saveEntry}
        />
      )}
    </div>
  )
}
