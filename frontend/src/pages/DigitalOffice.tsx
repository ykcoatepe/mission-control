import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import PageTransition from '../components/PageTransition'
import { useApi, timeAgo } from '../lib/hooks'
import { useIsMobile } from '../lib/useIsMobile'
import {
  Activity,
  ArrowRight,
  Briefcase,
  Clock3,
  Copy,
  ExternalLink,
  Users,
  Wifi,
  X,
} from 'lucide-react'
import styles from './DigitalOffice.module.css'

interface OfficeTaskPreview {
  id: string
  title: string
  column: 'queue' | 'inProgress' | 'blocked' | 'done'
  priority: string
  status?: string
  tags?: string[]
  executionPath?: 'direct' | 'task-path' | 'automation' | string
  source?: string | null
  updatedAt?: string | null
}

interface OfficeDesk {
  id: string
  name: string
  role?: string
  emoji?: string
  model?: string
  liveState: 'live' | 'warm' | 'idle' | 'offline'
  activeTaskCount: number
  inProgressTaskCount: number
  blockedTaskCount?: number
  sessionCount: number
  lastActivityAt?: string | null
  lastActivityText?: string
  latestSessionKey?: string | null
  dbStatus?: string | null
  memoryHash?: string | null
  pathSummary?: {
    direct: number
    taskPath: number
    automation: number
  }
  lastExecutionPath?: 'direct' | 'task-path' | 'automation' | null
  taskPreview?: OfficeTaskPreview[]
}

interface RankedDesk extends OfficeDesk {
  attentionScore: number
  attentionReason: string
  nextTask: OfficeTaskPreview | null
}

interface OfficeTelemetry {
  generatedAt: string
  summary: {
    agents: number
    live: number
    warm: number
    idle: number
    offline: number
    openTasks: number
  }
  desks: OfficeDesk[]
}

function stateStyle(state: OfficeDesk['liveState']) {
  if (state === 'live') return { label: 'LIVE', color: '#32D74B', bg: 'rgba(50,215,75,0.16)', border: '1px solid rgba(50,215,75,0.35)' }
  if (state === 'warm') return { label: 'WARM', color: '#64D2FF', bg: 'rgba(100,210,255,0.16)', border: '1px solid rgba(100,210,255,0.35)' }
  if (state === 'idle') return { label: 'IDLE', color: '#FF9F0A', bg: 'rgba(255,159,10,0.16)', border: '1px solid rgba(255,159,10,0.35)' }
  return { label: 'OFFLINE', color: '#FF453A', bg: 'rgba(255,69,58,0.16)', border: '1px solid rgba(255,69,58,0.35)' }
}

function taskColumnLabel(column: string) {
  if (column === 'inProgress') return 'Running'
  if (column === 'blocked') return 'Blocked'
  if (column === 'done') return 'Done'
  return 'Queued'
}

function priorityTone(priority: string) {
  if (priority === 'high') return '#FF453A'
  if (priority === 'medium') return '#FF9F0A'
  return '#64D2FF'
}

function pathTone(path?: string | null) {
  if (path === 'direct') return { label: 'Direct', color: '#64D2FF', bg: 'rgba(100,210,255,0.12)', border: '1px solid rgba(100,210,255,0.22)' }
  if (path === 'automation') return { label: 'Automation', color: '#BF5AF2', bg: 'rgba(191,90,242,0.12)', border: '1px solid rgba(191,90,242,0.22)' }
  return { label: 'Task Path', color: '#32D74B', bg: 'rgba(50,215,75,0.12)', border: '1px solid rgba(50,215,75,0.22)' }
}

function attentionTone(score: number) {
  if (score >= 75) return { label: 'Immediate', color: '#FF453A', bg: 'rgba(255,69,58,0.14)', border: '1px solid rgba(255,69,58,0.28)' }
  if (score >= 45) return { label: 'Watch', color: '#FF9F0A', bg: 'rgba(255,159,10,0.14)', border: '1px solid rgba(255,159,10,0.28)' }
  return { label: 'Stable', color: '#64D2FF', bg: 'rgba(100,210,255,0.14)', border: '1px solid rgba(100,210,255,0.28)' }
}

function primaryTask(tasks: OfficeTaskPreview[] = []) {
  if (!tasks.length) return null
  return [...tasks].sort((left, right) => {
    const columnWeight = (value: string) => (value === 'inProgress' ? 4 : value === 'blocked' ? 3 : value === 'queue' ? 2 : 1)
    const priorityWeight = (value: string) => (value === 'high' ? 3 : value === 'medium' ? 2 : 1)
    return columnWeight(right.column) - columnWeight(left.column) || priorityWeight(right.priority) - priorityWeight(left.priority)
  })[0]
}

function deskAttentionScore(desk: OfficeDesk) {
  let score = 0
  const blocked = Number(desk.blockedTaskCount || 0)
  const queued = Math.max(0, Number(desk.activeTaskCount || 0) - blocked)
  const running = Number(desk.inProgressTaskCount || 0)

  if (desk.liveState === 'offline') score += queued || running || blocked ? 48 : 10
  if (desk.liveState === 'warm') score += 28
  if (desk.liveState === 'idle') score += queued || running || blocked ? 22 : 8
  if (desk.liveState === 'live') score += queued > 0 && running === 0 ? 6 : 0

  score += running * 24
  score += blocked * 20
  score += queued * 10
  if (!desk.sessionCount && (queued > 0 || running > 0 || blocked > 0)) score += 14
  if (desk.lastExecutionPath === 'task-path' && desk.liveState !== 'live' && queued > 0) score += 6

  return Math.min(100, score)
}

function deskAttentionReason(desk: OfficeDesk) {
  const blocked = Number(desk.blockedTaskCount || 0)
  const queued = Math.max(0, Number(desk.activeTaskCount || 0) - blocked)
  const running = Number(desk.inProgressTaskCount || 0)

  if (desk.liveState === 'offline' && (queued > 0 || running > 0 || blocked > 0)) return 'Work is open but no live session is attached.'
  if (blocked > 0) return `${blocked} blocked task${blocked === 1 ? '' : 's'} need operator review.`
  if (desk.liveState === 'warm' && running > 0) return 'Running work is attached to a stale session.'
  if (desk.liveState === 'warm') return 'This desk looks stale and is worth checking before new work lands.'
  if (desk.liveState === 'idle' && queued > 0) return 'Queued work is waiting for a human to pick the next move.'
  if (running > 0) return `${running} task${running === 1 ? '' : 's'} are currently in progress.`
  if (queued > 0) return `${queued} queued task${queued === 1 ? '' : 's'} are ready for triage.`
  return 'No immediate operator action required.'
}

function deskActionLabel(desk: RankedDesk) {
  if (desk.nextTask) return `Open ${taskColumnLabel(desk.nextTask.column).toLowerCase()} task`
  if (desk.latestSessionKey) return 'Copy session key'
  return 'Inspect desk'
}

function DrawerContent({
  desk,
  mobile,
  onClose,
  onCopy,
  onOpenTask,
  onOpenAgents,
  onOpenTeam,
}: {
  desk: RankedDesk
  mobile: boolean
  onClose: () => void
  onCopy: (label: string, value: string) => void
  onOpenTask: (taskId: string) => void
  onOpenAgents: () => void
  onOpenTeam: () => void
}) {
  const state = stateStyle(desk.liveState)
  const attention = attentionTone(desk.attentionScore)

  return (
    <div
      className="macos-panel"
      style={{
        borderRadius: 18,
        padding: mobile ? 16 : 18,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        position: mobile ? 'relative' : 'sticky',
        top: mobile ? undefined : 76,
        background: 'linear-gradient(180deg, rgba(18,22,30,0.92), rgba(9,12,18,0.88))',
      }}
    >
      <div className={styles.drawerHeader}>
        <div className={styles.drawerTitleRow}>
          <div className={styles.drawerEmojiBox}>
            {desk.emoji || '🤖'}
          </div>
          <div style={{ minWidth: 0 }}>
            <div className={styles.drawerName}>{desk.name}</div>
            <div className={styles.drawerRole}>{desk.role || desk.id}</div>
          </div>
        </div>
        {mobile ? (
          <button
            type="button"
            onClick={onClose}
            className={styles.drawerCloseBtn}
          >
            <X size={16} />
          </button>
        ) : null}
      </div>

      <div className={styles.drawerBadgeRow}>
        <span className={styles.drawerBadge} style={{ color: state.color, background: state.bg, border: state.border }}>{state.label}</span>
        <span className={styles.drawerBadge} style={{ color: attention.color, background: attention.bg, border: attention.border }}>
          {attention.label}
        </span>
      </div>

      <div>
        <div className={styles.drawerNextAction}>Next action</div>
        <div className={`${styles.drawerActionGrid} ${mobile ? styles.drawerActionGridMobile : styles.drawerActionGridDesktop}`}>
          {desk.nextTask ? (
            <button
              type="button"
              onClick={() => onOpenTask(desk.nextTask!.id)}
              className={styles.drawerOpenTaskBtn}
              style={{ gridColumn: mobile ? undefined : 'span 2' }}
            >
              Open blocked task
              <ExternalLink size={14} />
            </button>
          ) : null}

          <button
            type="button"
            onClick={onOpenAgents}
            className={styles.drawerNavBtn}
          >
            Open Agent Hub
            <ArrowRight size={14} />
          </button>

          <button
            type="button"
            onClick={onOpenTeam}
            className={styles.drawerNavBtn}
          >
            Open Team Structure
            <ArrowRight size={14} />
          </button>

          <button
            type="button"
            onClick={() => onCopy('Desk ID', desk.id)}
            className={styles.drawerCopyBtn}
          >
            Copy desk ID
            <Copy size={14} />
          </button>

          {desk.latestSessionKey ? (
            <button
              type="button"
              onClick={() => onCopy('Session key', desk.latestSessionKey!)}
              className={styles.drawerCopyBtn}
              style={{ gridColumn: mobile ? undefined : 'span 2' }}
            >
              Copy latest session key
              <Copy size={14} />
            </button>
          ) : null}
        </div>
      </div>

      <div className={styles.drawerWhyBox}>
        <div className={styles.drawerWhyInner}>
          <div>
            <div className={styles.drawerWhyTitle}>Why now</div>
            <div className={styles.drawerWhyText}>{desk.attentionReason}</div>
          </div>
          <div className={styles.drawerUrgencyBox} style={{ background: attention.bg, border: attention.border }}>
            <div className={styles.drawerUrgencyLabel} style={{ color: attention.color }}>Urgency</div>
            <div className={styles.drawerUrgencyValue}>{desk.attentionScore}</div>
          </div>
        </div>
        <div className={styles.drawerKpiGrid}>
          {[
            { label: 'Open', value: desk.activeTaskCount },
            { label: 'Running', value: desk.inProgressTaskCount },
            { label: 'Blocked', value: desk.blockedTaskCount || 0 },
          ].map((item) => (
            <div key={item.label} className={styles.drawerKpiItem}>
              <div className={styles.drawerKpiLabel}>{item.label}</div>
              <div className={styles.drawerKpiValue}>{item.value}</div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <div className={styles.drawerTaskPreviewTitle}>Task preview</div>
        <div className={styles.drawerTaskList}>
          {desk.taskPreview?.length ? desk.taskPreview.map((task) => (
            <div key={task.id} className={styles.drawerTaskItem}>
              <div className={styles.drawerTaskTop}>
                <div style={{ minWidth: 0 }}>
                  <div className={styles.drawerTaskTitle}>{task.title}</div>
                  <div className={styles.drawerTaskTagRow}>
                    <span style={{ fontSize: 10, color: priorityTone(task.priority), background: 'rgba(255,255,255,0.04)', borderRadius: 999, padding: '3px 8px' }}>
                      {task.priority || 'medium'}
                    </span>
                    <span className={styles.drawerTaskColumnBadge}>
                      {taskColumnLabel(task.column)}
                    </span>
                    {task.executionPath ? (
                      <span className={styles.drawerTaskPathBadge} style={{ color: pathTone(task.executionPath).color, background: pathTone(task.executionPath).bg, border: pathTone(task.executionPath).border }}>
                        {pathTone(task.executionPath).label}
                      </span>
                    ) : null}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onOpenTask(task.id)}
                  className={styles.drawerTaskOpenBtn}
                >
                  Open
                  <ExternalLink size={13} />
                </button>
              </div>
              <div className={styles.drawerTaskTimestamp}>
                {task.updatedAt ? `Updated ${timeAgo(task.updatedAt)}` : 'No timestamp'}
                {task.source ? ` · ${task.source}` : ''}
              </div>
            </div>
          )) : (
            <div className={styles.drawerTaskEmpty}>
              No task preview is attached to this desk yet.
            </div>
          )}
        </div>
      </div>

      <div className={styles.drawerMeta}>
        <div>Last activity: {desk.lastActivityAt ? timeAgo(desk.lastActivityAt) : (desk.lastActivityText || 'no signal')}</div>
        {desk.model ? <div>Model: {desk.model}</div> : null}
        {desk.dbStatus ? <div>Runtime status: {desk.dbStatus}</div> : null}
      </div>
    </div>
  )
}

export default function DigitalOffice() {
  const m = useIsMobile()
  const navigate = useNavigate()
  const { data, loading } = useApi<OfficeTelemetry>('/api/office/telemetry', 4000)
  const [selectedDeskId, setSelectedDeskId] = useState<string | null>(null)
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const detailPanelRef = useRef<HTMLDivElement | null>(null)

  const desks = useMemo<RankedDesk[]>(() => {
    const rawDesks = Array.isArray(data?.desks) ? data.desks : []
    return rawDesks
      .map((desk) => {
        const nextTask = primaryTask(desk.taskPreview || [])
        return {
          ...desk,
          attentionScore: deskAttentionScore(desk),
          attentionReason: deskAttentionReason(desk),
          nextTask,
        }
      })
      .sort((left, right) => right.attentionScore - left.attentionScore || right.inProgressTaskCount - left.inProgressTaskCount || right.activeTaskCount - left.activeTaskCount)
  }, [data])

  // Derive selectedDeskId during render (React "storing info from previous renders"
  // pattern) to avoid setState-in-effect.
  const computedDeskId: string | null = !desks.length
    ? null
    : (selectedDeskId && desks.some((desk) => desk.id === selectedDeskId)
      ? selectedDeskId
      : desks[0].id)
  if (computedDeskId !== selectedDeskId) {
    setSelectedDeskId(computedDeskId)
    if (!computedDeskId) setMobileDrawerOpen(false)
  }

  useEffect(() => {
    if (!toast) return undefined
    const timer = window.setTimeout(() => setToast(null), 2200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const selectedDesk = desks.find((desk) => desk.id === selectedDeskId) || null
  const uncoveredDesks = desks.filter((desk) => desk.liveState !== 'live' && (desk.activeTaskCount > 0 || desk.inProgressTaskCount > 0))
  const needsAttention = desks.filter((desk) => desk.attentionScore >= 45)
  const hotDesks = desks.filter((desk) => desk.attentionScore >= 75)
  const executionMix = desks.reduce(
    (acc, desk) => {
      acc.taskPath += desk.pathSummary?.taskPath || 0
      acc.direct += desk.pathSummary?.direct || 0
      acc.automation += desk.pathSummary?.automation || 0
      return acc
    },
    { taskPath: 0, direct: 0, automation: 0 },
  )

  const openDesk = (deskId: string) => {
    setSelectedDeskId(deskId)
    const desk = desks.find((item) => item.id === deskId)
    setToast({ type: 'success', text: desk ? `Showing ${desk.name} details` : 'Desk details opened' })
    if (m) {
      setMobileDrawerOpen(true)
      return
    }
    window.requestAnimationFrame(() => {
      detailPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    })
  }

  const handleCopy = async (label: string, value: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable')
      await navigator.clipboard.writeText(value)
      setToast({ type: 'success', text: `${label} copied` })
    } catch {
      setToast({ type: 'error', text: `${label} copy failed` })
    }
  }

  const openTask = (taskId: string) => {
    navigate(`/workshop?task=${encodeURIComponent(taskId)}`)
  }

  if (loading || !data) {
    return (
      <PageTransition>
        <div className={styles.loadingWrap}>
          <div className={styles.spinner} />
        </div>
      </PageTransition>
    )
  }

  return (
    <PageTransition>
      <div className={`office-page ${styles.page}`}>
        <div className={`${styles.headerRow} ${m ? styles.headerRowMobile : ''}`}>
          <div>
            <h1 className="text-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Users size={m ? 18 : 22} className={styles.headerTitleIcon} /> Digital Office
            </h1>
            <p className={`text-body ${styles.headerSubtitle}`}>Operator console for triage, drilldown, and safe next actions.</p>
          </div>
          <div className={styles.headerTimestamp}>
            <Clock3 size={13} /> Updated {timeAgo(data.generatedAt)}
          </div>
        </div>

        {toast ? (
          <div className={`macos-panel ${toast.type === 'success' ? styles.toastSuccess : styles.toastError}`}>
            {toast.text}
          </div>
        ) : null}

        <div className={`${styles.summaryGrid} ${m ? styles.summaryGridMobile : styles.summaryGridDesktop}`}>
          <div
            className={`macos-panel office-summary-panel ${styles.priorityPanel}`}
            style={{
              background: hotDesks.length
                ? 'linear-gradient(135deg, rgba(255,69,58,0.14), rgba(18,22,30,0.86))'
                : 'linear-gradient(135deg, rgba(100,210,255,0.10), rgba(18,22,30,0.86))',
            }}
          >
            <div className={styles.priorityPanelHeader}>
              <div>
                <div className={styles.priorityLabel} style={{ color: hotDesks.length ? '#FF453A' : '#64D2FF' }}>Priority lane</div>
                <div className={styles.priorityDesc}>What needs a human first.</div>
              </div>
              <Activity size={18} style={{ color: hotDesks.length ? '#FF453A' : '#64D2FF' }} />
            </div>
            <div className={styles.priorityKpiGrid}>
              {[
                { label: 'Immediate desks', value: hotDesks.length, color: hotDesks.length ? '#FF453A' : '#64D2FF' },
                { label: 'Need attention', value: needsAttention.length, color: needsAttention.length ? '#FF9F0A' : '#64D2FF' },
                { label: 'Uncovered work', value: uncoveredDesks.length, color: uncoveredDesks.length ? '#FF9F0A' : '#32D74B' },
              ].map((item) => (
                <div key={item.label} className={styles.kpiItem}>
                  <div className={styles.kpiItemLabel}>{item.label}</div>
                  <div className={styles.kpiItemValue} style={{ color: item.color }}>{item.value}</div>
                </div>
              ))}
            </div>
          </div>

          <div className={`macos-panel office-summary-panel ${styles.snapshotPanel}`}>
            <div className={styles.snapshotTitle}>System snapshot</div>
            <div className={styles.snapshotKpiGrid}>
              {[
                { label: 'Desks', value: data.summary.agents, icon: Users, color: '#64D2FF' },
                { label: 'Live', value: data.summary.live, icon: Wifi, color: data.summary.live ? '#32D74B' : '#FF9F0A' },
                { label: 'Open tasks', value: data.summary.openTasks, icon: Briefcase, color: '#BF5AF2' },
              ].map((item) => (
                <div key={item.label} className={styles.snapshotKpiItem}>
                  <div className={styles.snapshotKpiItemHeader}>
                    <span className={styles.snapshotKpiItemLabel}>{item.label}</span>
                    <item.icon size={12} style={{ color: item.color }} />
                  </div>
                  <div className={styles.snapshotKpiItemValue}>{item.value}</div>
                </div>
              ))}
            </div>
            <div className={styles.snapshotMix}>
              <span>Task Path {executionMix.taskPath}</span>
              <span>· Direct {executionMix.direct}</span>
              <span>· Automation {executionMix.automation}</span>
            </div>
          </div>
        </div>

        <div className={`${styles.contentGrid} ${m ? styles.contentGridMobile : styles.contentGridDesktop}`}>
          <div className={styles.leftCol}>
            <div className={`macos-panel ${styles.queuePanel}`}>
              <div className={styles.queuePanelHeader}>
                <div>
                  <div className={styles.queuePanelTitle}>Attention queue</div>
                  <div className={styles.queuePanelDesc}>
                    Highest-value intervention first. Drill into a desk or jump straight to the relevant task.
                  </div>
                </div>
                <span style={{
                  fontSize: 10, fontWeight: 700,
                  color: hotDesks.length ? '#FF453A' : '#64D2FF',
                  background: hotDesks.length ? 'rgba(255,69,58,0.12)' : 'rgba(100,210,255,0.12)',
                  border: hotDesks.length ? '1px solid rgba(255,69,58,0.28)' : '1px solid rgba(100,210,255,0.24)',
                  borderRadius: 999, padding: '4px 10px',
                }}>
                  {hotDesks.length ? `${hotDesks.length} immediate desk${hotDesks.length === 1 ? '' : 's'}` : 'No hot desks'}
                </span>
              </div>

              <div className={styles.queueList}>
                {desks.map((desk) => {
                  const attention = attentionTone(desk.attentionScore)
                  const state = stateStyle(desk.liveState)
                  return (
                    <div
                      key={desk.id}
                      className={selectedDeskId === desk.id ? styles.deskRowSelected : styles.deskRowDefault}
                    >
                      <div className={styles.deskRowTop}>
                        <div className={styles.deskRowLeft}>
                          <div className={styles.deskEmoji}>
                            {desk.emoji || '🤖'}
                          </div>
                          <div className={styles.deskInfo}>
                            <div className={styles.deskNameRow}>
                              <div className={styles.deskName}>{desk.name}</div>
                              <span style={{ fontSize: 10, fontWeight: 700, color: state.color, background: state.bg, border: state.border, borderRadius: 999, padding: '3px 8px' }}>{state.label}</span>
                            </div>
                            <div className={styles.deskRole}>{desk.role || desk.id}</div>
                            <div className={styles.deskReason}>{desk.attentionReason}</div>
                          </div>
                        </div>
                        <div className={styles.deskRight}>
                          <div className={styles.urgencyBox} style={{ background: attention.bg, border: attention.border }}>
                            <div className={styles.urgencyLabel} style={{ color: attention.color }}>Urgency</div>
                            <div className={styles.urgencyValue}>{desk.attentionScore}</div>
                          </div>
                          <button
                            type="button"
                            onClick={() => openDesk(desk.id)}
                            className={styles.deskDetailsBtn}
                          >
                            Details
                            <ArrowRight size={13} />
                          </button>
                        </div>
                      </div>

                      <div className={styles.deskBottom}>
                        <div className={styles.deskStats}>
                          <span>Open {desk.activeTaskCount}</span>
                          <span>Running {desk.inProgressTaskCount}</span>
                          <span>Blocked {desk.blockedTaskCount || 0}</span>
                          <span>Sessions {desk.sessionCount}</span>
                        </div>
                        <div className={styles.deskActions}>
                          {desk.nextTask ? (
                            <button
                              type="button"
                              onClick={() => openTask(desk.nextTask!.id)}
                              className={styles.deskOpenTaskBtn}
                            >
                              {deskActionLabel(desk)}
                              <ExternalLink size={13} />
                            </button>
                          ) : desk.latestSessionKey ? (
                            <button
                              type="button"
                              onClick={() => handleCopy('Session key', desk.latestSessionKey!)}
                              className={styles.deskCopyBtn}
                            >
                              Copy session key
                              <Copy size={13} />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className={`macos-panel ${styles.floorPanel}`}>
              <div className={styles.floorTitle}>Desk floor</div>
              <div className={styles.floorDesc}>
                Compact view of every desk. Use this when you want a full scan, not just the ranked queue.
              </div>
              <div className={`${styles.floorGrid} ${m ? styles.floorGridMobile : styles.floorGridDesktop}`}>
                {desks.map((desk) => {
                  const state = stateStyle(desk.liveState)
                  const attention = attentionTone(desk.attentionScore)
                  return (
                    <button
                      key={`floor-${desk.id}`}
                      type="button"
                      onClick={() => openDesk(desk.id)}
                      className={`macos-panel ${selectedDeskId === desk.id ? styles.floorCardSelected : styles.floorCardDefault}`}
                    >
                      <div className={styles.floorCardTop}>
                        <div className={styles.floorCardNameRow}>
                          <span className={styles.floorCardEmoji}>{desk.emoji || '🤖'}</span>
                          <div style={{ minWidth: 0 }}>
                            <div className={styles.floorCardName}>{desk.name}</div>
                            <div className={styles.floorCardRole}>{desk.role || desk.id}</div>
                          </div>
                        </div>
                        <span style={{ fontSize: 10, fontWeight: 700, color: attention.color }}>{desk.attentionScore}</span>
                      </div>
                      <div className={styles.floorCardTags}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: state.color, background: state.bg, border: state.border, borderRadius: 999, padding: '3px 8px' }}>{state.label}</span>
                        <span className={styles.floorCardOpenCount}>Open {desk.activeTaskCount}</span>
                        <span className={styles.floorCardBlockedCount}>Blocked {desk.blockedTaskCount || 0}</span>
                      </div>
                      <div className={styles.floorCardReason}>
                        {desk.nextTask ? desk.nextTask.title : desk.attentionReason}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {!m && selectedDesk ? (
            <div ref={detailPanelRef}>
              <DrawerContent
                desk={selectedDesk}
                mobile={false}
                onClose={() => undefined}
                onCopy={handleCopy}
                onOpenTask={openTask}
                onOpenAgents={() => navigate('/agents')}
                onOpenTeam={() => navigate('/team')}
              />
            </div>
          ) : null}
        </div>

        {m && mobileDrawerOpen && selectedDesk ? (
          <div
            className={styles.mobileBackdrop}
            onClick={() => setMobileDrawerOpen(false)}
          >
            <div className={styles.mobileDrawerWrap} onClick={(event) => event.stopPropagation()}>
              <DrawerContent
                desk={selectedDesk}
                mobile
                onClose={() => setMobileDrawerOpen(false)}
                onCopy={handleCopy}
                onOpenTask={openTask}
                onOpenAgents={() => {
                  setMobileDrawerOpen(false)
                  navigate('/agents')
                }}
                onOpenTeam={() => {
                  setMobileDrawerOpen(false)
                  navigate('/team')
                }}
              />
            </div>
          </div>
        ) : null}
      </div>
    </PageTransition>
  )
}
