import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Activity, AlertTriangle, Archive, FileText, RefreshCcw, Search, ShieldCheck, X } from 'lucide-react'
import PageTransition from '../components/PageTransition'
import { useApi, timeAgo } from '../lib/hooks'
import {
  healthStateBadgeStatus,
  healthStateColor,
  isOpenDecisionStatus,
  normalizeDecisionStatus,
  normalizeHealthState,
  type HealthState,
} from '../lib/status'
import StatusBadge from '../components/StatusBadge'
import styles from './Councils.module.css'

type CouncilFilter = 'ALL' | 'EC' | 'OC' | 'TFC' | 'CROSS'
type CouncilKey = Exclude<CouncilFilter, 'ALL'>

const councilLabels: Record<CouncilFilter, string> = {
  ALL: 'All',
  EC: 'Executive',
  OC: 'Operations',
  TFC: 'Trade & Finance',
  CROSS: 'Cross-Council',
}

const councilTone: Record<CouncilKey, string> = {
  EC: '#64D2FF',
  OC: '#32D74B',
  TFC: '#FF9500',
  CROSS: '#BF5AF2',
}

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

const safeSegment = (value: string) => {
  const raw = (value || '').toString()
  const normalized = raw.replace(/[\uD800-\uDFFF]/g, '')
  return encodeURIComponent(normalized)
}

const compactCount = (value: unknown) => Number(value || 0).toLocaleString('en-US')

function MiniMetric({ label, value, tone = 'rgba(255,255,255,0.94)', sub }: { label: string; value: string | number; tone?: string; sub?: string }) {
  return (
    <div className={styles.miniMetric}>
      <div className={styles.miniMetricLabel}>{label}</div>
      <div className={styles.miniMetricValue} style={{ color: tone }}>{value}</div>
      {sub ? <div className={styles.miniMetricSub}>{sub}</div> : null}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className={styles.emptyState}>
      {text}
    </div>
  )
}

export default function Councils() {
  const navigate = useNavigate()
  const summary = useApi<CouncilSummary>('/api/councils/summary', 10000)
  const decisionsApi = useApi<DecisionsPayload>('/api/councils/decisions', 12000)
  const scorecard = useApi<GovernanceScorecard>('/api/councils/governance/scorecard', 12000)

  const [activeCouncil, setActiveCouncil] = useState<CouncilFilter>('ALL')
  const [statusFilter, setStatusFilter] = useState('ALL')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Decision | null>(null)
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])

  const allDecisions = useMemo<Decision[]>(() => decisionsApi.data?.decisions || [], [decisionsApi.data])
  const archive = summary.data?.archive || {}
  const metrics = summary.data?.metrics || {}
  const councils = summary.data?.councils || {}
  const review = scorecard.data?.review || null

  const refreshAll = async () => {
    await Promise.all([summary.refetch(), decisionsApi.refetch(), scorecard.refetch()])
    if (selected) {
      const r = await fetch(`/api/councils/decisions/${safeSegment(selected.decisionId)}/timeline`)
      const j = await r.json() as TimelinePayload
      setTimeline(j.events || [])
    }
  }

  const openDecision = async (decision: Decision) => {
    setSelected(decision)
    try {
      const r = await fetch(`/api/councils/decisions/${safeSegment(decision.decisionId)}/timeline`)
      const j = await r.json() as TimelinePayload
      setTimeline(j.events || [])
    } catch {
      setTimeline([])
    }
  }

  const statusOptions = useMemo(() => {
    const statuses = new Set<string>()
    allDecisions.forEach((decision) => statuses.add(normalizeDecisionStatus(decision.status || decision.outcome || decision.decision)))
    return ['ALL', ...Array.from(statuses).sort()]
  }, [allDecisions])

  const filteredDecisions = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allDecisions.filter((decision) => {
      const councilOk = activeCouncil === 'ALL' || String(decision.council || '').toUpperCase() === activeCouncil
      const status = normalizeDecisionStatus(decision.status || decision.outcome || decision.decision)
      const statusOk = statusFilter === 'ALL' || status === statusFilter
      const searchOk = !q || [decision.decisionId, decision.context, decision.rationale, decision.owner, decision.risk, decision.linkedTaskId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
      return councilOk && statusOk && searchOk
    })
  }, [activeCouncil, allDecisions, search, statusFilter])

  const workflowState = useMemo<HealthState>(() => {
    if (!review) return 'gray'
    if (Number(review.workflowSurfaceLive24h || 0) === 0 || Boolean(review.selfReferentialSurfaceWarn)) return 'yellow'
    return normalizeHealthState(scorecard.data?.overall, 'green')
  }, [review, scorecard.data?.overall])

  const isArchiveMode = Number(metrics.activeDecisions || 0) === 0
  const governanceOnly = Boolean(review?.governanceOnlyLive24h || review?.governanceOnlyLive4d || review?.selfReferentialSurfaceWarn)
  const scoreTone = healthStateColor(workflowState)
  const selectedDecision = selected
    ? allDecisions.find((decision) => decision.decisionId === selected.decisionId) || selected
    : null

  return (
    <PageTransition>
      {/* Note: councils-page global class required for index.css hover-transform suppression on .macos-panel */}
      <div className={`councils-page ${styles.page}`}>
        <div className={styles.headerRow}>
          <div>
            <div className={styles.archiveLabel}>
              <Archive size={15} /> DECISION ARCHIVE
            </div>
            <h1 className="text-title">Decision Archive · Governance Health</h1>
            <p className={`text-body ${styles.pageSubtitle}`}>
              Councils are no longer the live work queue. This page is the decision archive, open-approval alarm, and drift check for governance becoming louder than real workflow.
            </p>
          </div>
          <button onClick={refreshAll} className={styles.refreshBtn}>
            <RefreshCcw size={14} /> Refresh
          </button>
        </div>

        {(summary.loading || decisionsApi.loading) && <div className={`macos-panel ${styles.loadingBanner}`}>Loading governance archive...</div>}
        {(summary.error || decisionsApi.error) && <div className={`macos-panel ${styles.errorBanner}`}>Error: {summary.error || decisionsApi.error}</div>}

        {!!summary.data && (
          <>
            <div
              className={`macos-panel ${styles.alertPanel}`}
              style={{ border: `1px solid ${isArchiveMode ? 'rgba(100,210,255,0.28)' : 'rgba(255,149,0,0.42)'}` }}
            >
              <div className={styles.alertPanelHeader}>
                <div>
                  <div className={styles.alertPanelTitle}>
                    <ShieldCheck size={16} style={{ color: isArchiveMode ? '#64D2FF' : '#FF9500' }} />
                    {isArchiveMode ? 'Archive mode: no open council decisions' : 'Attention: open governance decisions exist'}
                  </div>
                  <div className={styles.alertPanelDesc}>
                    Live operation should happen in Cron Jobs, Digital Office, Workshop, or Agent Hub. This archive stays read-only unless council execution is explicitly restored.
                  </div>
                </div>
                <StatusBadge status={isArchiveMode ? 'info' : 'warning'} label={isArchiveMode ? 'Archive' : 'Action needed'} />
              </div>
              <div className={styles.alertPanelNavRow}>
                <button onClick={() => navigate('/cron')} className={styles.navBtn}>Open Cron Jobs</button>
                <button onClick={() => navigate('/office')} className={styles.navBtn}>Open Digital Office</button>
                <button onClick={() => navigate('/workshop')} className={styles.navBtn}>Open Workshop</button>
              </div>
              <div className={styles.alertMetricsGrid}>
                <MiniMetric label="Total decisions" value={compactCount(archive.totalDecisions ?? metrics.totalDecisions)} tone="#64D2FF" sub="full archive" />
                <MiniMetric label="Open approvals" value={compactCount(metrics.activeDecisions)} tone={Number(metrics.activeDecisions || 0) > 0 ? '#FF9500' : '#32D74B'} sub="should be rare" />
                <MiniMetric label="Conditional" value={compactCount(metrics.conditionalApprovals)} tone="#FF9500" sub="approved with caveats" />
                <MiniMetric label="Rejected" value={compactCount(metrics.rejectedDecisions)} tone="#FF453A" sub="audit trail" />
                <MiniMetric label="Last decision" value={archive.lastDecisionAt ? timeAgo(archive.lastDecisionAt) : '—'} tone="rgba(255,255,255,0.92)" sub={archive.lastDecisionAt || 'no timestamp'} />
              </div>
            </div>

            <div className={styles.twoPanelGrid}>
              <div className={`macos-panel ${styles.workflowPanel}`} style={{ border: `1px solid ${scoreTone}44` }}>
                <div className={styles.workflowPanelHeader}>
                  <div>
                    <div className={styles.workflowPanelTitle}>
                      <Activity size={15} style={{ color: scoreTone }} /> Governance vs Real Workflow
                    </div>
                    <div className={styles.workflowPanelDesc}>
                      If governance events exist but real workflow is silent, this turns yellow. It is an audit warning, not a work queue.
                    </div>
                  </div>
                  <StatusBadge status={healthStateBadgeStatus(workflowState)} label={workflowState} />
                </div>
                <div className={styles.workflowKpiGrid}>
                  <MiniMetric label="Real workflow" value={compactCount(review?.workflowSurfaceLive24h)} tone="#32D74B" sub="live 24h" />
                  <MiniMetric label="Governance auto-ops" value={compactCount(review?.governanceEventsLive24h)} tone="#FF9500" sub="live 24h" />
                  <MiniMetric label="Silence" value={review?.workflowSurfaceSilenceHours == null ? '—' : `${Math.round(Number(review.workflowSurfaceSilenceHours))}h`} tone={governanceOnly ? '#FF9500' : 'rgba(255,255,255,0.92)'} sub="since workflow signal" />
                </div>
                {review?.idleAdvisories?.length ? (
                  <div className={styles.idleAdvisories}>
                    {review.idleAdvisories.slice(0, 6).map((item: string) => (
                      <span key={item} className={styles.idleAdvisoryBadge}>{item}</span>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className={`macos-panel ${styles.healthPanel}`}>
                <div className={styles.healthPanelTitle}>
                  <AlertTriangle size={15} style={{ color: scorecard.data?.overall === 'yellow' ? '#FF9500' : '#32D74B' }} /> Health signals
                </div>
                <div className={styles.healthMetricGrid}>
                  <div className={styles.healthMetricRow}>
                    <span className={styles.healthMetricRowLabel}>Overall</span>
                    <b style={{ color: scorecard.data?.overall === 'yellow' ? '#FF9500' : '#32D74B', textTransform: 'uppercase' }}>{scorecard.data?.overall || 'unknown'}</b>
                  </div>
                  <div className={styles.healthMetricRow}>
                    <span className={styles.healthMetricRowLabel}>Autorun attempts</span>
                    <b>{compactCount(scorecard.data?.metrics?.delegationAutorunAttempts)}</b>
                  </div>
                  <div className={styles.healthMetricRow}>
                    <span className={styles.healthMetricRowLabel}>Infra failures</span>
                    <b style={{ color: Number(scorecard.data?.metrics?.delegationAutorunInfraFailureAttempts || 0) > 0 ? '#FF453A' : '#32D74B' }}>{compactCount(scorecard.data?.metrics?.delegationAutorunInfraFailureAttempts)}</b>
                  </div>
                  <div className={styles.healthMetricRow}>
                    <span className={styles.healthMetricRowLabel}>RCA active</span>
                    <b style={{ color: review?.rcaTaskActive ? '#FF9500' : 'rgba(255,255,255,0.86)' }}>{review?.rcaTaskActive || '—'}</b>
                  </div>
                </div>
                <div className={styles.healthPanelFooter}>
                  Gateway self-heal was removed from this page; it now reports audit and health, not mutations.
                </div>
              </div>
            </div>

            <div className={`macos-panel ${styles.archivePanel}`}>
              <div className={styles.archivePanelHeader}>
                <div>
                  <h3 className={styles.archivePanelTitle}>Decision Archive ({filteredDecisions.length})</h3>
                  <p className={styles.archivePanelSubtitle}>Read-only decision history. Not an action queue.</p>
                </div>
                <div className={styles.archiveFilterRow}>
                  <div className={styles.searchBox}>
                    <Search size={13} className={styles.searchIcon} />
                    <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search archive" className={styles.searchInput} />
                  </div>
                  <select value={activeCouncil} onChange={(event) => setActiveCouncil(event.target.value as CouncilFilter)} className={styles.archiveSelect}>
                    {Object.entries(councilLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className={styles.archiveSelect}>
                    {statusOptions.map((status) => <option key={status} value={status}>{status === 'ALL' ? 'All statuses' : status}</option>)}
                  </select>
                </div>
              </div>

              <div className={styles.councilTabGrid}>
                {(['EC', 'OC', 'TFC', 'CROSS'] as const).map((key) => {
                  const item = councils[key] || {}
                  return (
                    <button key={key} onClick={() => setActiveCouncil(key)} className={`macos-panel ${styles.councilTab}`}
                      style={{ border: activeCouncil === key ? `1px solid ${councilTone[key]}` : '1px solid rgba(255,255,255,0.08)' }}>
                      <div className={styles.councilTabHeader}>
                        <span className={styles.councilTabName}>{councilLabels[key]}</span>
                        <span style={{ fontSize: 18, fontWeight: 850, color: councilTone[key] }}>{compactCount(item.totalDecisions)}</span>
                      </div>
                      <div className={styles.councilTabStats}>
                        <span>open {compactCount(item.openDecisions)}</span>
                        <span>approved {compactCount(item.approved)}</span>
                        <span>rejected {compactCount(item.rejected)}</span>
                      </div>
                    </button>
                  )
                })}
              </div>

              {filteredDecisions.length === 0 ? <EmptyState text="No decision records match these filters." /> : (
                <div className={styles.decisionList}>
                  {filteredDecisions.slice(0, 80).map((decision) => {
                    const status = normalizeDecisionStatus(decision.status || decision.outcome || decision.decision)
                    const open = isOpenDecisionStatus(status)
                    const tone = open ? '#FF9500' : status === 'rejected' ? '#FF453A' : status === 'approved_with_conditions' ? '#FFB340' : '#32D74B'
                    return (
                      <button key={decision.decisionId} onClick={() => openDecision(decision)} className={styles.decisionRow}>
                        <div className={styles.decisionRowTop}>
                          <div className={styles.decisionRowIdGroup}>
                            <FileText size={14} style={{ color: councilTone[decision.council as CouncilKey] || '#8E8E93', flex: '0 0 auto' }} />
                            <span className={styles.decisionRowId}>{decision.decisionId}</span>
                            <span className={styles.decisionRowCouncil} style={{ color: councilTone[decision.council as CouncilKey] || '#8E8E93' }}>{decision.council}</span>
                          </div>
                          <span className={styles.decisionRowStatus} style={{ color: tone }}>{status}</span>
                        </div>
                        <p className={styles.decisionRowContext}>{decision.context || 'No context'}</p>
                        <div className={styles.decisionRowMeta}>
                          <span>Owner: {decision.owner || '—'}</span>
                          <span>Risk: {decision.risk || '—'}</span>
                          <span>{timeAgo(decision.updatedAt || decision.createdAt || '')}</span>
                          {decision.linkedTaskId ? <span>Task: {decision.linkedTaskId}</span> : null}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        )}

        {selectedDecision && (
          <div className={styles.drawerOverlay}>
            <div className={styles.drawer}>
              <div className={styles.drawerHeader}>
                <div>
                  <div className={styles.drawerCouncilLabel} style={{ color: councilTone[selectedDecision.council as CouncilKey] || 'rgba(255,255,255,0.62)' }}>{selectedDecision.council} · {selectedDecision.decisionId}</div>
                  <h3 className={styles.drawerDecisionTitle}>{selectedDecision.context}</h3>
                </div>
                <button onClick={() => setSelected(null)} className={styles.drawerCloseBtn}><X size={18} /></button>
              </div>

              <div className={styles.drawerDetails}>
                <div className={styles.drawerOutcome}><b>Outcome:</b> {normalizeDecisionStatus(selectedDecision.status || selectedDecision.outcome || selectedDecision.decision)}</div>
                <div className={styles.drawerMeta}>
                  Owner: {selectedDecision.owner || '—'} · Risk: {selectedDecision.risk || '—'} · Revisit: {selectedDecision.revisitDate || '—'} · Updated: {selectedDecision.updatedAt || selectedDecision.createdAt || '—'}
                  {selectedDecision.delegatedTaskState ? ` · Task: ${selectedDecision.delegatedTaskState}` : ''}
                </div>
                {selectedDecision.rationale ? <div className={styles.drawerRationale}><b>Rationale:</b> {selectedDecision.rationale}</div> : null}
                {selectedDecision.conditions?.length ? <div className={styles.drawerConditions}>Conditions: {selectedDecision.conditions.join(' · ')}</div> : null}
                {selectedDecision.quorum ? <div className={styles.drawerQuorum}>Quorum: {selectedDecision.quorum.present ?? '—'} / {selectedDecision.quorum.required ?? '—'}</div> : null}
                {selectedDecision.voters?.length ? <div className={styles.drawerVoters}>Voters: {selectedDecision.voters.join(', ')}</div> : null}
                {selectedDecision.modelFamilies?.length ? <div className={styles.drawerModels}>Models: {selectedDecision.modelFamilies.join(', ')}</div> : null}
                {selectedDecision.evidence?.length ? (
                  <div className={styles.drawerEvidence}>
                    <b>Evidence</b>
                    <ul className={styles.drawerEvidenceList}>
                      {selectedDecision.evidence.slice(0, 8).map((item, index) => <li key={`${item}-${index}`} className={styles.drawerEvidenceItem}>{item}</li>)}
                    </ul>
                  </div>
                ) : null}
              </div>

              <div className={styles.timelineSection}>
                <div className={styles.timelineTitle}>Timeline</div>
                {timeline.length === 0 ? <EmptyState text="No timeline events for this decision." /> : timeline.slice(0, 30).map((event, index) => (
                  <div key={`${event.eventId || index}`} className={styles.timelineEvent}>
                    <div className={styles.timelineEventType}>{event.eventType || event.type || 'event'}</div>
                    <div className={styles.timelineEventMeta}>{event.source || 'unknown'} · {timeAgo(event.timestamp || event.createdAt || '')}</div>
                    {event.payload?.note ? <div className={styles.timelineEventNote}>{event.payload.note}</div> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </PageTransition>
  )
}
