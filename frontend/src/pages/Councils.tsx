import { useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RefreshCcw } from 'lucide-react'
import { fetchJson, useApi } from '../lib/hooks'
import { useNow } from '../lib/useNow'
import {
  isOpenDecisionStatus,
  normalizeDecisionStatus,
  normalizeHealthState,
  type HealthState,
} from '../lib/status'
import { stateLabel, toUiState, type UiState } from '../lib/state'
import {
  AlarmLine,
  Block,
  Button,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  FilterChips,
  Mono,
  Page,
  SearchInput,
  Select,
  Skeleton,
  StateMark,
  StatePill,
  type AlarmLineProps,
  type DataTableColumn,
  cx,
} from '../components/ui'
import { formatAsOf } from '../components/ui/asOf'
import { parseTime } from '../lib/time'
import styles from './Councils.module.css'

type CouncilFilter = 'ALL' | 'EC' | 'OC' | 'TFC' | 'CROSS'
type CouncilKey = Exclude<CouncilFilter, 'ALL'>

const councilLabels: Record<CouncilFilter, string> = {
  ALL: 'All',
  EC: 'Executive',
  OC: 'Operations',
  TFC: 'Trade & Finance',
  CROSS: 'Cross-council',
}

const councilKeys: CouncilKey[] = ['EC', 'OC', 'TFC', 'CROSS']

const MAX_ROWS = 80

type Decision = {
  decisionId: string
  council: string
  context: string
  decision: string
  outcome?: string
  conditions?: string[]
  voters?: string[]
  modelFamilies?: string[]
  options?: string[]
  quorum?: { required?: number; present?: number }
  dissent?: string[]
  owner: string
  risk: string
  status?: string
  revisitDate?: string
  evidence?: string[]
  rationale?: string
  updatedAt?: string
  createdAt?: string
  linkedTaskId?: string
  delegatedTaskState?: string
  source?: string
}

type TimelineEvent = {
  eventId?: string
  eventType?: string
  type?: string
  source?: string
  timestamp?: string
  createdAt?: string
  payload?: { note?: string; action?: string; by?: string; [key: string]: unknown }
}

type CouncilMetrics = {
  activeDecisions?: number
  totalDecisions?: number
  conditionalApprovals?: number
  rejectedDecisions?: number
}

type CouncilArchive = {
  totalDecisions?: number
  lastDecisionAt?: string | null
}

type CouncilSummary = {
  archive?: CouncilArchive
  metrics?: CouncilMetrics
  councils?: Partial<Record<CouncilKey, {
    totalDecisions?: number
    openDecisions?: number
    approved?: number
    rejected?: number
  }>>
}

type DecisionsPayload = {
  decisions?: Decision[]
}

type GovernanceScorecard = {
  overall?: string
  metrics?: {
    delegationAutorunAttempts?: number
    delegationAutorunInfraFailureAttempts?: number
  }
  review?: {
    workflowSurfaceLive24h?: number
    governanceEventsLive24h?: number
    workflowSurfaceSilenceHours?: number | null
    governanceOnlyLive24h?: boolean
    governanceOnlyLive4d?: boolean
    selfReferentialSurfaceWarn?: boolean
    idleAdvisories?: string[]
    rcaTaskActive?: string | null
  } | null
}

type TimelinePayload = {
  events?: TimelineEvent[]
}

type TimelineState = 'loading' | 'ready' | 'error'

const safeSegment = (value: string) => {
  const raw = (value || '').toString()
  const normalized = raw.replace(/[\uD800-\uDFFF]/g, '')
  return encodeURIComponent(normalized)
}

/** A real number, or null (rendered as "—"). Never a made-up zero. */
const numberOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const formatCount = (value: unknown): string | null => {
  const n = numberOrNull(value)
  return n === null ? null : n.toLocaleString('en-US')
}

const statusLabel = (status: string) => {
  const text = status.replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const decisionStatus = (decision: Decision) =>
  normalizeDecisionStatus(decision.status || decision.outcome || decision.decision)

const councilName = (council: string) => councilLabels[council as CouncilFilter] ?? (council || '—')

function StatusCell({ status }: { status: string }) {
  if (isOpenDecisionStatus(status)) return <StatePill state="warning" label="Open" />
  return <span>{statusLabel(status)}</span>
}

/** A real observed time, as the clock reads it: "12:41" today, "11 Nov, 12:41" before. No time means "—", never a made-up one. */
function ObservedTime({ value }: { value: string | number | Date | null | undefined }) {
  const now = useNow()
  const ms = parseTime(value)
  if (ms === null) return <span>—</span>
  const text = formatAsOf(ms, now)?.replace(/^as of /, '') ?? '—'
  return (
    <time className={styles.time} dateTime={new Date(ms).toISOString()} title={new Date(ms).toLocaleString()}>
      {text}
    </time>
  )
}

/** A value that could not be read: hollow circle and "not read" (HMI rule 8). */
function NotRead({ children = 'not read' }: { children?: ReactNode }) {
  return (
    <span className={styles.notRead}>
      <StateMark state="unavailable" />
      {children}
    </span>
  )
}

/** One reading of the governance block: what it is, its value (right-aligned digits), and where it comes from. */
function Reading({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <li className={styles.reading}>
      <span className={styles.readingLabel}>{label}</span>
      <span className={styles.readingValue}>{children}</span>
      {note ? <span className={styles.readingNote}>{note}</span> : <span />}
    </li>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.fact}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

export default function Councils() {
  const summary = useApi<CouncilSummary>('/api/councils/summary', 10000)
  const decisionsApi = useApi<DecisionsPayload>('/api/councils/decisions', 12000)
  const scorecard = useApi<GovernanceScorecard>('/api/councils/governance/scorecard', 12000)

  // Council, status and search live in the URL (?council=EC&status=open&q=…) so a view can be shared or reloaded.
  const [params, setParams] = useSearchParams()
  const councilParam = params.get('council')
  const activeCouncil: CouncilFilter = (['ALL', ...councilKeys] as string[]).includes(councilParam ?? '')
    ? (councilParam as CouncilFilter)
    : 'ALL'
  const statusFilter = params.get('status') ?? 'ALL'
  const search = params.get('q') ?? ''
  const setParam = (key: 'council' | 'status' | 'q', value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value === '' || value === 'ALL') next.delete(key)
        else next.set(key, value)
        return next
      },
      { replace: true },
    )
  const setActiveCouncil = (value: CouncilFilter) => setParam('council', value)
  const setStatusFilter = (value: string) => setParam('status', value)
  const setSearch = (value: string) => setParam('q', value)
  const [selected, setSelected] = useState<Decision | null>(null)
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [timelineState, setTimelineState] = useState<TimelineState>('ready')

  const allDecisions = useMemo<Decision[]>(() => decisionsApi.data?.decisions || [], [decisionsApi.data])
  const archive = summary.data?.archive || {}
  const metrics = summary.data?.metrics || {}
  const review = scorecard.data?.review || null

  const loadTimeline = async (decision: Decision) => {
    try {
      const j = await fetchJson<TimelinePayload>(`/api/councils/decisions/${safeSegment(decision.decisionId)}/timeline`)
      setTimeline(j.events || [])
      setTimelineState('ready')
    } catch {
      setTimeline([])
      setTimelineState('error')
    }
  }

  const refreshAll = async () => {
    await Promise.all([summary.refetch(), decisionsApi.refetch(), scorecard.refetch()])
    if (selected) await loadTimeline(selected)
  }

  const openDecision = async (decision: Decision) => {
    setSelected(decision)
    setTimeline([])
    setTimelineState('loading')
    await loadTimeline(decision)
  }

  const statusOptions = useMemo(() => {
    const statuses = new Set<string>()
    allDecisions.forEach((decision) => statuses.add(decisionStatus(decision)))
    return [
      { value: 'ALL', label: 'All statuses' },
      ...Array.from(statuses).sort().map((status) => ({ value: status, label: statusLabel(status) })),
    ]
  }, [allDecisions])

  const councilOptions = useMemo(
    () =>
      (['ALL', ...councilKeys] as CouncilFilter[]).map((key) => {
        const count = key === 'ALL' ? null : numberOrNull(summary.data?.councils?.[key]?.totalDecisions)
        return { value: key, label: councilLabels[key], ...(count === null ? {} : { count }) }
      }),
    [summary.data],
  )

  const filteredDecisions = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allDecisions.filter((decision) => {
      const councilOk = activeCouncil === 'ALL' || String(decision.council || '').toUpperCase() === activeCouncil
      const status = decisionStatus(decision)
      const statusOk = statusFilter === 'ALL' || status === statusFilter
      const searchOk = !q || [decision.decisionId, decision.context, decision.rationale, decision.owner, decision.risk, decision.linkedTaskId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
      return councilOk && statusOk && searchOk
    })
  }, [activeCouncil, allDecisions, search, statusFilter])

  // The scorecard's own verdict, when it gave a known word. A missing or unknown word is "not read".
  const scorecardOverall = useMemo<HealthState | null>(() => {
    const word = normalizeHealthState(scorecard.data?.overall, 'gray')
    return scorecard.data?.overall && word !== 'gray' ? word : null
  }, [scorecard.data?.overall])

  const workflowState = useMemo<HealthState>(() => {
    if (!review) return 'gray'
    // A count that was not read is not "zero real work".
    const realWork = numberOrNull(review.workflowSurfaceLive24h)
    if (realWork === null) return 'gray'
    if (realWork === 0 || Boolean(review.selfReferentialSurfaceWarn)) return 'yellow'
    return scorecardOverall ?? 'gray'
  }, [review, scorecardOverall])

  const openApprovals = numberOrNull(metrics.activeDecisions)
  const hasOpenApprovals = openApprovals !== null && openApprovals > 0
  const governanceOnly = Boolean(review?.governanceOnlyLive24h || review?.governanceOnlyLive4d || review?.selfReferentialSurfaceWarn)
  const workflowUi: UiState = toUiState(workflowState)
  // With no review there is no judgement of real work. Say what the scorecard did report instead of "Unavailable".
  const overallValue = !review && scorecardOverall ? `Scorecard: ${scorecardOverall}` : stateLabel(workflowUi)
  const overallHint = scorecardOverall ? 'no review recorded' : 'no review reported'
  const silenceHours = numberOrNull(review?.workflowSurfaceSilenceHours)
  const infraFailures = numberOrNull(scorecard.data?.metrics?.delegationAutorunInfraFailureAttempts)
  const totalDecisions = formatCount(archive.totalDecisions ?? metrics.totalDecisions)
  const selectedDecision = selected
    ? allDecisions.find((decision) => decision.decisionId === selected.decisionId) || selected
    : null

  const filtersActive = activeCouncil !== 'ALL' || statusFilter !== 'ALL' || search.trim() !== ''
  const clearFilters = () =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        for (const key of ['council', 'status', 'q']) next.delete(key)
        return next
      },
      { replace: true },
    )

  const columns: DataTableColumn<Decision>[] = [
    {
      key: 'updated',
      header: 'Time',
      width: '120px',
      cell: (decision) => <ObservedTime value={decision.updatedAt || decision.createdAt} />,
    },
    {
      key: 'decision',
      header: 'Decision',
      width: '18%',
      cell: (decision) => (
        <div className={styles.idCell}>
          <Mono truncate>{decision.decisionId}</Mono>
          <span className={styles.sub}>{councilName(decision.council)}</span>
        </div>
      ),
    },
    {
      key: 'context',
      header: 'Context',
      cell: (decision) => <span className={styles.context}>{decision.context || 'No context recorded'}</span>,
    },
    {
      key: 'status',
      header: 'Status',
      width: '140px',
      cell: (decision) => <StatusCell status={decisionStatus(decision)} />,
    },
    { key: 'owner', header: 'Owner', width: '120px', cell: (decision) => decision.owner || '—' },
    { key: 'risk', header: 'Risk', width: '88px', cell: (decision) => decision.risk || '—' },
    {
      key: 'task',
      header: 'Task',
      width: '120px',
      hideOnMobile: true,
      cell: (decision) => (decision.linkedTaskId ? <Mono truncate>{decision.linkedTaskId}</Mono> : '—'),
    },
  ]

  const loadingFirst = (summary.loading || decisionsApi.loading) && !summary.data && !decisionsApi.data
  const readError = decisionsApi.error || summary.error

  // The page's one alarm line: the worst thing first, the others named in its detail. Nothing abnormal: no line.
  const alarms: Array<Pick<AlarmLineProps, 'state' | 'title' | 'detail' | 'action'>> = []
  if (infraFailures !== null && infraFailures > 0) {
    alarms.push({
      state: 'critical',
      title: `${infraFailures} automatic task ${infraFailures === 1 ? 'attempt' : 'attempts'} failed`,
      detail: 'Failed for infrastructure reasons, not because of a decision.',
    })
  }
  if (hasOpenApprovals) {
    const canShowOpen = allDecisions.some((decision) => decisionStatus(decision) === 'open')
    alarms.push({
      state: 'warning',
      title: `${openApprovals} council ${openApprovals === 1 ? 'decision is' : 'decisions are'} still open`,
      detail: 'Open approvals should be rare.',
      action: canShowOpen ? { label: 'Show open decisions', onClick: () => setStatusFilter('open') } : undefined,
    })
  }
  if (governanceOnly) {
    alarms.push({
      state: 'warning',
      title: 'Only audit activity, no real work',
      detail: silenceHours === null ? undefined : `No real-work event for ${Math.round(silenceHours)} h.`,
    })
  }
  const alarm = alarms[0] ?? null
  const alsoNamed = alarms.slice(1).map((item) => item.title)

  // One quiet line under the Decisions header: what the archive is. Open approvals are the alarm line's to say.
  const archiveLine = () => {
    if (!summary.data) return null
    const lead = hasOpenApprovals
      ? null
      : openApprovals === null
        ? 'Open approvals could not be read.'
        : 'Read-only archive: councils no longer run live work.'
    if (!lead && totalDecisions === null) return null
    return (
      <>
        {lead}
        {totalDecisions !== null ? `${lead ? ' ' : ''}${totalDecisions} ${totalDecisions === '1' ? 'decision' : 'decisions'} on record` : null}
        {totalDecisions !== null && archive.lastDecisionAt ? <>, last <ObservedTime value={archive.lastDecisionAt} /></> : null}
        {totalDecisions !== null ? '.' : null}
      </>
    )
  }

  const shownCount = Math.min(filteredDecisions.length, MAX_ROWS)

  return (
    <Page
      title="Audit"
      description="What was decided, and is governance outrunning real work?"
      actions={
        <Button size="sm" icon={<RefreshCcw size={14} aria-hidden="true" />} onClick={refreshAll}>
          Refresh
        </Button>
      }
    >
      {alarm && (
        <AlarmLine
          state={alarm.state}
          title={alarm.title}
          detail={
            <>
              {alarm.detail}
              {alarm.detail && alsoNamed.length > 0 ? ' ' : null}
              {alsoNamed.length > 0 ? `Also: ${alsoNamed.join('; ')}.` : null}
            </>
          }
          action={alarm.action}
        />
      )}

      <Block title="Governance against real work" meta="Last 24 hours" padding="none">
        {scorecard.loading && !scorecard.data ? (
          <div className={styles.pad}>
            <Skeleton variant="block" label="Reading governance check" />
          </div>
        ) : scorecard.error && !scorecard.data ? (
          <p className={cx(styles.pad, styles.notReadLine)}>
            <NotRead>Governance check not read. {scorecard.error}</NotRead>
          </p>
        ) : (
          <>
            <ul className={styles.readings} aria-label="Governance versus real workflow, last 24 hours">
              <Reading label="Overall" note={review ? 'audit activity against real work' : overallHint}>
                <StatePill state={workflowUi} label={overallValue} />
              </Reading>
              <Reading label="Real work" note="events, last 24 hours">
                {formatCount(review?.workflowSurfaceLive24h) ?? <NotRead />}
              </Reading>
              <Reading label="Audit's own events" note="logged automatically, last 24 hours">
                {formatCount(review?.governanceEventsLive24h) ?? <NotRead />}
              </Reading>
              <Reading label="Time without real work" note="since the last real-work event">
                {silenceHours === null ? (
                  <NotRead />
                ) : governanceOnly ? (
                  <StatePill state="warning" label={`${Math.round(silenceHours)} h`} />
                ) : (
                  `${Math.round(silenceHours)} h`
                )}
              </Reading>
              <Reading label="Automatic task attempts">
                {formatCount(scorecard.data?.metrics?.delegationAutorunAttempts) ?? <NotRead />}
              </Reading>
              <Reading label="Failed attempts" note="infrastructure problems">
                {infraFailures === null ? (
                  <NotRead />
                ) : infraFailures > 0 ? (
                  <StatePill state="critical" label={String(infraFailures)} />
                ) : (
                  formatCount(infraFailures)
                )}
              </Reading>
            </ul>
            {(review?.rcaTaskActive || review?.idleAdvisories?.length) ? (
              <div className={styles.advisoryBox}>
                {review?.rcaTaskActive ? <p className={styles.noticeLine}>Investigation task open: <Mono>{review.rcaTaskActive}</Mono></p> : null}
                {review?.idleAdvisories?.length ? (
                  <ul className={styles.advisories}>
                    {review.idleAdvisories.slice(0, 6).map((item: string) => <li key={item}>{item}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </Block>

      {loadingFirst ? (
        <Skeleton variant="block" size="lg" label="Reading decisions" />
      ) : readError && !decisionsApi.data ? (
        <ErrorState
          title="Decisions could not be read"
          message={readError}
          onRetry={() => { void Promise.all([summary.refetch(), decisionsApi.refetch()]) }}
        />
      ) : (
        <Block
          title="Decisions"
          meta={`Showing ${shownCount} of ${allDecisions.length}`}
          description={archiveLine()}
          padding="none"
        >
          <div className={styles.toolbar}>
            <SearchInput
              value={search}
              onChange={setSearch}
              label="Search decisions"
              placeholder="Search id, context, owner, risk or task"
              className={styles.search}
            />
            <FilterChips
              ariaLabel="Council"
              options={councilOptions}
              value={activeCouncil}
              onChange={(value) => setActiveCouncil(value as CouncilFilter)}
            />
            <Select
              aria-label="Status"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              options={statusOptions}
              className={styles.statusSelect}
            />
          </div>
          <DataTable
            caption="Council decisions"
            columns={columns}
            rows={filteredDecisions.slice(0, MAX_ROWS)}
            rowKey={(decision) => decision.decisionId}
            rowLabel={(decision) => `Decision ${decision.decisionId}`}
            onRowClick={(decision) => { void openDecision(decision) }}
            selectedKey={selectedDecision?.decisionId ?? null}
            empty={
              allDecisions.length === 0 ? (
                <EmptyState title="No decisions recorded" description="Nothing has been decided by a council yet." />
              ) : (
                <EmptyState
                  title="No decisions match these filters"
                  action={filtersActive ? <Button size="sm" onClick={clearFilters}>Clear filters</Button> : undefined}
                />
              )
            }
          />
          {filteredDecisions.length > MAX_ROWS && (
            <p className={styles.more}>Showing {MAX_ROWS} of {filteredDecisions.length} decisions. Narrow the filters to see the rest.</p>
          )}
        </Block>
      )}

      <Drawer
        open={selectedDecision !== null}
        onClose={() => setSelected(null)}
        title={selectedDecision?.context || 'Decision'}
        description={selectedDecision ? `${councilName(selectedDecision.council)} · ${selectedDecision.decisionId}` : undefined}
        size="lg"
      >
        {selectedDecision && (
          <div className={styles.drawerBody}>
            <section className={styles.section}>
              <dl className={styles.facts}>
                <Fact label="Outcome"><StatusCell status={decisionStatus(selectedDecision)} /></Fact>
                <Fact label="Owner">{selectedDecision.owner || '—'}</Fact>
                <Fact label="Risk">{selectedDecision.risk || '—'}</Fact>
                <Fact label="Revisit">{selectedDecision.revisitDate || '—'}</Fact>
                <Fact label="Updated"><ObservedTime value={selectedDecision.updatedAt || selectedDecision.createdAt} /></Fact>
                {selectedDecision.delegatedTaskState ? <Fact label="Task state">{selectedDecision.delegatedTaskState}</Fact> : null}
                {selectedDecision.linkedTaskId ? <Fact label="Task"><Mono>{selectedDecision.linkedTaskId}</Mono></Fact> : null}
                {selectedDecision.quorum ? (
                  <Fact label="Voters present / required">
                    <Mono>{selectedDecision.quorum.present ?? '—'} / {selectedDecision.quorum.required ?? '—'}</Mono>
                  </Fact>
                ) : null}
                {selectedDecision.voters?.length ? <Fact label="Voters">{selectedDecision.voters.join(', ')}</Fact> : null}
                {selectedDecision.modelFamilies?.length ? <Fact label="Models">{selectedDecision.modelFamilies.join(', ')}</Fact> : null}
              </dl>
            </section>

            {selectedDecision.rationale ? (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Rationale</h3>
                <p className={styles.text}>{selectedDecision.rationale}</p>
              </section>
            ) : null}

            {selectedDecision.conditions?.length ? (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Conditions</h3>
                <ul className={styles.list}>
                  {selectedDecision.conditions.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                </ul>
              </section>
            ) : null}

            {selectedDecision.evidence?.length ? (
              <section className={styles.section}>
                <h3 className={styles.sectionTitle}>Readings</h3>
                <ul className={styles.list}>
                  {selectedDecision.evidence.slice(0, 8).map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
                </ul>
              </section>
            ) : null}

            <section className={styles.section}>
              <h3 className={styles.sectionTitle}>Timeline</h3>
              {timelineState === 'loading' ? (
                <Skeleton variant="line" lines={3} label="Reading timeline" />
              ) : timelineState === 'error' ? (
                <p className={styles.muted}>The timeline could not be read.</p>
              ) : timeline.length === 0 ? (
                <p className={styles.muted}>No timeline events for this decision.</p>
              ) : (
                <ol className={styles.timeline}>
                  {timeline.slice(0, 30).map((event, index) => (
                    <li key={`${event.eventId || index}`} className={styles.timelineEvent}>
                      <div className={styles.timelineHead}>
                        <span className={styles.timelineType}>{event.eventType || event.type || 'event'}</span>
                        <span className={styles.timelineMeta}>
                          <ObservedTime value={event.timestamp || event.createdAt} /> · {event.source || 'unknown source'}
                        </span>
                      </div>
                      {event.payload?.note ? <p className={styles.text}>{event.payload.note}</p> : null}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        )}
      </Drawer>
    </Page>
  )
}
