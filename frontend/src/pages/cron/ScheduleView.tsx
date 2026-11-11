import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, Pencil, Plus, RefreshCw } from 'lucide-react'
import {
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
import { describeApiError, postJson, sendJson, useApi, writeFailureMessage } from '../../lib/hooks'
import { useNow } from '../../lib/useNow'
import { Link } from 'react-router-dom'
import { scheduleDisplay } from './cronSchedule'
import { planWeek } from './weekPlan'
import { oneOf, useQueryParam } from './urlState'
import EntryDialog from './EntryDialog'
import type { EntryChange } from './EntryDialog'
import type { CalendarEntry, CalendarPayload, RepairResult } from './scheduleLib'
import {
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
  const now = useNow()
  const [syncing, setSyncing] = useState(false)
  const [repairOpen, setRepairOpen] = useState(false)
  const [repairing, setRepairing] = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ entry: CalendarEntry | null } | null>(null)
  // Range, week, filters and search live in the URL, so a reload or a shared link keeps them.
  const [rangeParam, setRangeParam] = useQueryParam('range')
  const [weekParam, setWeekParam] = useQueryParam('week')
  const [findParam, setFindParam] = useQueryParam('find')
  const [disabledParam, setDisabledParam] = useQueryParam('disabled')
  const [sourceParam, setSourceParam] = useQueryParam('source')
  const [assigneeParam, setAssigneeParam] = useQueryParam('assignee')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set())

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
  const hiddenDisabledCount = plan.hiddenDisabled

  const weekLabel = formatWeekRange(weekDays)

  const handleSync = async () => {
    setSyncing(true)
    try {
      await postJson('/api/calendar/sync-cron')
      await refetch()
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
      const result = await postJson<RepairResult>('/api/calendar/repair')
      setRepairOpen(false)
      toast.show('success', repairResultMessage(result), { duration: 12000 })
      await refetch()
    } catch (err) {
      setRepairError(describeApiError(err))
    } finally {
      setRepairing(false)
    }
  }

  /** Throws when the server refuses, so the dialog can show its message and stay open. */
  const saveEntry = async (change: EntryChange) => {
    if (change.kind === 'create') {
      await postJson('/api/calendar', change.payload)
    } else {
      await sendJson(`/api/calendar/${encodeURIComponent(change.id)}`, 'PATCH', change.patch)
    }
    await refetch()
  }

  // Only an entry nobody links to the scheduler has a status of its own. A linked
  // entry's status is the job's: its switch is in Jobs, not here.
  const handleToggleDetailStatus = async () => {
    if (!detailEntry || isLinkedEntry(detailEntry)) return
    const nextStatus = isDisabledEntry(detailEntry) ? 'scheduled' : 'disabled'
    try {
      await saveEntry({ kind: 'update', id: detailEntry.id, patch: { status: nextStatus } })
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
  const detailJobHref = detailEntry && isLinkedEntry(detailEntry) ? jobHref(detailEntry) : null

  return (
    <div className={styles.view}>
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

      {notices.map((notice) => (
        <Notice
          key={notice.id}
          tone={notice.tone}
          title={notice.title}
          action={
            notice.id === repairNoticeId ? (
              <Button size="sm" onClick={() => setRepairOpen(true)}>
                Repair calendar
              </Button>
            ) : undefined
          }
        >
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

      <div className={cx(styles.grid, mode === 'today' && styles.gridToday)}>
        {visibleDays.map((day) => {
          const key = toDayKey(day)
          const list = dayBuckets[key] || []
          const header = formatDayHeader(day)
          const isToday = key === todayKey
          const isPast = day.getTime() < todayStart.getTime()
          const expanded = expandedDays.has(key)
          const shown = expanded ? list : list.slice(0, MAX_PER_DAY)
          return (
            <section key={key} className={cx(styles.day, isToday && styles.dayToday)} aria-label={`${header.weekday} ${header.date}`}>
              <header className={styles.dayHeader}>
                <div>
                  <div className={styles.weekday}>{mode === 'today' ? 'Today' : header.weekday}</div>
                  <div className={styles.date}>{header.date}</div>
                </div>
                <span className={styles.dayCount}>{list.length}</span>
              </header>
              <div className={styles.dayBody}>
                {list.length === 0 ? (
                  <p className={styles.dayEmpty}>{isPast ? 'No dated entries.' : 'Nothing scheduled.'}</p>
                ) : (
                  shown.map((placed) => {
                    const { entry } = placed
                    const state = entryState(entry.status)
                    return (
                      <button
                        key={`${key}:${entry.id}`}
                        type="button"
                        className={styles.entry}
                        data-state={state ?? undefined}
                        data-dim={isDisabledEntry(entry) || undefined}
                        title={entry.schedule ? `Schedule: ${entry.schedule}` : undefined}
                        onClick={() => setDetailId(entry.id)}
                      >
                        <span className={styles.entryTitle}>{entry.title}</span>
                        <span className={styles.entryMeta}>
                          <Mono muted>{placed.label}</Mono>
                          {state && state !== 'healthy' && (
                            <span className={styles.entryStatus}>
                              <StateDot state={state} />
                              {entryStatusLabel(entry.status)}
                            </span>
                          )}
                        </span>
                      </button>
                    )
                  })
                )}
                {list.length > MAX_PER_DAY && (
                  <Button size="sm" variant="ghost" onClick={() => toggleExpanded(key)}>
                    {expanded ? 'Show fewer' : `Show ${list.length - MAX_PER_DAY} more`}
                  </Button>
                )}
              </div>
            </section>
          )
        })}
      </div>

      <p className={styles.footnote}>
        Recurring jobs appear on the days their schedule runs them, from today on, in your local time. A job that runs
        many times a day is shown once with its run count. Past days show dated entries only.
      </p>

      {plan.unplaced.length > 0 && (
        <section className={styles.unplaced} aria-label="Schedule not understood">
          <h3 className={styles.unplacedTitle}>Schedule not understood</h3>
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
        </section>
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
                  {detailState ? <StatePill state={detailState} label={entryStatusLabel(detailEntry.status)} /> : entryStatusLabel(detailEntry.status)}
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
            {detailEntry.notes && (
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
