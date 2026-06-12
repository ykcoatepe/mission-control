import { useState } from 'react'
import { motion } from 'framer-motion'
import { Radar, SortDesc, X, Rocket, Shield, Code, Briefcase, GraduationCap, DollarSign, Search } from 'lucide-react'
import PageTransition from '../components/PageTransition'
import { useIsMobile } from '../lib/useIsMobile'
import GlassCard from '../components/GlassCard'
import { useApi, timeAgo } from '../lib/hooks'
import styles from './Scout.module.css'

const scoreColor = (score: number) => {
  if (score >= 85) return '#32D74B'
  if (score >= 70) return '#007AFF'
  if (score >= 50) return '#FF9500'
  return '#8E8E93'
}

const getFreshnessInfo = (foundDate: string) => {
  const now = new Date()
  const found = new Date(foundDate)
  const hours = (now.getTime() - found.getTime()) / (1000 * 60 * 60)
  
  if (hours < 4) {
    return { badge: '🟢 Fresh', color: '#32D74B' }
  } else if (hours > 24) {
    const days = Math.floor(hours / 24)
    return { badge: `🕐 ${days}d old`, color: 'rgba(255,255,255,0.3)' }
  }
  return null
}

interface Opportunity {
  id: string
  title?: string
  summary?: string
  source?: string
  category?: string
  status?: string
  score: number
  found: string
  url?: string
}

interface CronJob {
  name?: string
  description?: string
  nextRun?: string
  schedule?: string
}

const getNextScanTime = (cronJobs: CronJob[]) => {
  const scoutJob = cronJobs?.find(job => 
    job.name?.toLowerCase().includes('scout') || 
    job.description?.toLowerCase().includes('scout')
  )
  
  if (scoutJob?.nextRun) {
    const nextRun = new Date(scoutJob.nextRun)
    const now = new Date()
    const hours = Math.ceil((nextRun.getTime() - now.getTime()) / (1000 * 60 * 60))
    
    if (hours < 1) return 'Next scan: soon'
    if (hours < 24) return `Next scan: in ${hours}h`
    if (scoutJob.schedule?.includes('daily')) return 'Next scan: daily at 12:00 UTC'
    return 'Next scan: scheduled'
  }
  return null
}

const FILTERS = [
  { id: 'all', label: 'All', icon: Radar },
  { id: 'openclaw', label: 'OpenClaw', icon: Code, match: (o: Opportunity) => Boolean(o.category?.startsWith('openclaw')) },
  { id: 'bounty', label: 'Bounty', icon: Shield, match: (o: Opportunity) => o.category === 'bounty' },
  { id: 'freelance', label: 'Freelance', icon: Briefcase, match: (o: Opportunity) => ['freelance', 'twitter-jobs', 'linkedin-jobs', 'reddit-gigs', 'upwork'].includes(o.category || '') },
  { id: 'edtech', label: 'EdTech', icon: GraduationCap, match: (o: Opportunity) => o.category === 'edtech' },
  { id: 'funding', label: 'Grants', icon: DollarSign, match: (o: Opportunity) => ['funding', 'swedish-grants'].includes(o.category || '') },
]

export default function Scout() {
  const m = useIsMobile()
  const { data, loading } = useApi<{ opportunities?: Opportunity[]; lastScan?: string }>('/api/scout', 60000)
  const { data: cronData } = useApi<{ jobs?: CronJob[] }>('/api/cron', 30000) // Add cron data for next scan time
  const [sortBy, setSortBy] = useState<'score' | 'date'>('score')
  const [filter, setFilter] = useState('all')
  const [scanning, setScanning] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  if (loading || !data) {
    return (
      <PageTransition>
        <div className={styles.loadingWrap}>
          <div className={styles.spinner} />
        </div>
      </PageTransition>
    )
  }

  const activeFilter = FILTERS.find(f => f.id === filter)
  const allOpportunities = [...(data.opportunities || [])].sort((a, b) => {
    if (sortBy === 'score') return b.score - a.score
    return new Date(b.found).getTime() - new Date(a.found).getTime()
  })
  const opportunities = filter === 'all' ? allOpportunities : allOpportunities.filter(activeFilter?.match || (() => true))

  const counts: Record<string, number> = {}
  for (const f of FILTERS) {
    counts[f.id] = f.id === 'all' ? allOpportunities.length : allOpportunities.filter(f.match || (() => true)).length
  }

  const handleDeploy = async (oppId: string) => {
    try {
      await fetch('/api/scout/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opportunityId: oppId }) })
      window.location.reload()
    } catch { /* request failed; list stays as-is */ }
  }

  const handleDismiss = async (oppId: string) => {
    try {
      await fetch('/api/scout/dismiss', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ opportunityId: oppId }) })
      window.location.reload()
    } catch { /* request failed; list stays as-is */ }
  }

  const handleRunScan = async () => {
    try {
      setScanning(true)
      setToast(null)
      const response = await fetch('/api/scout/scan', { method: 'POST' })
      const result = await response.json()
      
      if (result.status === 'scanning') {
        // Poll for completion
        const checkStatus = async () => {
          try {
            const statusResponse = await fetch('/api/scout/status')
            const status = await statusResponse.json()
            
            if (!status.scanning) {
              setScanning(false)
              setToast('✅ Scan completed! Results refreshed.')
              setTimeout(() => setToast(null), 4000)
              window.location.reload() // Reload to show new results
            } else {
              setTimeout(checkStatus, 3000) // Check again in 3 seconds
            }
          } catch {
            setScanning(false)
            setToast('❌ Scan status check failed')
            setTimeout(() => setToast(null), 4000)
          }
        }
        setTimeout(checkStatus, 3000)
      } else {
        setScanning(false)
      }
    } catch {
      setScanning(false)
      setToast('❌ Failed to start scan')
      setTimeout(() => setToast(null), 4000)
    }
  }

  return (
    <PageTransition>
      <div className={`${styles.page} ${m ? styles.pageMobile : styles.pageDesktop}`}>
        {/* Toast notification */}
        {toast && (
          <div
            className={styles.toast}
            style={{ background: toast.startsWith('✅') ? 'rgba(50,215,75,0.9)' : 'rgba(255,69,58,0.9)' }}
          >
            {toast}
          </div>
        )}

        {/* Header */}
        <div className={styles.headerRow}>
          <div>
            <h1 className={`text-title ${styles.pageTitle}`}>
              <Radar size={m ? 18 : 22} className={styles.pageTitleIcon} /> Scout
            </h1>
            <p className={`text-body ${styles.pageSubtitle} ${m ? styles.pageSubtitleMobile : styles.pageSubtitleDesktop}`}>
              Find opportunities across the web — skills, jobs, grants & more
            </p>
            <div className={`${styles.scanMeta} ${m ? styles.scanMetaMobile : styles.scanMetaDesktop}`}>
              <span>Last scan: {data?.lastScan ? timeAgo(data.lastScan) : 'never'}</span>
              {cronData?.jobs && getNextScanTime(cronData.jobs) && (
                <>
                  <span className={styles.scanMetaDot}>•</span>
                  <span>{getNextScanTime(cronData.jobs)}</span>
                </>
              )}
            </div>
          </div>
          <div className={styles.headerActions}>
            <button
              onClick={handleRunScan}
              disabled={scanning}
              className={`macos-button ${styles.runScanBtn}`}
              style={{
                backgroundColor: scanning ? 'rgba(255,255,255,0.05)' : 'rgba(0,122,255,0.15)',
                borderColor: scanning ? 'rgba(255,255,255,0.1)' : 'rgba(0,122,255,0.4)',
                color: scanning ? 'rgba(255,255,255,0.5)' : '#007AFF',
                cursor: scanning ? 'not-allowed' : 'pointer',
              }}
            >
              <Search size={13} style={{ animation: scanning ? 'spin 1s linear infinite' : 'none' }} />
              {scanning ? 'Scanning...' : 'Run Scan'}
            </button>
            <button
              onClick={() => setSortBy(sortBy === 'score' ? 'date' : 'score')}
              className={`macos-button ${styles.sortBtn}`}
            >
              <SortDesc size={13} />
              {sortBy === 'score' ? 'Score' : 'Date'}
            </button>
          </div>
        </div>

        {/* Filter Tabs — horizontal scroll on mobile */}
        <div className={styles.filterTabs}>
          {FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`${styles.filterTab} ${m ? styles.filterTabMobile : styles.filterTabDesktop}`}
              style={{
                border: filter === f.id ? '1px solid rgba(0,122,255,0.4)' : '1px solid rgba(255,255,255,0.08)',
                background: filter === f.id ? 'rgba(0,122,255,0.15)' : 'rgba(255,255,255,0.04)',
                color: filter === f.id ? '#fff' : 'rgba(255,255,255,0.55)',
              }}
            >
              <f.icon size={m ? 12 : 14} />
              {f.label}
              <span
                className={styles.filterTabCount}
                style={{
                  background: filter === f.id ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.06)',
                  color: filter === f.id ? '#fff' : 'rgba(255,255,255,0.4)',
                }}
              >
                {counts[f.id]}
              </span>
            </button>
          ))}
        </div>

        {/* Stats Row */}
        <div className={styles.statsGrid} style={{ gap: m ? 8 : 16 }}>
          {[
            { label: 'Showing', value: opportunities.length, color: '#fff' },
            { label: 'High (85+)', value: opportunities.filter((o) => o.score >= 85).length, color: '#32D74B' },
            { label: 'Deployed', value: opportunities.filter((o) => o.status === 'deployed').length, color: '#007AFF' },
            { label: 'Avg Score', value: opportunities.length ? Math.round(opportunities.reduce((a, o) => a + o.score, 0) / opportunities.length) : 0, color: '#FF9500' },
          ].map((s, i) => (
            <GlassCard key={s.label} delay={0.05 + i * 0.03} noPad>
              <div className={m ? styles.statCardMobile : styles.statCardDesktop}>
                <p className={styles.statLabel}>{s.label}</p>
                <p className={`${styles.statValue} ${m ? styles.statValueMobile : styles.statValueDesktop}`} style={{ color: s.color }}>{s.value}</p>
              </div>
            </GlassCard>
          ))}
        </div>

        {/* Opportunity List */}
        <div className={styles.oppList}>
          {opportunities.length === 0 ? (
            <div className={`macos-panel ${m ? styles.emptyStateMobile : styles.emptyStateDesktop}`}>
              <div className={styles.emptyStateIcon}>
                <Radar size={28} className={styles.emptyStateRadar} />
              </div>
              <div>
                <h3 className={`${styles.emptyStateTitle} ${m ? styles.emptyStateTitleMobile : styles.emptyStateTitleDesktop}`}>
                  No results yet
                </h3>
                <p className={`${styles.emptyStateBody} ${m ? styles.emptyStateBodyMobile : styles.emptyStateBodyDesktop}`}>
                  {data?.lastScan
                    ? (filter === 'all'
                        ? 'No opportunities found yet — run your first scan!'
                        : 'No results in this category. Try "All" or run a new scan.')
                    : 'Run your first scan to discover opportunities!'
                  }
                </p>
              </div>
              {!data?.lastScan && (
                <button
                  onClick={handleRunScan}
                  disabled={scanning}
                  className={styles.firstScanBtn}
                  style={{
                    background: scanning ? 'rgba(0,122,255,0.5)' : '#007AFF',
                    cursor: scanning ? 'not-allowed' : 'pointer',
                  }}
                >
                  <Search size={16} style={{ animation: scanning ? 'spin 1s linear infinite' : 'none' }} />
                  {scanning ? 'Scanning...' : 'Run First Scan'}
                </button>
              )}
            </div>
          ) : (
            opportunities.map((opp, i) => (
              <motion.div
                key={opp.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.05 + i * 0.02 }}
                className="macos-panel"
                style={{ padding: m ? 14 : '18px 22px', opacity: opp.status === 'dismissed' ? 0.4 : 1 }}
              >
                {/* Mobile: vertical layout */}
                {m ? (
                  <div>
                    <div className={styles.oppMobileRow}>
                      {/* Score badge */}
                      <div
                        className={styles.scoreBadgeMobile}
                        style={{ background: `${scoreColor(opp.score)}20`, border: `1px solid ${scoreColor(opp.score)}40` }}
                      >
                        <span className={styles.scoreTextMobile} style={{ color: scoreColor(opp.score) }}>{opp.score}</span>
                      </div>
                      <div className={styles.oppMobileInfo}>
                        <h3 className={styles.oppTitle}>
                          {opp.url ? <a href={opp.url} target="_blank" rel="noopener" onClick={e => e.stopPropagation()} className={styles.oppTitleLink} onMouseEnter={e => e.currentTarget.style.textDecoration = 'underline'} onMouseLeave={e => e.currentTarget.style.textDecoration = 'none'}>{opp.title}</a> : opp.title}
                        </h3>
                        <div className={styles.oppBadges}>
                          <span className="macos-badge" style={{ fontSize: 10 }}>{opp.source}</span>
                          <span className="macos-badge" style={{ fontSize: 10 }}>{opp.category}</span>
                          {getFreshnessInfo(opp.found) && (
                            <span className={styles.freshnessChip} style={{ color: getFreshnessInfo(opp.found)?.color }}>
                              {getFreshnessInfo(opp.found)?.badge}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <p className={styles.oppSummaryMobile}>
                      {opp.summary}
                    </p>
                    {/* Actions — full width on mobile */}
                    {opp.status === 'new' && (
                      <div className={styles.mobileActions} onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => handleDeploy(opp.id)} className={styles.deployBtnMobile}>
                          <Rocket size={13} /> Deploy
                        </button>
                        <button onClick={() => handleDismiss(opp.id)} className={styles.dismissBtnMobile}>
                          <X size={14} />
                        </button>
                      </div>
                    )}
                    {opp.status === 'deployed' && (
                      <span className={styles.deployedLabelMobile}>✓ In Workshop</span>
                    )}
                  </div>
                ) : (
                  /* Desktop: horizontal layout */
                  <div className={styles.oppDesktopRow}>
                    <div
                      className={styles.scoreBadgeDesktop}
                      style={{ background: `${scoreColor(opp.score)}20`, border: `1px solid ${scoreColor(opp.score)}40` }}
                    >
                      <span className={styles.scoreTextDesktop} style={{ color: scoreColor(opp.score) }}>{opp.score}</span>
                    </div>
                    <div className={styles.oppDesktopInfo}>
                      <div className={styles.oppTitleRow}>
                        <h3 className={styles.oppTitleDesktop}>
                          {opp.title}
                        </h3>
                        <span className="macos-badge" style={{ fontSize: 10, flexShrink: 0 }}>{opp.status}</span>
                      </div>
                      <p className={styles.oppSummaryDesktop}>
                        {opp.summary}
                      </p>
                      <div className={styles.oppMeta}>
                        <span className="macos-badge" style={{ fontSize: 10 }}>{opp.source}</span>
                        <span className="macos-badge" style={{ fontSize: 10 }}>{opp.category}</span>
                        {getFreshnessInfo(opp.found) && (
                          <span className={styles.freshnessChip} style={{ color: getFreshnessInfo(opp.found)?.color }}>
                            {getFreshnessInfo(opp.found)?.badge}
                          </span>
                        )}
                        <span className={styles.timeAgo}>{timeAgo(opp.found)}</span>
                      </div>
                    </div>
                    <div className={styles.desktopActions} onClick={(e) => e.stopPropagation()}>
                      {opp.status === 'new' && (
                        <>
                          <button onClick={() => handleDeploy(opp.id)} className={styles.deployBtnDesktop}>
                            <Rocket size={12} /> Deploy
                          </button>
                          <button onClick={() => handleDismiss(opp.id)} className={`macos-button ${styles.dismissBtnDesktop}`}>
                            <X size={12} />
                          </button>
                        </>
                      )}
                      {opp.status === 'deployed' && <span className={styles.deployedLabelDesktop}>✓ In Workshop</span>}
                    </div>
                  </div>
                )}
              </motion.div>
            ))
          )}
        </div>
      </div>
    </PageTransition>
  )
}
