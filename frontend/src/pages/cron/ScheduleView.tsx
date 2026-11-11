import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Copy, Pencil, Plus, RefreshCw } from 'lucide-react'
import {
  Button,
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
import { useApi } from '../../lib/hooks'
import { useNow } from '../../lib/useNow'
import EntryDialog from './EntryDialog'
import type { CalendarEntry, CalendarPayload } from './scheduleLib'
import {
  ASSIGNEE_OPTIONS,
  SOURCE_OPTIONS,
  entryState,
  formatDayHeader,
  formatTimeLabel,
  formatWeekRange,
  isDisabledEntry,
  startOfWeek,
  toDayKey,
} from './scheduleLib'
import styles from './ScheduleView.module.css'

type Mode = 'week' | 'today'

const MAX_PER_DAY = 8

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
  const [editing, setEditing] = useState<{ entry: CalendarEntry | null } | null>(null)
  const [mode, setMode] = useState<Mode>('week')
  const [weekOffset, setWeekOffset] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [hideDisabled, setHideDisabled] = useState(true)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [expandedDays, setExpandedDays] = useState<Set<string>>(() => new Set())

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

  const dayBuckets = useMemo(() => {
    const keys = weekDays.map(toDayKey)
    const map: Record<string, CalendarEntry[]> = Object.fromEntries(keys.map((key) => [key, []]))
    const query = searchQuery.trim().toLowerCase()

    for (const entry of entries) {
      if (sourceFilter && entry.source !== sourceFilter) continue
      if (assigneeFilter && entry.assignee !== assigneeFilter) continue
      if (query && !String(entry.title || '').toLowerCase().includes(query)) continue

      const recurring = !!entry.schedule || (entry.source === 'cron' && !entry.startsAt)
      if (recurring) {
        if (hideDisabled && isDisabledEntry(entry)) continue
        for (const key of keys) map[key].push(entry)
        continue
      }

      if (!entry.startsAt) continue
      const startsAt = new Date(entry.startsAt)
      if (Number.isNaN(startsAt.getTime())) continue
      const key = toDayKey(startsAt)
      if (map[key]) map[key].push(entry)
    }

    for (const key of keys) {
      map[key].sort((a, b) => {
        const ta = a.startsAt ? new Date(a.startsAt).getTime() : 0
        const tb = b.startsAt ? new Date(b.startsAt).getTime() : 0
        return ta - tb
      })
    }
    return map
  }, [assigneeFilter, entries, hideDisabled, searchQuery, sourceFilter, weekDays])

  const hiddenDisabledCount = useMemo(
    () =>
      hideDisabled
        ? entries.filter((entry) => (!!entry.schedule || entry.source === 'cron') && isDisabledEntry(entry)).length
        : 0,
    [entries, hideDisabled],
  )

  const weekLabel = formatWeekRange(weekDays)

  const handleSync = async () => {
    setSyncing(true)
    try {
      const response = await fetch('/api/calendar/sync-cron', { method: 'POST' })
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || `HTTP ${response.status}`)
      }
      await refetch()
    } catch (err) {
      toast.show('error', `Schedule sync failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setSyncing(false)
    }
  }

  const handleSave = async (payload: Partial<CalendarEntry>) => {
    try {
      const method = payload.id ? 'PATCH' : 'POST'
      const path = payload.id ? `/api/calendar/${encodeURIComponent(payload.id)}` : '/api/calendar'
      const response = await fetch(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const detail = await response.text()
        throw new Error(detail || `HTTP ${response.status}`)
      }
      await refetch()
    } catch (err) {
      toast.show('error', `Schedule save failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
      throw err
    }
  }

  const handleToggleDetailStatus = async () => {
    if (!detailEntry) return
    const nextStatus = isDisabledEntry(detailEntry) ? 'scheduled' : 'disabled'
    try {
      await handleSave({ id: detailEntry.id, status: nextStatus })
    } catch {
      // handleSave already reported it.
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
            <Button size="sm" variant="ghost" onClick={() => setWeekOffset(0)}>
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
            onClick={handleSync}
            title="Refresh the schedule from the cron jobs"
          >
            Sync from cron
          </Button>
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing({ entry: null })}>
            New entry
          </Button>
        </div>
      </div>

      <div className={styles.filters}>
        <FilterChips
          ariaLabel="Filter by source"
          options={SOURCE_OPTIONS.map((source) => ({ value: source, label: source }))}
          value={sourceFilter ?? ''}
          onChange={(value) => setSourceFilter((prev) => toggleChip(prev, value))}
          className={styles.capitalize}
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

      {data?.warning && (
        <Notice tone="warning">Showing cached schedule data. {data.warning}</Notice>
      )}

      <div className={cx(styles.grid, mode === 'today' && styles.gridToday)}>
        {visibleDays.map((day) => {
          const key = toDayKey(day)
          const list = dayBuckets[key] || []
          const header = formatDayHeader(day)
          const isToday = key === todayKey
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
                  <p className={styles.dayEmpty}>Nothing scheduled.</p>
                ) : (
                  shown.map((entry) => {
                    const state = entryState(entry.status)
                    return (
                      <button
                        key={`${key}:${entry.id}`}
                        type="button"
                        className={styles.entry}
                        data-state={state ?? undefined}
                        data-dim={isDisabledEntry(entry) || undefined}
                        onClick={() => setDetailId(entry.id)}
                      >
                        <span className={styles.entryTitle}>{entry.title}</span>
                        <span className={styles.entryMeta}>
                          <Mono muted>{formatTimeLabel(entry.startsAt)}</Mono>
                          {state && state !== 'healthy' && (
                            <span className={styles.entryStatus}>
                              <StateDot state={state} />
                              {entry.status}
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
        Recurring entries repeat on every day shown; dated entries appear on their day only.
      </p>

      <Drawer
        open={detailEntry !== null && editing === null}
        onClose={() => setDetailId(null)}
        title={detailEntry?.title ?? ''}
        description={detailEntry ? `${detailEntry.source || '—'} · ${detailEntry.assignee || 'Unassigned'}` : undefined}
        footer={
          detailEntry ? (
            <div className={styles.footer}>
              <Button icon={<Pencil size={14} />} onClick={() => setEditing({ entry: detailEntry })}>
                Edit
              </Button>
              <Button icon={<Copy size={14} />} onClick={handleCopyJobId}>
                {copiedId === (detailEntry.linkedJobId || detailEntry.id) ? 'Copied' : 'Copy job id'}
              </Button>
              <Button variant={isDisabledEntry(detailEntry) ? 'primary' : 'secondary'} onClick={handleToggleDetailStatus}>
                {isDisabledEntry(detailEntry) ? 'Enable' : 'Disable'}
              </Button>
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
                  {detailState ? <StatePill state={detailState} label={detailEntry.status} /> : detailEntry.status || '—'}
                </dd>
              </div>
              <div className={styles.fact}>
                <dt>Schedule</dt>
                <dd>{detailEntry.schedule ? <Mono>{detailEntry.schedule}</Mono> : formatTimeLabel(detailEntry.startsAt)}</dd>
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
          onSave={handleSave}
        />
      )}
    </div>
  )
}
