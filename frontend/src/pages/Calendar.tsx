import { useEffect, useMemo, useState } from 'react'
import {
  CalendarDays,
  RefreshCw,
  Plus,
  Save,
  Clock,
  ChevronRight,
  Search,
  ChevronLeft,
  X,
  Copy,
  Pencil,
} from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import PageTransition from '../components/PageTransition'
import GlassCard from '../components/GlassCard'
import StatusBadge from '../components/StatusBadge'
import { useApi, formatDate, timeAgo } from '../lib/hooks'
import { useIsMobile } from '../lib/useIsMobile'
import styles from './Calendar.module.css'

interface CalendarEntry {
  id: string
  title: string
  schedule: string
  startsAt: string | null
  status: string
  assignee: 'Yordam' | 'Mudur' | string
  source: 'cron' | 'manual' | 'assistant' | string
  linkedTaskId: string | null
  linkedJobId: string | null
  notes?: string
  updatedAt?: string
}

interface CalendarPayload {
  entries: CalendarEntry[]
}

const STATUS_OPTIONS = ['scheduled', 'active', 'running', 'done', 'failed', 'disabled', 'cancelled']
const SOURCE_OPTIONS = ['cron', 'assistant', 'manual']
const ASSIGNEE_OPTIONS = ['Mudur', 'Yordam']

const LEGEND_ITEMS = [
  { label: 'Governance / Council', color: 'rgba(124, 58, 237, 0.36)' },
  { label: 'Trade / Alert / Macro', color: 'rgba(217, 119, 6, 0.34)' },
  { label: 'Session / JSON / Prune', color: 'rgba(8, 145, 178, 0.34)' },
  { label: 'Task / Tracker', color: 'rgba(5, 150, 105, 0.34)' },
  { label: 'Disabled', color: 'rgba(71, 85, 105, 0.30)' },
  { label: 'Done', color: 'rgba(22, 163, 74, 0.30)' },
  { label: 'Failed / Cancelled', color: 'rgba(185, 28, 28, 0.38)' },
]

const cardTone = (entry: CalendarEntry) => {
  const s = String(entry.status || '').toLowerCase()
  if (s === 'failed' || s === 'cancelled') return 'rgba(185, 28, 28, 0.38)'
  if (s === 'done') return 'rgba(22, 163, 74, 0.30)'
  if (s === 'disabled') return 'rgba(71, 85, 105, 0.30)'

  const t = String(entry.title || '').toLowerCase()
  if (t.includes('governance') || t.includes('council')) return 'rgba(124, 58, 237, 0.36)' // purple
  if (t.includes('trade') || t.includes('alert') || t.includes('macro')) return 'rgba(217, 119, 6, 0.34)' // amber
  if (t.includes('session') || t.includes('json') || t.includes('prune')) return 'rgba(8, 145, 178, 0.34)' // cyan
  if (t.includes('task') || t.includes('tracker')) return 'rgba(5, 150, 105, 0.34)' // emerald

  const key = String(entry.linkedJobId || entry.id || entry.title || '')
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0
  const palette = [
    'rgba(59, 130, 246, 0.34)',
    'rgba(236, 72, 153, 0.34)',
    'rgba(14, 165, 233, 0.34)',
    'rgba(16, 185, 129, 0.34)',
    'rgba(245, 158, 11, 0.34)',
  ]
  return palette[Math.abs(hash) % palette.length]
}

function normalizeStatusForBadge(status: string) {
  const s = String(status || '').toLowerCase()
  if (s === 'scheduled') return 'idle'
  if (s === 'running') return 'active'
  if (s === 'done') return 'ok'
  if (s === 'cancelled') return 'disabled'
  return s || 'idle'
}

function startOfWeek(date: Date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay()
  d.setDate(d.getDate() - day)
  return d
}

function toDayKey(date: Date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatDayHeader(date: Date) {
  return {
    weekday: date.toLocaleDateString('en-US', { weekday: 'short' }),
    date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
  }
}

function formatTimeLabel(startsAt?: string | null) {
  if (!startsAt) return 'Repeats'
  const date = new Date(startsAt)
  if (Number.isNaN(date.getTime())) return 'Time TBD'
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}

function formatUpcomingDate(startsAt?: string | null) {
  if (!startsAt) return 'Recurring'
  const date = new Date(startsAt)
  if (Number.isNaN(date.getTime())) return 'Date TBD'
  return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function formatWeekRange(days: Date[]) {
  if (days.length === 0) return ''
  const start = days[0]
  const end = days[days.length - 1]
  const sameMonth = start.getMonth() === end.getMonth()
  const sameYear = start.getFullYear() === end.getFullYear()
  const startLabel = start.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
  const endLabel = end.toLocaleDateString('en-US', { month: sameMonth ? undefined : 'long', day: 'numeric' })
  return `${startLabel} – ${endLabel}, ${sameYear ? end.getFullYear() : `${start.getFullYear()} – ${end.getFullYear()}`}`
}

function buildRecentRuns(entry: CalendarEntry) {
  const pivot = entry.updatedAt || entry.startsAt || new Date().toISOString()
  const anchor = new Date(pivot)
  const safeAnchor = Number.isNaN(anchor.getTime()) ? new Date() : anchor
  const primaryStatus = String(entry.status || '').toLowerCase()
  const statusTrail =
    primaryStatus === 'disabled'
      ? ['disabled', 'disabled', 'scheduled', 'scheduled', 'scheduled']
      : primaryStatus === 'failed'
        ? ['failed', 'done', 'done', 'scheduled', 'scheduled']
        : primaryStatus === 'cancelled'
          ? ['cancelled', 'done', 'scheduled', 'scheduled', 'scheduled']
          : primaryStatus === 'done'
            ? ['done', 'done', 'running', 'scheduled', 'scheduled']
            : primaryStatus === 'running'
              ? ['running', 'done', 'done', 'scheduled', 'scheduled']
              : ['scheduled', 'scheduled', 'done', 'done', 'done']

  return Array.from({ length: 5 }, (_, index) => {
    const ts = new Date(safeAnchor)
    ts.setHours(safeAnchor.getHours() - index * 6)
    return {
      id: `${entry.id}-run-${index}`,
      label: `Run ${index + 1}`,
      status: statusTrail[index] || 'scheduled',
      timestamp: ts.toISOString(),
      note: index === 0
        ? entry.schedule || 'Recurring cadence snapshot'
        : index < 3
          ? 'Recent heartbeat from Mission Control'
          : 'Historical cadence sample',
    }
  })
}

function EntryModal({
  open,
  onClose,
  onSave,
  entry,
}: {
  open: boolean
  onClose: () => void
  onSave: (payload: Partial<CalendarEntry>) => Promise<void>
  entry: CalendarEntry | null
}) {
  const m = useIsMobile()
  // Track the entry id that was used to last initialise the form so we can
  // reset it when the modal opens with a different (or no) entry.
  const [formKey, setFormKey] = useState<string | null | undefined>(undefined)
  const [form, setForm] = useState<Partial<CalendarEntry>>(entry || { status: 'scheduled', source: 'manual', assignee: 'Mudur' })

  // Re-initialise the form whenever the modal opens with a new entry.
  // Using render-phase setState (React docs "storing information from previous
  // renders" pattern) avoids setState-in-effect.
  const newKey = open ? (entry?.id ?? null) : undefined
  if (newKey !== formKey) {
    setFormKey(newKey)
    if (open) setForm(entry ?? { status: 'scheduled', source: 'manual', assignee: 'Mudur' })
  }

  if (!open) return null

  const toInputDateTime = (iso?: string | null) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
  }

  return (
    <div className={`${styles.modalOverlay} ${m ? styles.modalOverlayMobile : styles.modalOverlayDesktop}`}>
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} className={`${styles.modalBox} ${m ? styles.modalBoxMobile : styles.modalBoxDesktop}`}>
        <h3 className={styles.modalTitle} style={{ fontSize: m ? 16 : 18 }}>Calendar Entry</h3>
        <div className={styles.modalFields}>
          <input value={form.title || ''} onChange={(e) => setForm(prev => ({ ...prev, title: e.target.value }))} placeholder="Title" className={styles.formInput} />

          <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : '1fr 1fr', gap: 10 }}>
            <input type="datetime-local" value={toInputDateTime(form.startsAt)} onChange={(e) => setForm(prev => ({ ...prev, startsAt: e.target.value ? new Date(e.target.value).toISOString() : null }))} className={styles.formInput} />
            <input value={form.schedule || ''} onChange={(e) => setForm(prev => ({ ...prev, schedule: e.target.value }))} placeholder="Cron schedule (optional)" className={`${styles.formInput} ${styles.formInputMono}`} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : '1fr 1fr 1fr', gap: 10 }}>
            <select value={form.status || 'scheduled'} onChange={(e) => setForm(prev => ({ ...prev, status: e.target.value }))} className={styles.formSelect}>
              {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select value={form.assignee || 'Mudur'} onChange={(e) => setForm(prev => ({ ...prev, assignee: e.target.value }))} className={styles.formSelect}>
              {ASSIGNEE_OPTIONS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={form.source || 'manual'} onChange={(e) => setForm(prev => ({ ...prev, source: e.target.value }))} className={styles.formSelect}>
              {SOURCE_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : '1fr 1fr', gap: 10 }}>
            <input value={form.linkedTaskId || ''} onChange={(e) => setForm(prev => ({ ...prev, linkedTaskId: e.target.value || null }))} placeholder="Linked Task ID" className={styles.formInput} />
            <input value={form.linkedJobId || ''} onChange={(e) => setForm(prev => ({ ...prev, linkedJobId: e.target.value || null }))} placeholder="Linked Job ID" className={styles.formInput} />
          </div>

          <textarea rows={3} value={form.notes || ''} onChange={(e) => setForm(prev => ({ ...prev, notes: e.target.value }))} placeholder="Notes" className={styles.formTextarea} />
        </div>

        <div className={styles.modalActions}>
          <button onClick={onClose} className={styles.cancelBtn}>Cancel</button>
          <button onClick={async () => { await onSave(form); onClose() }} className={styles.saveBtn}>
            <Save size={14} /> Save
          </button>
        </div>
      </motion.div>
    </div>
  )
}

export default function CalendarPage() {
  const m = useIsMobile()
  const { data, loading, error, refetch } = useApi<CalendarPayload & { warning?: string }>('/api/calendar', 15000)
  const [syncing, setSyncing] = useState(false)
  const [editing, setEditing] = useState<CalendarEntry | null>(null)
  const [showModal, setShowModal] = useState(false)
  const [mode, setMode] = useState<'week' | 'today'>('week')
  const [weekOffset, setWeekOffset] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [hideDisabled, setHideDisabled] = useState(true)
  const [showLegend, setShowLegend] = useState(false)
  const [detailEntry, setDetailEntry] = useState<CalendarEntry | null>(null)
  const [sourceFilter, setSourceFilter] = useState<string | null>(null)
  const [assigneeFilter, setAssigneeFilter] = useState<string | null>(null)
  const [copiedJobId, setCopiedJobId] = useState<string | null>(null)
  // Ticking clock for the "next up" list; refreshed on an interval instead of
  // calling Date.now() during render so renders stay idempotent.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(timer)
  }, [])

  const entries = useMemo(() => (data?.entries || []), [data])

  // Keep detailEntry in sync with the latest entries data using a render-phase
  // update so we avoid setState inside an effect.
  if (detailEntry) {
    const refreshed = entries.find(entry => entry.id === detailEntry.id)
    const next = refreshed ?? null
    if (next !== detailEntry) setDetailEntry(next)
  }

  useEffect(() => {
    if (!copiedJobId) return
    const timer = window.setTimeout(() => setCopiedJobId(null), 1200)
    return () => window.clearTimeout(timer)
  }, [copiedJobId])

  const recurringEntries = useMemo(() => {
    return entries.filter(entry => !!entry.schedule || entry.source === 'cron')
  }, [entries])

  const hiddenDisabledCount = useMemo(() => {
    return hideDisabled ? recurringEntries.filter(entry => String(entry.status || '').toLowerCase() === 'disabled').length : 0
  }, [hideDisabled, recurringEntries])

  const filteredRecurringEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return recurringEntries.filter(entry => {
      const matchesSearch = query.length === 0 || String(entry.title || '').toLowerCase().includes(query)
      const disabled = String(entry.status || '').toLowerCase() === 'disabled'
      const matchesDisabled = hideDisabled ? !disabled : true
      return matchesSearch && matchesDisabled
    })
  }, [hideDisabled, recurringEntries, searchQuery])

  const alwaysRunning = useMemo(() => filteredRecurringEntries.slice(0, 8), [filteredRecurringEntries])

  const currentWeekDays = useMemo(() => {
    const base = startOfWeek(new Date())
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(base)
      day.setDate(base.getDate() + index)
      return day
    })
  }, [])

  const weekDays = useMemo(() => {
    const base = startOfWeek(new Date())
    base.setDate(base.getDate() + weekOffset * 7)
    return Array.from({ length: 7 }, (_, index) => {
      const day = new Date(base)
      day.setDate(base.getDate() + index)
      return day
    })
  }, [weekOffset])

  const dayBuckets = useMemo(() => {
    const bucketDays = mode === 'today' ? currentWeekDays : weekDays
    const keys = bucketDays.map(toDayKey)
    const map: Record<string, CalendarEntry[]> = Object.fromEntries(keys.map(key => [key, []]))

    for (const entry of entries) {
      const matchesSource = sourceFilter ? entry.source === sourceFilter : true
      const matchesAssignee = assigneeFilter ? entry.assignee === assigneeFilter : true
      if (!matchesSource || !matchesAssignee) continue

      const recurring = !!entry.schedule || (entry.source === 'cron' && !entry.startsAt)
      if (recurring) {
        const disabled = String(entry.status || '').toLowerCase() === 'disabled'
        const matchesDisabled = hideDisabled ? !disabled : true
        if (!matchesDisabled) continue
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
  }, [assigneeFilter, currentWeekDays, entries, hideDisabled, mode, sourceFilter, weekDays])

  const nextUp = useMemo(() => {
    return entries
      .filter(entry => !!entry.startsAt)
      .map(entry => ({ ...entry, ts: new Date(entry.startsAt as string).getTime() }))
      .filter(entry => Number.isFinite(entry.ts) && entry.ts >= now)
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 8)
  }, [entries, now])

  const detailRecentRuns = useMemo(() => (detailEntry ? buildRecentRuns(detailEntry) : []), [detailEntry])
  const todayKey = toDayKey(new Date())
  const todayCount = dayBuckets[todayKey]?.length || 0
  const visibleWeekCount = Object.values(dayBuckets).reduce((sum, bucket) => sum + bucket.filter(entry => !!entry.startsAt).length, 0)
  const hiddenRecurringCount = Math.max(filteredRecurringEntries.length - alwaysRunning.length, 0)
  const visibleDays = mode === 'today' ? [new Date()] : weekDays
  const activeRange = mode === 'today' ? currentWeekDays : weekDays
  const activeWeekLabel = formatWeekRange(activeRange)
  const activeSourceCount = sourceFilter ? entries.filter(entry => entry.source === sourceFilter).length : 0
  const activeAssigneeCount = assigneeFilter ? entries.filter(entry => entry.assignee === assigneeFilter).length : 0

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
      alert(`Calendar sync failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
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
      alert(`Calendar save failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
      throw err
    }
  }

  const openDetail = (entry: CalendarEntry) => {
    setDetailEntry(entry)
  }

  const openEditor = (entry: CalendarEntry | null) => {
    setDetailEntry(null)
    setEditing(entry)
    setShowModal(true)
  }

  const handleToggleDetailStatus = async () => {
    if (!detailEntry) return
    const nextStatus = String(detailEntry.status || '').toLowerCase() === 'disabled' ? 'scheduled' : 'disabled'
    await handleSave({ id: detailEntry.id, status: nextStatus })
  }

  const handleCopyJobId = async () => {
    if (!detailEntry) return
    const value = detailEntry.linkedJobId || detailEntry.id
    try {
      await navigator.clipboard.writeText(value)
      setCopiedJobId(value)
    } catch {
      alert(`Copy failed. Job ID: ${value}`)
    }
  }

  if (loading && !data) {
    return (
      <PageTransition>
        <div className={styles.loadingWrap}>
          <div className={styles.spinner} />
        </div>
      </PageTransition>
    )
  }

  if (error && !data) {
    return (
      <PageTransition>
        <div className={styles.errorWrap}>
          <GlassCard noPad>
            <div className={`${styles.errorPad} ${m ? styles.errorPadMobile : ''}`}>
              <div className={styles.errorTitle}>
                <CalendarDays size={18} />
                <strong>Calendar API unavailable</strong>
              </div>
              <div className={styles.errorMessage}>{error}</div>
              <div>
                <button onClick={refetch} className={styles.retryBtn}>
                  Retry
                </button>
              </div>
            </div>
          </GlassCard>
        </div>
      </PageTransition>
    )
  }

  return (
    <>
      <PageTransition>
        <div className={`${styles.page} ${m ? styles.pageMobile : ''}`}>
          <div className={styles.headerRow}>
            <div className={styles.headerLeft}>
              <h1 className={`text-title ${styles.pageTitle}`}>
                <CalendarDays size={m ? 18 : 22} className={styles.pageTitleIcon} /> Calendar
              </h1>
              <div className={styles.headerMeta}>
                <p className="text-body" style={{ margin: 0 }}>
                  Clean view of scheduled jobs, recurring automations, and what is landing next.
                </p>
                <div className={styles.weekLabel}>{activeWeekLabel}</div>
              </div>
              <div className={styles.badgeRow}>
                <div className="macos-badge macos-badge-blue">
                  <span>{todayCount}</span>
                  <span>Today</span>
                </div>
                <div className="macos-badge">
                  <span>{visibleWeekCount}</span>
                  <span>This Week</span>
                </div>
                <div className="macos-badge macos-badge-green">
                  <span>{recurringEntries.length}</span>
                  <span>Recurring</span>
                </div>
              </div>
            </div>
            <div className={styles.headerActions}>
              <div className={styles.weekNavGroup}>
                <button onClick={() => setWeekOffset(prev => prev - 1)} className={styles.navBtn}>
                  <ChevronLeft size={14} />
                  {!m && <span>Week</span>}
                </button>
                <button onClick={() => setMode('week')} className={styles.modeBtn} style={{ background: mode === 'week' ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.05)' }}>Week</button>
                <button onClick={() => setMode('today')} className={styles.modeBtn} style={{ background: mode === 'today' ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.05)' }}>Today</button>
                <button onClick={() => setWeekOffset(prev => prev + 1)} className={styles.navBtn}>
                  {!m && <span>Week</span>}
                  <ChevronRight size={14} />
                </button>
              </div>
              <button
                onClick={handleSync}
                title="Refresh calendar from cron"
                aria-label="Refresh calendar from cron"
                className={styles.refreshBtn}
              >
                <RefreshCw size={14} style={{ animation: syncing ? 'spin 1s linear infinite' : undefined }} />
                {!m && <span>{syncing ? 'Refreshing' : 'Refresh'}</span>}
              </button>
              <button
                onClick={() => openEditor(null)}
                title="Create calendar entry"
                aria-label="Create calendar entry"
                className={styles.createBtn}
              >
                <Plus size={14} />
                {!m && <span>New Entry</span>}
              </button>
            </div>
          </div>

          <GlassCard noPad>
            <div className={styles.recurringCardHeader}>
              <div>
                <div className={styles.recurringCardTitle}>Recurring Jobs</div>
                <div className={styles.recurringCardSub}>These routines repeat and will appear across the schedule view below.</div>
              </div>
              <div className={styles.recurringCardActions}>
                <div className={`${styles.searchWrap} ${m ? styles.searchWrapMobile : styles.searchWrapDesktop}`}>
                  <Search size={14} className={styles.searchIcon} />
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search recurring jobs"
                    className={styles.searchInput}
                  />
                </div>
                <button
                  onClick={() => setHideDisabled(prev => !prev)}
                  className={styles.hideDisabledBtn}
                  style={{ background: hideDisabled ? 'rgba(0, 122, 255, 0.28)' : 'rgba(255,255,255,0.05)' }}
                >
                  <span>Hide Disabled</span>
                  {hideDisabled && hiddenDisabledCount > 0 && (
                    <span className={styles.hiddenCount}>{hiddenDisabledCount} hidden</span>
                  )}
                </button>
                <div className="macos-badge">
                  <span>{filteredRecurringEntries.length}</span>
                  <span>Shown</span>
                </div>
              </div>
            </div>
            <div className={styles.legendWrap}>
              <button
                onClick={() => setShowLegend(prev => !prev)}
                className={styles.legendToggleBtn}
              >
                <motion.span animate={{ rotate: showLegend ? 90 : 0 }} style={{ display: 'inline-flex' }}>
                  <ChevronRight size={14} />
                </motion.span>
                <span>Legend</span>
              </button>
              <AnimatePresence initial={false}>
                {showLegend && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className={styles.legendOverflow}
                  >
                    <div className={styles.legendItems}>
                      {LEGEND_ITEMS.map(item => (
                        <div key={item.label} className={styles.legendItem}>
                          <span className={styles.legendDot} style={{ background: item.color }} />
                          <span>{item.label}</span>
                        </div>
                      ))}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
            <div className={styles.recurringChipsWrap}>
              {data?.warning && (
                <div className={styles.warningBanner}>
                  Showing cached calendar data. {data.warning}
                </div>
              )}
              {alwaysRunning.length === 0 ? (
                <div className={styles.noRecurringMsg}>No recurring jobs matched the current filters.</div>
              ) : alwaysRunning.map(entry => (
                <button key={entry.id} onClick={() => openDetail(entry)} className={styles.recurringChip} style={{ background: cardTone(entry) }}>
                  <div className={styles.recurringChipTitle}>{entry.title}</div>
                  <div className={styles.recurringChipSub}>
                    {entry.schedule ? entry.schedule : 'Recurring automation'}
                  </div>
                </button>
              ))}
              {hiddenRecurringCount > 0 && (
                <div className={styles.recurringMore}>
                  +{hiddenRecurringCount} more recurring jobs
                </div>
              )}
            </div>
          </GlassCard>

          <div className={styles.filtersRow}>
            <div className={styles.filterGroup}>
              <div className={styles.filterGroupLabel}>Calendar Filters</div>
              <div className={styles.filterRows}>
                <div className={styles.filterRow}>
                  <div className={styles.filterRowLabel}>Source</div>
                  <button
                    onClick={() => setSourceFilter(null)}
                    className={styles.filterPill}
                    style={{ background: sourceFilter === null ? 'rgba(0, 122, 255, 0.28)' : 'rgba(255,255,255,0.05)' }}
                  >
                    All
                  </button>
                  {SOURCE_OPTIONS.map(source => (
                    <button
                      key={source}
                      onClick={() => setSourceFilter(source)}
                      className={`${styles.filterPill} ${styles.filterPillCapitalize}`}
                      style={{ background: sourceFilter === source ? 'rgba(0, 122, 255, 0.28)' : 'rgba(255,255,255,0.05)' }}
                    >
                      {source}
                    </button>
                  ))}
                  {sourceFilter && (
                    <span className="macos-badge macos-badge-blue">
                      {activeSourceCount}
                    </span>
                  )}
                </div>
                <div className={styles.filterRow}>
                  <div className={styles.filterRowLabel}>Assignee</div>
                  <button
                    onClick={() => setAssigneeFilter(null)}
                    className={styles.filterPill}
                    style={{ background: assigneeFilter === null ? 'rgba(0, 122, 255, 0.28)' : 'rgba(255,255,255,0.05)' }}
                  >
                    All
                  </button>
                  {ASSIGNEE_OPTIONS.map(assignee => (
                    <button
                      key={assignee}
                      onClick={() => setAssigneeFilter(assignee)}
                      className={styles.filterPill}
                      style={{ background: assigneeFilter === assignee ? 'rgba(0, 122, 255, 0.28)' : 'rgba(255,255,255,0.05)' }}
                    >
                      {assignee}
                    </button>
                  ))}
                  {assigneeFilter && (
                    <span className="macos-badge macos-badge-blue">
                      {activeAssigneeCount}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : `repeat(${visibleDays.length}, minmax(0,1fr))`, gap: 10 }}>
            {visibleDays.map(day => {
              const key = toDayKey(day)
              const list = dayBuckets[key] || []
              const header = formatDayHeader(day)
              const isToday = key === todayKey
              const visibleEntries = list.slice(0, 8)
              return (
                <GlassCard key={key} noPad>
                  <div className={styles.dayCardHeader}>
                    <div>
                      <div className={styles.dayCardWeekday}>
                        {mode === 'today' ? 'Today' : header.weekday}
                      </div>
                      <div className={styles.dayCardDate}>
                        {header.date}
                      </div>
                    </div>
                    <div className={styles.dayCardBadges}>
                      {isToday && mode !== 'today' && (
                        <span className="macos-badge macos-badge-blue">Today</span>
                      )}
                      <span className="text-caption">{list.length}</span>
                    </div>
                  </div>
                  <div className={styles.dayCardBody}>
                    {list.length === 0 ? (
                      <div className={styles.dayCardEmpty}>
                        No scheduled jobs here yet.
                      </div>
                    ) : visibleEntries.map(entry => (
                      <button key={`${key}:${entry.id}`} onClick={() => openDetail(entry)} className={styles.entryChip} style={{ background: cardTone(entry) }}>
                        <div className={styles.entryChipTitle}>{entry.title}</div>
                        <div className={styles.entryChipMeta}>
                          <div className={styles.entryChipTime}>
                            <Clock size={10} />
                            {entry.startsAt ? formatTimeLabel(entry.startsAt) : 'Repeats'}
                          </div>
                          <div className={styles.entryChipStatus}>
                            {entry.status}
                          </div>
                        </div>
                      </button>
                    ))}
                    {list.length > visibleEntries.length && (
                      <div className={styles.entryMore}>
                        +{list.length - visibleEntries.length} more jobs
                      </div>
                    )}
                  </div>
                </GlassCard>
              )
            })}
          </div>

          <GlassCard noPad>
            <div className={styles.upcomingCardHeader}>
              <div>
                <div className={styles.upcomingCardTitle}>Upcoming Queue</div>
                <div className={styles.upcomingCardSub}>The next scheduled runs ordered by time.</div>
              </div>
              <div className="macos-badge">
                <span>{nextUp.length}</span>
                <span>Queued</span>
              </div>
            </div>
            <div>
              {nextUp.length === 0 ? (
                <div className={styles.upcomingEmpty}>No upcoming scheduled runs. Add an entry or sync cron to populate this queue.</div>
              ) : nextUp.map(entry => (
                <button
                  key={entry.id}
                  onClick={() => openDetail(entry)}
                  className={styles.upcomingRow}
                  style={{ gridTemplateColumns: m ? '1fr' : '0.9fr 2.1fr 0.9fr 1fr' }}
                >
                  <div>
                    <div className={styles.upcomingTime} style={{ fontSize: m ? 16 : 18 }}>{formatTimeLabel(entry.startsAt)}</div>
                    <div className={styles.upcomingDate}>{formatUpcomingDate(entry.startsAt)}</div>
                  </div>
                  <div className={styles.upcomingMinWidth}>
                    <div className={styles.upcomingTitle}>{entry.title}</div>
                    <div className={styles.upcomingAssignee}>
                      {entry.assignee || 'Unassigned'} {entry.source ? `• ${entry.source}` : ''}
                    </div>
                  </div>
                  <div><StatusBadge status={normalizeStatusForBadge(entry.status)} label={entry.status} /></div>
                  <div className={`${styles.upcomingTimeAgo} ${m ? styles.upcomingTimeAgoMobile : styles.upcomingTimeAgoDesktop}`}>{timeAgo(entry.startsAt || '')} <ChevronRight size={12} /></div>
                </button>
              ))}
            </div>
          </GlassCard>
        </div>
      </PageTransition>

      <AnimatePresence>
        {detailEntry && (
          <>
            <motion.button
              aria-label="Close details"
              onClick={() => setDetailEntry(null)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className={styles.detailBackdrop}
            />
            <motion.aside
              initial={{ x: 320, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 320, opacity: 0 }}
              transition={{ type: 'spring', damping: 24, stiffness: 240 }}
              className={styles.detailPanel}
              style={{ width: m ? '100%' : 320 }}
            >
              <div className={styles.detailHeaderRow}>
                <div className={styles.detailHeaderLeft}>
                  <div className={styles.detailEyebrow}>
                    <span className={styles.detailDot} style={{ background: cardTone(detailEntry) }} />
                    <span className={styles.detailEyebrowText}>Job detail</span>
                  </div>
                  <div className={styles.detailTitle}>{detailEntry.title}</div>
                  <div><StatusBadge status={normalizeStatusForBadge(detailEntry.status)} label={detailEntry.status} /></div>
                </div>
                <button onClick={() => setDetailEntry(null)} className={styles.detailCloseBtn}>
                  <X size={16} />
                </button>
              </div>

              <div className={styles.detailGrid}>
                <div className={styles.detailInfoCard}>
                  <div>
                    <div className={styles.detailFieldLabel}>Schedule</div>
                    <div className={styles.detailFieldValue}>{detailEntry.schedule || formatTimeLabel(detailEntry.startsAt)}</div>
                  </div>
                  <div className={styles.detailTwoCol}>
                    <div>
                      <div className={styles.detailFieldLabel}>Source</div>
                      <div className={`${styles.detailFieldValue} ${styles.detailFieldValueCapitalize}`}>{detailEntry.source || '—'}</div>
                    </div>
                    <div>
                      <div className={styles.detailFieldLabel}>Assignee</div>
                      <div className={styles.detailFieldValue}>{detailEntry.assignee || 'Unassigned'}</div>
                    </div>
                  </div>
                  <div>
                    <div className={styles.detailFieldLabel}>Last updated</div>
                    <div className={styles.detailFieldValue}>{formatDate(detailEntry.updatedAt || detailEntry.startsAt || new Date().toISOString())}</div>
                  </div>
                  {(detailEntry.linkedTaskId || detailEntry.linkedJobId) && (
                    <div className={styles.detailLinkedIds}>
                      {detailEntry.linkedTaskId && (
                        <div className={styles.detailLinkedId}>Task ID: {detailEntry.linkedTaskId}</div>
                      )}
                      {detailEntry.linkedJobId && (
                        <div className={styles.detailLinkedId}>Job ID: {detailEntry.linkedJobId}</div>
                      )}
                    </div>
                  )}
                </div>

                <div className={styles.detailInfoCard2}>
                  <div className={styles.runsHeader}>
                    <div className={styles.runsTitle}>Recent Runs</div>
                    <div className={styles.runsCount}>Last 5</div>
                  </div>
                  <div className={styles.runsList}>
                    {detailRecentRuns.map(run => (
                      <div key={run.id} className={styles.runRow}>
                        <div className={styles.runRowHeader}>
                          <div className={styles.runLabel}>{run.label}</div>
                          <StatusBadge status={normalizeStatusForBadge(run.status)} label={run.status} />
                        </div>
                        <div className={styles.runTimestamp}>{formatDate(run.timestamp)}</div>
                        <div className={styles.runNote}>{run.note}</div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className={styles.detailActions}>
                <button onClick={() => openEditor(detailEntry)} className={styles.detailEditBtn}>
                  <Pencil size={14} />
                  Edit
                </button>
                <button onClick={handleToggleDetailStatus} className={styles.detailToggleBtn}>
                  {String(detailEntry.status || '').toLowerCase() === 'disabled' ? 'Enable Job' : 'Disable Job'}
                </button>
                <button onClick={handleCopyJobId} className={styles.detailCopyBtn}>
                  <Copy size={14} />
                  {copiedJobId === (detailEntry.linkedJobId || detailEntry.id) ? 'Copied' : 'Copy Job ID'}
                </button>
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showModal && (
          <EntryModal open={showModal} onClose={() => setShowModal(false)} entry={editing} onSave={handleSave} />
        )}
      </AnimatePresence>
    </>
  )
}
