import { useEffect, useMemo, useState } from 'react'
import { BookOpenText, Search, CalendarDays, Clock3, FileText, ChevronDown, ChevronRight } from 'lucide-react'
import PageTransition from '../components/PageTransition'
import GlassCard from '../components/GlassCard'
import { useIsMobile } from '../lib/useIsMobile'
import { formatDate, timeAgo } from '../lib/hooks'
import styles from './Memory.module.css'

type MemoryScope = 'all' | 'daily' | 'longterm'

interface MemoryDoc {
  id: string
  title: string
  scope: Exclude<MemoryScope, 'all'>
  date: string | null
  path: string
  preview: string
  fullText: string
  updatedAt: string
}

interface MemoryResponse {
  documents: MemoryDoc[]
  total: number
  query: string
  scope: MemoryScope
  limit: number
}

const scopeOptions: { value: MemoryScope; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'daily', label: 'Daily' },
  { value: 'longterm', label: 'Long-term' },
]

function groupLabel(doc: MemoryDoc) {
  if (doc.scope === 'longterm') return 'Long-term'
  if (!doc.date) return 'Daily'
  const d = new Date(doc.date)
  const now = new Date()
  const dayMs = 24 * 60 * 60 * 1000
  const diff = Math.floor((now.setHours(0, 0, 0, 0) - d.setHours(0, 0, 0, 0)) / dayMs)
  if (diff <= 7) return 'This Week'
  if (diff <= 31) return 'This Month'
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' })
}

export default function Memory() {
  const isMobile = useIsMobile()
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<MemoryScope>('all')
  const [data, setData] = useState<MemoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setLoading(true)
      try {
        const params = new URLSearchParams()
        params.set('scope', scope)
        params.set('limit', '120')
        if (query.trim()) params.set('query', query.trim())

        const response = await fetch(`/api/memory?${params.toString()}`, { signal: controller.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)

        const payload = (await response.json()) as MemoryResponse
        setData(payload)
        setError(null)
      } catch (err) {
        if ((err as { name?: string })?.name !== 'AbortError') {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        setLoading(false)
      }
    }, 180)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [query, scope])

  const docs = useMemo(() => data?.documents || [], [data])

  // Derive the effective selectedId from the current docs list without an effect.
  // React allows calling setState during render when deriving state from other state/props.
  const computedSelectedId: string | null = !docs.length
    ? null
    : (selectedId && docs.some((d) => d.id === selectedId) ? selectedId : docs[0].id)
  if (computedSelectedId !== selectedId) {
    setSelectedId(computedSelectedId)
  }

  const selectedDoc = useMemo(() => docs.find((d) => d.id === selectedId) || null, [docs, selectedId])

  const grouped = useMemo(() => {
    const g: Record<string, MemoryDoc[]> = {}
    for (const d of docs) {
      const label = groupLabel(d)
      g[label] = g[label] || []
      g[label].push(d)
    }
    return Object.entries(g)
  }, [docs])

  // Merge new group labels into collapsedGroups during render (default: expanded).
  // React allows render-phase setState when deriving state from other state/props.
  const mergedCollapsed = useMemo(() => {
    if (!grouped.length) return collapsedGroups
    let changed = false
    const next = { ...collapsedGroups }
    for (const [label] of grouped) {
      if (next[label] === undefined) { next[label] = false; changed = true }
    }
    return changed ? next : collapsedGroups
  }, [grouped, collapsedGroups])
  if (mergedCollapsed !== collapsedGroups) {
    setCollapsedGroups(mergedCollapsed)
  }

  const timelineEntries = useMemo(() => {
    if (!selectedDoc) return []
    const lines = (selectedDoc.fullText || '').split('\n').map((x) => x.trim()).filter(Boolean)
    const entries: { title: string; body: string }[] = []
    let current: { title: string; body: string[] } | null = null
    for (const ln of lines) {
      if (ln.startsWith('#')) {
        if (current) entries.push({ title: current.title, body: current.body.join(' ') })
        current = { title: ln.replace(/^#+\s*/, ''), body: [] }
      } else if (current) {
        current.body.push(ln)
      }
    }
    if (current) entries.push({ title: current.title, body: current.body.join(' ') })
    if (!entries.length) {
      return [{ title: selectedDoc.title, body: selectedDoc.fullText || selectedDoc.preview }]
    }
    return entries.slice(0, 60)
  }, [selectedDoc])

  return (
    <PageTransition>
      <div className={styles.page}>
        <div>
          <h1 className={`text-title ${styles.pageTitle}`}>
            <BookOpenText size={22} className={styles.pageTitleIcon} /> Memory Surface
          </h1>
          <p className="text-body" style={{ marginTop: 4 }}>Search daily notes and long-term memory without leaving the operational view.</p>
        </div>

        <GlassCard noPad>
          <div className={styles.searchCardPad}>
            <div className={styles.searchWrap}>
              <Search size={16} className={styles.searchIcon} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search memories..."
                className={`macos-input ${styles.searchInput}`}
              />
            </div>
            <div className={styles.filterBadges}>
              <span className={styles.docCountBadge}>
                {docs.length} docs
              </span>
              <span className={styles.scopeBadge}>
                Scope: {scopeOptions.find((opt) => opt.value === scope)?.label || 'All'}
              </span>
            </div>
            <div className={styles.scopeBtns}>
              {scopeOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setScope(opt.value)}
                  className={styles.scopeBtn}
                  style={{
                    border: scope === opt.value ? '1px solid rgba(124,77,255,0.6)' : '1px solid rgba(255,255,255,0.1)',
                    background: scope === opt.value ? 'rgba(124,77,255,0.2)' : 'rgba(255,255,255,0.05)',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </GlassCard>

        {error && <div className={`macos-panel ${styles.errorPanel}`}>{error}</div>}

        <div className={styles.splitGrid} style={{ gridTemplateColumns: isMobile ? '1fr' : '300px 1fr' }}>
          <GlassCard noPad>
            <div className={styles.listHeader}>
              Memory ({docs.length})
            </div>
            <div className={`${styles.listBody} ${isMobile ? styles.listBodyMobile : styles.listBodyDesktop}`}>
              {loading ? (
                <div className={styles.listLoading}>Loading...</div>
              ) : docs.length === 0 ? (
                <div className={styles.listEmpty}>No memory found.</div>
              ) : (
                grouped.map(([label, items]) => {
                  const collapsed = !!collapsedGroups[label]
                  return (
                    <div key={label} className={styles.groupWrap}>
                      <button
                        onClick={() => setCollapsedGroups((prev) => ({ ...prev, [label]: !collapsed }))}
                        className={styles.groupToggle}
                      >
                        <span className={styles.groupToggleLabel}>
                          {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                          {label} ({items.length})
                        </span>
                      </button>

                      {!collapsed && (
                        <div className={styles.groupItems}>
                          {items.map((d) => {
                            const active = d.id === selectedId
                            return (
                              <button
                                key={d.id}
                                onClick={() => setSelectedId(d.id)}
                                className={`${styles.docItem} ${active ? styles.docItemActive : styles.docItemInactive}`}
                              >
                                <div className={styles.docItemTitle}>{d.title}</div>
                                <div className={styles.docItemMeta}>
                                  <span className={styles.docMetaItem}><FileText size={11} />{d.scope}</span>
                                  <span className={styles.docMetaItem}><Clock3 size={11} />{timeAgo(d.updatedAt)}</span>
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </GlassCard>

          <GlassCard noPad>
            <div className={styles.viewerHeader}>
              {selectedDoc ? (
                <>
                  <div className={styles.viewerScopeLabel}>{selectedDoc.scope === 'longterm' ? 'Long-term Memory' : 'Daily Memory'}</div>
                  <h2 className={styles.viewerTitle}>{selectedDoc.title}</h2>
                  <div className={styles.viewerDateRow}>
                    {selectedDoc.date ? <span className={styles.viewerDateItem}><CalendarDays size={12} />{selectedDoc.date}</span> : null}
                    <span className={styles.viewerDateItem}><Clock3 size={12} />{formatDate(selectedDoc.updatedAt)}</span>
                  </div>
                </>
              ) : (
                <div className={styles.viewerPlaceholder}>Select a memory document…</div>
              )}
            </div>

            <div className={styles.viewerBody}>
              {!selectedDoc ? null : (
                <div className={styles.timelineList}>
                  {timelineEntries.map((e, idx) => (
                    <div key={`${idx}-${e.title}`} className={styles.timelineEntry}>
                      <div className={styles.timelineIndex}>
                        {idx === 0 ? 'Now' : `#${idx + 1}`}
                      </div>
                      <div>
                        <div className={styles.timelineEntryTitle}>{e.title}</div>
                        <div className={styles.timelineEntryBody}>
                          {e.body || selectedDoc.preview}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </GlassCard>
        </div>
      </div>
    </PageTransition>
  )
}
