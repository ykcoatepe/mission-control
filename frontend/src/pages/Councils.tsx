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
    <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 12, padding: '10px 12px', minHeight: 76 }}>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.56)', fontWeight: 600 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 23, color: tone, fontWeight: 800, fontFeatureSettings: '"tnum"' }}>{value}</div>
      {sub ? <div style={{ marginTop: 3, fontSize: 10, color: 'rgba(255,255,255,0.42)' }}>{sub}</div> : null}
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{ padding: 18, borderRadius: 14, background: 'rgba(255,255,255,0.035)', border: '1px dashed rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.58)', fontSize: 12 }}>
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
      <div className="councils-page" style={{ maxWidth: 1280, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#64D2FF', fontSize: 12, fontWeight: 700, marginBottom: 6 }}>
              <Archive size={15} /> DECISION ARCHIVE
            </div>
            <h1 className="text-title">Decision Archive · Governance Health</h1>
            <p className="text-body" style={{ marginTop: 4, maxWidth: 760 }}>
              Councils are no longer the live work queue. This page is the decision archive, open-approval alarm, and drift check for governance becoming louder than real workflow.
            </p>
          </div>
          <button onClick={refreshAll} style={{ padding: '8px 12px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.86)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <RefreshCcw size={14} /> Refresh
          </button>
        </div>

        {(summary.loading || decisionsApi.loading) && <div className="macos-panel" style={{ padding: 16 }}>Loading governance archive...</div>}
        {(summary.error || decisionsApi.error) && <div className="macos-panel" style={{ padding: 16, borderLeft: '3px solid #FF453A' }}>Error: {summary.error || decisionsApi.error}</div>}

        {!!summary.data && (
          <>
            <div className="macos-panel" style={{ padding: 16, border: `1px solid ${isArchiveMode ? 'rgba(100,210,255,0.28)' : 'rgba(255,149,0,0.42)'}` }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 800, color: 'rgba(255,255,255,0.94)' }}>
                    <ShieldCheck size={16} style={{ color: isArchiveMode ? '#64D2FF' : '#FF9500' }} />
                    {isArchiveMode ? 'Archive mode: no open council decisions' : 'Attention: open governance decisions exist'}
                  </div>
                  <div style={{ marginTop: 5, fontSize: 11, color: 'rgba(255,255,255,0.58)' }}>
                    Live operation should happen in Cron Jobs, Digital Office, Workshop, or Agent Hub. This archive stays read-only unless council execution is explicitly restored.
                  </div>
                </div>
                <StatusBadge status={isArchiveMode ? 'info' : 'warning'} label={isArchiveMode ? 'Archive' : 'Action needed'} />
              </div>
              <div style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button onClick={() => navigate('/cron')} style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.82)', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>Open Cron Jobs</button>
                <button onClick={() => navigate('/office')} style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.82)', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>Open Digital Office</button>
                <button onClick={() => navigate('/workshop')} style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.82)', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>Open Workshop</button>
              </div>
              <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 10 }}>
                <MiniMetric label="Total decisions" value={compactCount(archive.totalDecisions ?? metrics.totalDecisions)} tone="#64D2FF" sub="full archive" />
                <MiniMetric label="Open approvals" value={compactCount(metrics.activeDecisions)} tone={Number(metrics.activeDecisions || 0) > 0 ? '#FF9500' : '#32D74B'} sub="should be rare" />
                <MiniMetric label="Conditional" value={compactCount(metrics.conditionalApprovals)} tone="#FF9500" sub="approved with caveats" />
                <MiniMetric label="Rejected" value={compactCount(metrics.rejectedDecisions)} tone="#FF453A" sub="audit trail" />
                <MiniMetric label="Last decision" value={archive.lastDecisionAt ? timeAgo(archive.lastDecisionAt) : '—'} tone="rgba(255,255,255,0.92)" sub={archive.lastDecisionAt || 'no timestamp'} />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.05fr) minmax(340px, 0.95fr)', gap: 14, alignItems: 'stretch' }}>
              <div className="macos-panel" style={{ padding: 15, border: `1px solid ${scoreTone}44` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <div>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 800, color: 'rgba(255,255,255,0.92)' }}>
                      <Activity size={15} style={{ color: scoreTone }} /> Governance vs Real Workflow
                    </div>
                    <div style={{ marginTop: 5, fontSize: 11, color: 'rgba(255,255,255,0.58)' }}>
                      If governance events exist but real workflow is silent, this turns yellow. It is an audit warning, not a work queue.
                    </div>
                  </div>
                  <StatusBadge status={healthStateBadgeStatus(workflowState)} label={workflowState} />
                </div>
                <div style={{ marginTop: 14, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 10 }}>
                  <MiniMetric label="Real workflow" value={compactCount(review?.workflowSurfaceLive24h)} tone="#32D74B" sub="live 24h" />
                  <MiniMetric label="Governance auto-ops" value={compactCount(review?.governanceEventsLive24h)} tone="#FF9500" sub="live 24h" />
                  <MiniMetric label="Silence" value={review?.workflowSurfaceSilenceHours == null ? '—' : `${Math.round(Number(review.workflowSurfaceSilenceHours))}h`} tone={governanceOnly ? '#FF9500' : 'rgba(255,255,255,0.92)'} sub="since workflow signal" />
                </div>
                {review?.idleAdvisories?.length ? (
                  <div style={{ marginTop: 12, display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                    {review.idleAdvisories.slice(0, 6).map((item: string) => (
                      <span key={item} style={{ borderRadius: 999, padding: '5px 8px', background: 'rgba(255,149,0,0.10)', border: '1px solid rgba(255,149,0,0.22)', color: '#FFB340', fontSize: 10, fontWeight: 650 }}>{item}</span>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="macos-panel" style={{ padding: 15 }}>
                <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 800, color: 'rgba(255,255,255,0.92)' }}>
                  <AlertTriangle size={15} style={{ color: scorecard.data?.overall === 'yellow' ? '#FF9500' : '#32D74B' }} /> Health signals
                </div>
                <div style={{ marginTop: 12, display: 'grid', gap: 9 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span style={{ color: 'rgba(255,255,255,0.56)' }}>Overall</span><b style={{ color: scorecard.data?.overall === 'yellow' ? '#FF9500' : '#32D74B', textTransform: 'uppercase' }}>{scorecard.data?.overall || 'unknown'}</b></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span style={{ color: 'rgba(255,255,255,0.56)' }}>Autorun attempts</span><b>{compactCount(scorecard.data?.metrics?.delegationAutorunAttempts)}</b></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span style={{ color: 'rgba(255,255,255,0.56)' }}>Infra failures</span><b style={{ color: Number(scorecard.data?.metrics?.delegationAutorunInfraFailureAttempts || 0) > 0 ? '#FF453A' : '#32D74B' }}>{compactCount(scorecard.data?.metrics?.delegationAutorunInfraFailureAttempts)}</b></div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}><span style={{ color: 'rgba(255,255,255,0.56)' }}>RCA active</span><b style={{ color: review?.rcaTaskActive ? '#FF9500' : 'rgba(255,255,255,0.86)' }}>{review?.rcaTaskActive || '—'}</b></div>
                </div>
                <div style={{ marginTop: 12, fontSize: 10, lineHeight: 1.5, color: 'rgba(255,255,255,0.48)' }}>
                  Gateway self-heal was removed from this page; it now reports audit and health, not mutations.
                </div>
              </div>
            </div>

            <div className="macos-panel" style={{ padding: 15 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 14, color: 'rgba(255,255,255,0.93)' }}>Decision Archive ({filteredDecisions.length})</h3>
                  <p style={{ margin: '4px 0 0', fontSize: 11, color: 'rgba(255,255,255,0.50)' }}>Read-only decision history. Not an action queue.</p>
                </div>
                <div style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 10px', borderRadius: 10, background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)' }}>
                    <Search size={13} style={{ color: 'rgba(255,255,255,0.45)' }} />
                    <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search archive" style={{ width: 180, border: 'none', outline: 'none', background: 'transparent', color: 'white', fontSize: 12 }} />
                  </div>
                  <select value={activeCouncil} onChange={(event) => setActiveCouncil(event.target.value as CouncilFilter)} style={{ padding: '7px 10px', borderRadius: 10, background: 'rgba(20,22,28,0.94)', color: 'white', border: '1px solid rgba(255,255,255,0.12)' }}>
                    {Object.entries(councilLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                  </select>
                  <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={{ padding: '7px 10px', borderRadius: 10, background: 'rgba(20,22,28,0.94)', color: 'white', border: '1px solid rgba(255,255,255,0.12)' }}>
                    {statusOptions.map((status) => <option key={status} value={status}>{status === 'ALL' ? 'All statuses' : status}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 10, marginBottom: 12 }}>
                {(['EC', 'OC', 'TFC', 'CROSS'] as const).map((key) => {
                  const item = councils[key] || {}
                  return (
                    <button key={key} onClick={() => setActiveCouncil(key)} className="macos-panel" style={{ padding: 12, textAlign: 'left', border: activeCouncil === key ? `1px solid ${councilTone[key]}` : '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.035)', cursor: 'pointer' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                        <span style={{ fontSize: 12, fontWeight: 800, color: 'rgba(255,255,255,0.9)' }}>{councilLabels[key]}</span>
                        <span style={{ fontSize: 18, fontWeight: 850, color: councilTone[key] }}>{compactCount(item.totalDecisions)}</span>
                      </div>
                      <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 10, color: 'rgba(255,255,255,0.52)' }}>
                        <span>open {compactCount(item.openDecisions)}</span>
                        <span>approved {compactCount(item.approved)}</span>
                        <span>rejected {compactCount(item.rejected)}</span>
                      </div>
                    </button>
                  )
                })}
              </div>

              {filteredDecisions.length === 0 ? <EmptyState text="No decision records match these filters." /> : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {filteredDecisions.slice(0, 80).map((decision) => {
                    const status = normalizeDecisionStatus(decision.status || decision.outcome || decision.decision)
                    const open = isOpenDecisionStatus(status)
                    const tone = open ? '#FF9500' : status === 'rejected' ? '#FF453A' : status === 'approved_with_conditions' ? '#FFB340' : '#32D74B'
                    return (
                      <button key={decision.decisionId} onClick={() => openDecision(decision)} style={{ textAlign: 'left', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, background: 'rgba(255,255,255,0.032)', padding: 12, cursor: 'pointer' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                            <FileText size={14} style={{ color: councilTone[decision.council as CouncilKey] || '#8E8E93', flex: '0 0 auto' }} />
                            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.92)', fontWeight: 750, whiteSpace: 'nowrap' }}>{decision.decisionId}</span>
                            <span style={{ fontSize: 10, color: councilTone[decision.council as CouncilKey] || '#8E8E93', fontWeight: 750 }}>{decision.council}</span>
                          </div>
                          <span style={{ fontSize: 10, color: tone, fontWeight: 800 }}>{status}</span>
                        </div>
                        <p style={{ margin: '6px 0 0', fontSize: 12, color: 'rgba(255,255,255,0.68)', lineHeight: 1.45 }}>{decision.context || 'No context'}</p>
                        <div style={{ marginTop: 7, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 10, color: 'rgba(255,255,255,0.42)' }}>
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
          <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(6px)', display: 'flex', justifyContent: 'flex-end' }}>
            <div style={{ width: 'min(720px, 96vw)', height: '100%', background: 'rgba(12,14,20,0.98)', borderLeft: '1px solid rgba(255,255,255,0.08)', padding: 16, overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 12, color: councilTone[selectedDecision.council as CouncilKey] || 'rgba(255,255,255,0.62)', fontWeight: 800 }}>{selectedDecision.council} · {selectedDecision.decisionId}</div>
                  <h3 style={{ margin: '5px 0 0', color: 'white', lineHeight: 1.25 }}>{selectedDecision.context}</h3>
                </div>
                <button onClick={() => setSelected(null)} style={{ border: 'none', background: 'transparent', color: 'rgba(255,255,255,0.72)', cursor: 'pointer' }}><X size={18} /></button>
              </div>

              <div style={{ marginTop: 14, padding: 13, borderRadius: 12, border: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.035)' }}>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.84)' }}><b>Outcome:</b> {normalizeDecisionStatus(selectedDecision.status || selectedDecision.outcome || selectedDecision.decision)}</div>
                <div style={{ marginTop: 7, fontSize: 11, color: 'rgba(255,255,255,0.62)', lineHeight: 1.55 }}>
                  Owner: {selectedDecision.owner || '—'} · Risk: {selectedDecision.risk || '—'} · Revisit: {selectedDecision.revisitDate || '—'} · Updated: {selectedDecision.updatedAt || selectedDecision.createdAt || '—'}
                  {selectedDecision.delegatedTaskState ? ` · Task: ${selectedDecision.delegatedTaskState}` : ''}
                </div>
                {selectedDecision.rationale ? <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.72)', lineHeight: 1.55 }}><b>Rationale:</b> {selectedDecision.rationale}</div> : null}
                {selectedDecision.conditions?.length ? <div style={{ marginTop: 10, fontSize: 11, color: '#FFB340' }}>Conditions: {selectedDecision.conditions.join(' · ')}</div> : null}
                {selectedDecision.quorum ? <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.62)' }}>Quorum: {selectedDecision.quorum.present ?? '—'} / {selectedDecision.quorum.required ?? '—'}</div> : null}
                {selectedDecision.voters?.length ? <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.62)' }}>Voters: {selectedDecision.voters.join(', ')}</div> : null}
                {selectedDecision.modelFamilies?.length ? <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.62)' }}>Models: {selectedDecision.modelFamilies.join(', ')}</div> : null}
                {selectedDecision.evidence?.length ? (
                  <div style={{ marginTop: 10, fontSize: 11, color: 'rgba(255,255,255,0.66)' }}>
                    <b>Evidence</b>
                    <ul style={{ marginTop: 6, paddingLeft: 18 }}>
                      {selectedDecision.evidence.slice(0, 8).map((item, index) => <li key={`${item}-${index}`} style={{ marginBottom: 4 }}>{item}</li>)}
                    </ul>
                  </div>
                ) : null}
              </div>

              <div style={{ marginTop: 16, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', marginBottom: 8, fontWeight: 800 }}>Timeline</div>
                {timeline.length === 0 ? <EmptyState text="No timeline events for this decision." /> : timeline.slice(0, 30).map((event, index) => (
                  <div key={`${event.eventId || index}`} style={{ padding: '9px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.9)', fontWeight: 700 }}>{event.eventType || event.type || 'event'}</div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.48)', marginTop: 2 }}>{event.source || 'unknown'} · {timeAgo(event.timestamp || event.createdAt || '')}</div>
                    {event.payload?.note ? <div style={{ marginTop: 5, fontSize: 11, color: 'rgba(255,255,255,0.70)' }}>{event.payload.note}</div> : null}
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
