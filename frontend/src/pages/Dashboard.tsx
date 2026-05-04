import { type CSSProperties, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Activity,
  ArrowRight,
  BarChart3,
  Bell,
  Calendar,
  CheckCircle,
  Clock,
  Cpu,
  Database,
  Gauge,
  Heart,
  Loader2,
  Mail,
  MessageSquare,
  Radio,
  Search,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import PageTransition from '../components/PageTransition'
import GlassCard from '../components/GlassCard'
import AnimatedCounter from '../components/AnimatedCounter'
import StatusBadge from '../components/StatusBadge'
import styles from './Dashboard.module.css'
import { timeAgo, useApi } from '../lib/hooks'
import { useIsMobile } from '../lib/useIsMobile'
import {
  healthStateBadgeStatus,
  healthStateColor,
  normalizeHealthState,
  type HealthState,
} from '../lib/status'

const feedIcons: Record<string, LucideIcon> = {
  check: CheckCircle,
  search: Search,
  clock: Clock,
  loader: Loader2,
}

const feedColors: Record<string, string> = {
  task_completed: '#30D158',
  task_running: '#0A84FF',
  scout_found: '#FF9F0A',
  scout_deployed: '#64D2FF',
  cron_run: '#A1A1AA',
}

type GovernanceScorecard = {
  overall?: string
  mode?: string
  recommendation?: string
  metrics?: {
    delegationAutorunInfraFailureAttemptsLive24h?: number
    delegatedBlocked?: number
  }
  review?: {
    governanceEventsLive24h?: number
    workflowSurfaceLive24h?: number
    workflowHeartbeatEventsLive24h?: number
    workflowSurfaceSilenceHours?: number | null
    workflowSurfaceGap4dWarn?: boolean
    workflowSignalGapWarn?: boolean
    workflowSurfaceLastSeenAt?: string | null
    workflowSurfaceLastSource?: string | null
  }
}

type Channel = {
  name: string
  detail?: string
  state?: string
}

type AgentStatus = {
  name?: string
  model?: string
  heartbeatInterval?: string
  activeSessions?: number
  totalAgents?: number
  memoryFiles?: number
  memoryChunks?: number
  channels?: Channel[]
}

type HeartbeatStatus = {
  lastHeartbeat?: number
  lastHeartbeatAt?: number
  lastChecks?: unknown
}

type StatusPayload = {
  agent?: AgentStatus
  heartbeat?: HeartbeatStatus
  tokenUsage?: {
    used?: number
  }
}

type ActivityItem = {
  id: string
  title: string
  detail?: string
  icon?: string
  type?: string
  score?: number
  source?: string
  time?: string
  actionUrl?: string
  actionable?: boolean
  actionLabel?: string
}

type ActivityPayload = {
  feed?: ActivityItem[]
}

type SessionItem = {
  isActive?: boolean
  updatedAt?: string
}

type SessionsPayload = {
  count?: number
  sessions?: SessionItem[]
}

type QuickAction = {
  endpoint: string
  title: string
  detail: string
  icon: LucideIcon
  tone: string
}

const quickActions: QuickAction[] = [
  {
    endpoint: '/heartbeat/run',
    title: 'Run Heartbeat',
    detail: 'Mail, calendar, urgent drift',
    icon: Heart,
    tone: '#30D158',
  },
  {
    endpoint: '/quick/emails',
    title: 'Check Mail',
    detail: 'Unread and important',
    icon: Mail,
    tone: '#64D2FF',
  },
  {
    endpoint: '/quick/schedule',
    title: 'Today Plan',
    detail: 'Calendar today and tomorrow',
    icon: Calendar,
    tone: '#FF9F0A',
  },
]

function QuickActionsBar() {
  const [loading, setLoading] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const handleQuickAction = async (action: QuickAction) => {
    if (loading) return

    setLoading(action.endpoint)
    setResult(null)

    try {
      const res = await fetch(`/api${action.endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      const data = await res.json()
      setResult(data.status === 'error' ? `Failed: ${data.error}` : data.reply || 'Action completed')
      setTimeout(() => setResult(null), 10000)
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error'
      setResult(`Failed: ${message}`)
      setTimeout(() => setResult(null), 10000)
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className={styles.actionDock}>
      {quickActions.map((action) => {
        const Icon = action.icon
        const active = loading === action.endpoint
        return (
          <button
            key={action.endpoint}
            onClick={() => handleQuickAction(action)}
            disabled={active}
            className={styles.actionTile}
            style={{ '--action-color': action.tone } as CSSProperties}
          >
            <span className={styles.actionIcon}>
              {active ? <Loader2 size={16} className={styles.spinIcon} /> : <Icon size={16} />}
            </span>
            <span className={styles.actionCopy}>
              <strong>{action.title}</strong>
              <span>{action.detail}</span>
            </span>
          </button>
        )
      })}
      {result && <div className={styles.actionResult}>{result}</div>}
    </div>
  )
}

function buildOperationalHealth(statusData: StatusPayload | undefined, scorecard: GovernanceScorecard | undefined, activeSessions: number, totalSessions: number) {
  const channelErrors = Array.isArray(statusData?.agent?.channels)
    ? statusData.agent.channels.filter((channel) => String(channel?.state || '').toUpperCase() === 'ERROR').length
    : 0
  const lastHeartbeat = Number(statusData?.heartbeat?.lastHeartbeat || 0)
  const heartbeatAgeHours = lastHeartbeat > 0 ? (Date.now() - (lastHeartbeat * 1000)) / (60 * 60 * 1000) : null
  const heartbeatStale = heartbeatAgeHours == null ? true : heartbeatAgeHours > 2
  const workflowLive24h = Number(scorecard?.review?.workflowSurfaceLive24h || 0)
  const governanceLive24h = Number(scorecard?.review?.governanceEventsLive24h || 0)
  const syntheticLive24h = Number(scorecard?.review?.workflowHeartbeatEventsLive24h || 0)
  const infraFailures24h = Number(scorecard?.metrics?.delegationAutorunInfraFailureAttemptsLive24h || 0)
  const delegatedBlocked = Number(scorecard?.metrics?.delegatedBlocked || 0)
  const silenceHours = scorecard?.review?.workflowSurfaceSilenceHours == null
    ? null
    : Number(scorecard.review.workflowSurfaceSilenceHours)
  const workflowGapWarn = Boolean(scorecard?.review?.workflowSurfaceGap4dWarn || scorecard?.review?.workflowSignalGapWarn)

  let state: HealthState = 'green'
  if (!statusData?.agent) state = 'gray'
  else if (channelErrors > 0 || infraFailures24h > 0 || delegatedBlocked > 0) state = 'red'
  else if (activeSessions === 0 && totalSessions === 0 && workflowLive24h === 0 && governanceLive24h === 0 && syntheticLive24h === 0) state = 'gray'
  else if (heartbeatStale || normalizeHealthState(scorecard?.overall, 'green') === 'yellow' || workflowGapWarn || workflowLive24h === 0) state = 'yellow'

  const reasons: string[] = []
  if (state === 'red' && channelErrors > 0) reasons.push(`${channelErrors} live channel error`)
  if (state === 'red' && infraFailures24h > 0) reasons.push(`${infraFailures24h} governance infra failure in 24h`)
  if (state === 'red' && delegatedBlocked > 0) reasons.push(`${delegatedBlocked} delegated decision blocked`)
  if (state !== 'red' && heartbeatStale) reasons.push(`heartbeat stale${heartbeatAgeHours != null ? ` · ${Math.floor(heartbeatAgeHours)}h old` : ''}`)
  if (state !== 'red' && workflowLive24h === 0) reasons.push('no real workflow event in 24h')
  if (state !== 'red' && workflowGapWarn) reasons.push('workflow gap warning active')
  if (reasons.length === 0 && workflowLive24h > 0) reasons.push(`${workflowLive24h} real workflow events in 24h`)
  if (reasons.length === 0 && governanceLive24h > 0) reasons.push(`${governanceLive24h} governance events in 24h`)
  if (reasons.length === 0) reasons.push('waiting for a fresh live signal')

  return {
    state,
    label: state === 'green' ? 'Clear' : state === 'yellow' ? 'Watch' : state === 'red' ? 'Act now' : 'No signal',
    channelErrors,
    infraFailures24h,
    delegatedBlocked,
    workflowLive24h,
    governanceLive24h,
    syntheticLive24h,
    silenceHours,
    lastWorkflowSeenAt: scorecard?.review?.workflowSurfaceLastSeenAt || null,
    lastWorkflowSource: scorecard?.review?.workflowSurfaceLastSource || null,
    reasons: reasons.slice(0, 3),
  }
}

function formatNumber(value: number | undefined) {
  return Number(value || 0).toLocaleString()
}

export default function Dashboard() {
  const m = useIsMobile()
  const navigate = useNavigate()
  const { data, loading } = useApi<StatusPayload>('/api/status', 30000)
  const { data: activityData } = useApi<ActivityPayload>('/api/activity', 10000)
  const { data: sessionsData } = useApi<SessionsPayload>('/api/sessions', 15000)
  const { data: governanceScorecard } = useApi<GovernanceScorecard>('/api/councils/governance/scorecard', 12000)
  const [countdown, setCountdown] = useState('')

  useEffect(() => {
    const heartbeatStatus = data?.heartbeat
    if (!heartbeatStatus?.lastChecks || !(heartbeatStatus.lastHeartbeat || heartbeatStatus.lastHeartbeatAt)) {
      return
    }
    const interval = setInterval(() => {
      const last = heartbeatStatus.lastHeartbeat || heartbeatStatus.lastHeartbeatAt || 0
      const next = last + 3600
      const remaining = next - Date.now() / 1000
      if (remaining <= 0) {
        setCountdown('Overdue')
      } else {
        const mins = Math.floor(remaining / 60)
        const secs = Math.floor(remaining % 60)
        setCountdown(`${mins}m ${secs}s`)
      }
    }, 1000)
    return () => clearInterval(interval)
  }, [data])

  if (loading || !data) {
    return (
      <PageTransition>
        <div className={styles.loadingWrap}>
          <div className={styles.spinner} />
        </div>
      </PageTransition>
    )
  }

  const agent = data.agent || {}
  const heartbeat = data.heartbeat || {}
  const tokenUsage = data.tokenUsage || {}
  const feed = activityData?.feed || []
  const sessions = sessionsData?.sessions || []
  const visibleActiveSessions = sessions.filter((s) => s.isActive).length
  const activeSessions = sessions.length > 0 ? visibleActiveSessions : Number(agent.activeSessions || 0)
  const totalSessions = sessions.length > 0 ? sessions.length : Number(sessionsData?.count || agent.activeSessions || 0)
  const operationalHealth = buildOperationalHealth(data, governanceScorecard || undefined, activeSessions, totalSessions)
  const latestSession = [...sessions].sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime())[0]
  const channels = agent.channels || []
  const channelCount = channels.length
  const okChannelCount = channels.filter((ch) => ch.state === 'OK').length
  const displayName = agent.name === 'Mission Control' ? 'OpenClaw Agent' : agent.name
  const primaryReasons = operationalHealth.reasons.length ? operationalHealth.reasons : ['No live reason available']

  const commandCards = [
    {
      label: 'Active sessions',
      value: activeSessions,
      suffix: `/${totalSessions}`,
      icon: Activity,
      color: '#0A84FF',
      route: '/conversations',
    },
    {
      label: 'Channels OK',
      value: okChannelCount,
      suffix: `/${channelCount}`,
      icon: Radio,
      color: '#30D158',
      route: '/settings',
    },
    {
      label: 'Memory chunks',
      value: agent.memoryChunks || 0,
      suffix: '',
      icon: Database,
      color: '#BF5AF2',
      route: '/memory',
    },
    {
      label: 'Token usage',
      value: Math.round(Number(tokenUsage?.used || 0) / 1000),
      suffix: 'k',
      icon: BarChart3,
      color: '#FF9F0A',
      route: '/costs',
    },
  ]

  const evidenceRows = [
    {
      label: 'Workflow',
      value: operationalHealth.workflowLive24h,
      detail: operationalHealth.lastWorkflowSeenAt
        ? `Last ${timeAgo(operationalHealth.lastWorkflowSeenAt)}`
        : 'No timestamp',
      icon: Workflow,
      color: '#30D158',
    },
    {
      label: 'Governance',
      value: operationalHealth.governanceLive24h,
      detail: 'auto-ops in 24h',
      icon: ShieldCheck,
      color: '#64D2FF',
    },
    {
      label: 'Synthetic',
      value: operationalHealth.syntheticLive24h,
      detail: 'heartbeat-only checks',
      icon: Gauge,
      color: '#A1A1AA',
    },
    {
      label: 'Failures',
      value: operationalHealth.infraFailures24h + operationalHealth.channelErrors + operationalHealth.delegatedBlocked,
      detail: 'live blockers',
      icon: Bell,
      color: operationalHealth.state === 'red' ? '#FF453A' : '#A1A1AA',
    },
  ]

  return (
    <PageTransition>
      <div className={`${styles.page} ${m ? styles.pageMobile : ''}`}>
        <section className={`${styles.commandHero} ${m ? styles.commandHeroMobile : ''}`}>
          <div className={styles.heroMain}>
            <div className={styles.kickerRow}>
              <span className={styles.livePill}>
                <span className={styles.liveDot} />
                Live Mission Control
              </span>
              <span className={styles.modelPill}>{agent.model || 'No model reported'}</span>
            </div>

            <div className={styles.heroTitleBlock}>
              <h1>Operator Briefing</h1>
              <p>
                {displayName} is in <strong style={{ color: healthStateColor(operationalHealth.state) }}>{operationalHealth.label}</strong> state.
                {latestSession ? ` Last session moved ${timeAgo(latestSession.updatedAt || '')}.` : ' No recent session movement is visible.'}
              </p>
            </div>

            <QuickActionsBar />
          </div>

          <div
            className={styles.truthPanel}
            style={{ '--health-color': healthStateColor(operationalHealth.state) } as CSSProperties}
          >
            <div className={styles.truthHeader}>
              <div>
                <p>Current call</p>
                <h2>{operationalHealth.label}</h2>
              </div>
              <StatusBadge
                status={healthStateBadgeStatus(operationalHealth.state)}
                label={operationalHealth.label}
                pulse={operationalHealth.state === 'green'}
              />
            </div>
            <div className={styles.reasonStack}>
              {primaryReasons.map((reason) => (
                <div key={reason} className={styles.reasonItem}>
                  <Zap size={13} />
                  <span>{reason}</span>
                </div>
              ))}
            </div>
            <div className={styles.truthActions}>
              <button onClick={() => navigate('/councils')}>
                Governance Archive <ArrowRight size={13} />
              </button>
              <button onClick={() => navigate('/cron')}>
                Cron <ArrowRight size={13} />
              </button>
            </div>
          </div>
        </section>

        <section className={`${styles.commandGrid} ${m ? styles.commandGridMobile : ''}`}>
          {commandCards.map((stat, index) => (
            <button
              key={stat.label}
              onClick={() => navigate(stat.route)}
              className={styles.commandCard}
              style={{ '--metric-color': stat.color } as CSSProperties}
            >
              <div className={styles.commandCardTop}>
                <span className={styles.metricIcon}>
                  <stat.icon size={15} />
                </span>
                <span className={styles.metricLabel}>{stat.label}</span>
              </div>
              <p className={styles.metricValue}>
                <AnimatedCounter end={stat.value} />
                <span>{stat.suffix}</span>
              </p>
              <span className={styles.metricAction}>
                Inspect <ArrowRight size={12} />
              </span>
              <span className={styles.metricIndex}>{String(index + 1).padStart(2, '0')}</span>
            </button>
          ))}
        </section>

        <section className={`${styles.mainColumns} ${m ? styles.mainColumnsMobile : ''}`}>
          <div className={styles.leftStack}>
            <GlassCard delay={0.1} hover={false} noPad>
              <div className={`${styles.evidencePanel} ${m ? styles.panelMobile : ''}`}>
                <div className={styles.sectionHeader}>
                  <div>
                    <p className={styles.sectionEyebrow}>Evidence</p>
                    <h3 className={styles.sectionTitle}>Signals that explain the call</h3>
                  </div>
                  <button className={styles.ghostButton} onClick={() => navigate('/office')}>
                    Digital Office
                  </button>
                </div>

                <div className={`${styles.evidenceGrid} ${m ? styles.evidenceGridMobile : ''}`}>
                  {evidenceRows.map((row) => (
                    <div key={row.label} className={styles.evidenceRow} style={{ '--row-color': row.color } as CSSProperties}>
                      <div className={styles.evidenceIcon}>
                        <row.icon size={15} />
                      </div>
                      <div>
                        <p>{row.label}</p>
                        <strong>{formatNumber(row.value)}</strong>
                        <span>{row.detail}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </GlassCard>

            <GlassCard delay={0.14} hover={false} noPad>
              <div className={`${styles.activityPanel} ${m ? styles.panelMobile : ''}`}>
                <div className={styles.sectionHeader}>
                  <div>
                    <p className={styles.sectionEyebrow}>Activity</p>
                    <h3 className={styles.sectionTitle}>Latest operator events</h3>
                  </div>
                  <span className={styles.countBadge}>{feed.length} items</span>
                </div>
                <div className={styles.scrollColumn}>
                  {feed.length === 0 ? (
                    <div className={styles.emptyFeed}>
                      <Bell size={28} className={styles.emptyFeedIcon} />
                      <p>No activity yet</p>
                    </div>
                  ) : feed.map((item) => {
                    const Icon = item.icon ? feedIcons[item.icon] || Activity : Activity
                    const color = item.type ? feedColors[item.type] || '#A1A1AA' : '#A1A1AA'
                    const isRunning = item.type === 'task_running'

                    return (
                      <div
                        key={item.id}
                        className={`${styles.feedItem} ${item.actionUrl ? styles.feedItemClickable : ''}`}
                        onClick={() => item.actionUrl && navigate(item.actionUrl)}
                      >
                        <div className={styles.feedIconWrap} style={{ background: `${color}18` }}>
                          <Icon size={14} style={{ color, ...(isRunning ? { animation: 'spin 1s linear infinite' } : {}) }} />
                        </div>

                        <div className={styles.feedContent}>
                          <p className={styles.feedTitle}>{item.title}</p>
                          {item.detail && <p className={styles.feedDetail}>{item.detail}</p>}
                          <div className={styles.feedMetaRow}>
                            {item.score && <span className={styles.feedScore}>{item.score} pts</span>}
                            {item.source && <span className={styles.feedSource}>{item.source}</span>}
                            <span className={styles.feedTime}>{item.time ? timeAgo(item.time) : ''}</span>
                          </div>
                        </div>

                        {item.actionable && (
                          <button
                            onClick={(e) => { e.stopPropagation(); navigate(item.actionUrl || '/workshop') }}
                            className={styles.feedActionButton}
                          >
                            {item.actionUrl?.startsWith('/workshop') ? 'Open Task' : item.actionLabel || 'View'} <ArrowRight size={10} />
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            </GlassCard>
          </div>

          <aside className={styles.rightStack}>
            <GlassCard delay={0.18} hover={false} noPad>
              <div className={`${styles.panelBody} ${m ? styles.panelMobile : ''}`}>
                <div className={styles.sectionHeaderTight}>
                  <h3 className={styles.compactTitle}>
                    <Radio size={14} /> Channels
                  </h3>
                  <span className={styles.countBadge}>{okChannelCount}/{channelCount} OK</span>
                </div>
                {channels.length > 0 ? channels.map((ch) => (
                  <div key={ch.name} className={styles.channelRow}>
                    <div className={styles.channelInfo}>
                      <MessageSquare size={14} className={styles.channelIcon} />
                      <div className={styles.channelText}>
                        <p className={styles.channelName}>{ch.name}</p>
                        {!m && <p className={styles.channelDetail}>{ch.detail}</p>}
                      </div>
                    </div>
                    <StatusBadge status={ch.state === 'OK' ? 'active' : ch.state === 'OFF' ? 'off' : 'error'} />
                  </div>
                )) : <p className={styles.emptyText}>No channels</p>}
              </div>
            </GlassCard>

            <GlassCard delay={0.22} hover={false} noPad>
              <div className={`${styles.panelBody} ${m ? styles.panelMobile : ''}`}>
                <div className={styles.sectionHeaderTight}>
                  <h3 className={styles.compactTitle}>
                    <Heart size={14} /> Heartbeat
                  </h3>
                  <StatusBadge
                    status={!(heartbeat.lastHeartbeat || heartbeat.lastHeartbeatAt) ? 'off' : countdown === 'Overdue' ? 'error' : 'active'}
                    label={!(heartbeat.lastHeartbeat || heartbeat.lastHeartbeatAt) ? 'No timestamp' : countdown === 'Overdue' ? 'Overdue' : 'Scheduled'}
                  />
                </div>
                <div className={styles.heartbeatGrid}>
                  <div>
                    <p>Last</p>
                    <strong>
                      {heartbeat.lastHeartbeat || heartbeat.lastHeartbeatAt
                        ? timeAgo(new Date((heartbeat.lastHeartbeat || heartbeat.lastHeartbeatAt || 0) * 1000).toISOString())
                        : '—'}
                    </strong>
                  </div>
                  <div>
                    <p>Next</p>
                    <strong className={countdown === 'Overdue' ? styles.overdue : ''}>{countdown || '—'}</strong>
                  </div>
                  <div>
                    <p>Interval</p>
                    <strong>{agent.heartbeatInterval}</strong>
                  </div>
                </div>
              </div>
            </GlassCard>

            <GlassCard delay={0.26} hover={false} noPad>
              <div className={`${styles.panelBody} ${m ? styles.panelMobile : ''}`}>
                <div className={styles.systemList}>
                  <div className={styles.systemRow}>
                    <Cpu size={14} />
                    <span>Agent fleet</span>
                    <strong>{agent.totalAgents}</strong>
                  </div>
                  <div className={styles.systemRow}>
                    <Database size={14} />
                    <span>Memory files</span>
                    <strong>{agent.memoryFiles}</strong>
                  </div>
                  <div className={styles.systemRow}>
                    <TerminalSquare size={14} />
                    <span>Model</span>
                    <strong title={agent.model}>{agent.model || '—'}</strong>
                  </div>
                  <div className={styles.systemRow}>
                    <Sparkles size={14} />
                    <span>Usage</span>
                    <strong>{Math.round(Number(tokenUsage?.used || 0) / 1000)}k</strong>
                  </div>
                </div>
              </div>
            </GlassCard>
          </aside>
        </section>
      </div>
    </PageTransition>
  )
}
