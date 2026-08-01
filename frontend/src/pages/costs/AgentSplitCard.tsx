import type { CSSProperties } from 'react'
import { Loader2 } from 'lucide-react'
import GlassCard from '../../components/GlassCard'
import { formatApiEquivalentValue, formatCompactTokenValue, formatPreciseCurrency, formatTokens, inlinePeriodLabel } from './lib'
import type { AgentUsageData } from './types'
import styles from './AgentSplitCard.module.css'

interface AgentSplitItem extends AgentUsageData {
  tokens: number
  cost: number
  costLabel: string
  meteredCost: number
  estimatedCost: number
  apiEquivalentCost: number
  apiEquivalentAvailable: boolean
  topModel: string
}

interface AgentSplitCardProps {
  m: boolean
  agentSplit: AgentSplitItem[]
  agentSplitPending: boolean
  activePeriodLabel: string
  agentSplitPeriodLabel: string
  totalAgentTokens: number
  tokenDataRefreshing: boolean
  tokenDataStale: boolean
}

const AGENT_BUCKET_DETAILS: Record<string, { scope: string; title: string }> = {
  openclaw: {
    scope: 'Direct native sessions',
    title: 'Direct OpenClaw native sessions only. Nested app-launched Codex runs are counted in Codex App Sessions.',
  },
  codex_app: {
    scope: 'Nested app-launched runs',
    title: 'OpenClaw agent/codex-home/sessions runs launched from the Codex app; split out so they no longer inflate OpenClaw.',
  },
  hermes: {
    scope: 'Hermes profile usage',
    title: 'Hermes profile usage from the local Hermes state database.',
  },
  claude_code: {
    scope: 'Local Claude Code sessions',
    title: 'Claude Code usage from local logs via CodexBar. Cost is an API-equivalent estimate, not a subscription invoice.',
  },
}

const PENDING_AGENT_BUCKETS = [
  { label: 'OpenClaw', accent: '#5E5CE6' },
  { label: 'Codex App Sessions', accent: '#007AFF' },
  { label: 'Hermes', accent: '#00C7BE' },
  { label: 'Claude Code', accent: '#D97757' },
]

export default function AgentSplitCard({
  m,
  agentSplit,
  agentSplitPending,
  activePeriodLabel,
  agentSplitPeriodLabel,
  totalAgentTokens,
  tokenDataRefreshing,
  tokenDataStale,
}: AgentSplitCardProps) {
  return (
    <GlassCard delay={0.12} noPad>
      <div className={m ? `${styles.outer} ${styles.outerMobile}` : styles.outer}>
        <div className={styles.headerRow}>
          <div>
            <h3 className={m ? `${styles.title} ${styles.titleMobile}` : styles.title}>
              Agent Split
            </h3>
            <div className={styles.subtitle}>
              {agentSplitPending
                ? `Refreshing Agent Split for the selected ${inlinePeriodLabel(activePeriodLabel)} period…`
                : `Showing agent/session split for the loaded ${inlinePeriodLabel(agentSplitPeriodLabel)} period.`}
            </div>
            {!agentSplitPending && (
              <div className={styles.sourceNote}>
                OpenClaw is direct native usage; Codex App Sessions are nested app-launched runs; Claude Code comes from local CodexBar logs. API equivalent uses public list prices; billing status stays separate from that estimate.
              </div>
            )}
          </div>
          {!agentSplitPending && (
            <div className={styles.badgeGroup}>
              {tokenDataRefreshing && <span className="macos-badge">Refreshing</span>}
              {tokenDataStale && <span className="macos-badge macos-badge-orange">Stale source</span>}
              <span className="macos-badge macos-badge-blue">
                {formatCompactTokenValue(totalAgentTokens)} TOKENS
              </span>
            </div>
          )}
        </div>

        {agentSplitPending ? (
          <div className={m ? `${styles.pendingCard} ${styles.pendingCardMobile}` : styles.pendingCard}>
            <div className={styles.pendingTopRow}>
              <div className={styles.pendingIconRow}>
                <div className={styles.pendingIconWrap}>
                  <Loader2 size={18} className={styles.pendingSpinner} />
                </div>
                <div>
                  <div className={styles.pendingTitle}>
                    Loading {activePeriodLabel} split
                  </div>
                  <div className={styles.pendingSubtitle}>
                    Fetching fresh agent/session usage — old {inlinePeriodLabel(agentSplitPeriodLabel)} values are hidden.
                  </div>
                </div>
              </div>
              <span className="macos-badge macos-badge-blue">Refreshing</span>
            </div>

            <div
              className={styles.pendingGrid}
              style={{ gridTemplateColumns: m ? '1fr' : `repeat(${PENDING_AGENT_BUCKETS.length}, minmax(0, 1fr))` }}
            >
              {PENDING_AGENT_BUCKETS.map(({ label, accent }) => (
                <div
                  key={label}
                  className={m ? `${styles.pendingAgentCell} ${styles.pendingAgentCellMobile}` : styles.pendingAgentCell}
                >
                  <div className={styles.pendingAgentTop}>
                    <div className={styles.pendingAgentLabel}>
                      <span
                        className={styles.pendingDot}
                        style={{
                          background: accent,
                          boxShadow: `0 0 18px ${accent}`,
                        }}
                      />
                      <span className={styles.pendingAgentName}>{label}</span>
                    </div>
                    <div className={styles.pendingSkeletonBar} />
                  </div>
                  <div className={styles.pendingMetricGrid}>
                    {[0, 1].map(item => (
                      <div key={item}>
                        <div
                          className={styles.pendingMetricLabelBar}
                          style={{ width: item === 0 ? 36 : 48 }}
                        />
                        <div
                          className={styles.pendingMetricValueBar}
                          style={{ width: item === 0 ? '72%' : '84%' }}
                        />
                      </div>
                    ))}
                  </div>
                  <div className={styles.pendingProgressTrack}>
                    <div
                      className={styles.pendingProgressFill}
                      style={{
                        width: label === 'OpenClaw' ? '58%' : '42%',
                        background: `linear-gradient(90deg, ${accent}, rgba(255,255,255,0.35))`,
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div
            className={styles.agentGrid}
            style={{ gridTemplateColumns: m ? '1fr' : 'repeat(2, minmax(0, 1fr))' }}
          >
            {agentSplit.map(agent => {
              const share = totalAgentTokens > 0 ? (agent.tokens / totalAgentTokens) * 100 : 0
              const accent = agent.accent || (agent.key === 'hermes' ? '#00C7BE' : '#5E5CE6')
              const bucketDetails = AGENT_BUCKET_DETAILS[agent.key]
              const billingDetails = [
                agent.meteredCost > 0 ? `${formatPreciseCurrency(agent.meteredCost)} metered` : null,
                agent.estimatedCost > 0 ? `${formatPreciseCurrency(agent.estimatedCost)} estimated` : null,
              ].filter(Boolean).join(' + ')
              const billingStatus = agent.costLabel === 'Included'
                ? 'Billing included'
                : agent.costLabel === 'Metered'
                  ? `Metered · ${formatPreciseCurrency(agent.meteredCost)}`
                  : agent.costLabel === 'Estimated'
                    ? `Estimated cost · ${formatPreciseCurrency(agent.estimatedCost)}`
                    : agent.costLabel === 'Partial'
                      ? billingDetails
                        ? `Partially tracked · ${billingDetails}`
                        : 'Partially tracked'
                      : agent.costLabel === 'Mixed'
                        ? billingDetails
                          ? `Mixed billing · ${billingDetails}`
                          : 'Mixed billing'
                        : 'Billing untracked'
              return (
                <div
                  key={agent.key}
                  className={m ? `${styles.agentCard} ${styles.agentCardMobile}` : styles.agentCard}
                  style={{
                    border: '1px solid rgba(255,255,255,0.09)',
                    background: `radial-gradient(circle at 12% 0%, ${accent}14, transparent 42%), rgba(255,255,255,0.025)`,
                    boxShadow: `inset 0 1px 0 ${accent}55`,
                  }}
                >
                  <div className={styles.agentCardTop}>
                    <div className={styles.agentCardLabel} title={bucketDetails?.title}>
                      <span
                        className={styles.agentDot}
                        style={{ background: accent, boxShadow: `0 0 18px ${accent}` }}
                      />
                      <span className={styles.agentNameStack}>
                        <span className={styles.agentName}>{agent.label}</span>
                        {bucketDetails && (
                          <span className={styles.agentScope}>{bucketDetails.scope}</span>
                        )}
                      </span>
                    </div>
                    <div className={styles.agentStateGroup}>
                      {agent.status === 'stale' && <span className="macos-badge macos-badge-orange">STALE</span>}
                      <span className={styles.agentShare}>Mix {share.toFixed(1)}%</span>
                    </div>
                  </div>

                  <div className={styles.apiEquivalentBlock}>
                    <div className={styles.agentMetricLabel}>API equivalent</div>
                    <div className={m ? `${styles.apiEquivalentValue} ${styles.apiEquivalentValueMobile}` : styles.apiEquivalentValue}>
                      {formatApiEquivalentValue(agent.apiEquivalentCost, agent.apiEquivalentAvailable)}
                    </div>
                    <div className={styles.agentEquivalentLabel}>Estimated public list price</div>
                  </div>

                  <div className={styles.secondaryMetrics}>
                    <div title={`${formatTokens(agent.tokens)} tokens`}>
                      <div className={styles.agentMetricLabel}>Tokens</div>
                      <div
                        className={styles.secondaryMetricValue}
                        style={{ fontFeatureSettings: '"tnum"' } as CSSProperties}
                      >
                        {formatCompactTokenValue(agent.tokens)}
                      </div>
                    </div>
                    <div className={styles.modelMetric}>
                      <div className={styles.agentMetricLabel}>Top model</div>
                      <div className={styles.secondaryModelValue} title={agent.topModel}>
                        {agent.topModel}
                      </div>
                    </div>
                  </div>

                  <div className={styles.agentProgressSection}>
                    <div className={styles.agentProgressTrack}>
                      <div
                        className={styles.agentProgressFill}
                        style={{
                          width: `${Math.max(share, agent.tokens > 0 ? 3 : 0)}%`,
                          background: accent,
                        }}
                      />
                    </div>
                    <div
                      className={agent.costLabel === 'Included'
                        ? `${styles.billingStatus} ${styles.billingStatusIncluded}`
                        : agent.costLabel === 'Partial'
                          ? `${styles.billingStatus} ${styles.billingStatusPartial}`
                          : styles.billingStatus}
                    >
                      {billingStatus}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </GlassCard>
  )
}

// Re-export type for orchestrator
export type { AgentSplitItem }
