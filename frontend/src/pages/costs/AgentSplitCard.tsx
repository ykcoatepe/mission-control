import type { CSSProperties } from 'react'
import { Loader2 } from 'lucide-react'
import GlassCard from '../../components/GlassCard'
import { formatCompactTokenValue, formatAgentCostValue, formatTokens } from './lib'
import type { AgentUsageData } from './types'
import styles from './AgentSplitCard.module.css'

interface AgentSplitItem extends AgentUsageData {
  tokens: number
  cost: number
  costLabel: string
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
}

export default function AgentSplitCard({
  m,
  agentSplit,
  agentSplitPending,
  activePeriodLabel,
  agentSplitPeriodLabel,
  totalAgentTokens,
  tokenDataRefreshing,
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
                ? `Refreshing Agent Split for the selected ${activePeriodLabel.toLowerCase()} period…`
                : `Showing agent/session split for the loaded ${agentSplitPeriodLabel.toLowerCase()} period.`}
            </div>
          </div>
          {!agentSplitPending && (
            <div className={styles.badgeGroup}>
              {tokenDataRefreshing && <span className="macos-badge">Refreshing</span>}
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
                    Fetching fresh agent/session usage — old {agentSplitPeriodLabel.toLowerCase()} values are hidden.
                  </div>
                </div>
              </div>
              <span className="macos-badge macos-badge-blue">Refreshing</span>
            </div>

            <div
              className={styles.pendingGrid}
              style={{ gridTemplateColumns: m ? '1fr' : 'repeat(3, minmax(0, 1fr))' }}
            >
              {['OpenClaw', 'Codex App Sessions', 'Hermes'].map((label, index) => (
                <div
                  key={label}
                  className={m ? `${styles.pendingAgentCell} ${styles.pendingAgentCellMobile}` : styles.pendingAgentCell}
                >
                  <div className={styles.pendingAgentTop}>
                    <div className={styles.pendingAgentLabel}>
                      <span
                        className={styles.pendingDot}
                        style={{
                          background: index === 0 ? '#5E5CE6' : '#00C7BE',
                          boxShadow: `0 0 18px ${index === 0 ? '#5E5CE6' : '#00C7BE'}`,
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
                        width: index === 0 ? '58%' : '42%',
                        background: `linear-gradient(90deg, ${index === 0 ? '#5E5CE6' : '#00C7BE'}, rgba(255,255,255,0.35))`,
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
            style={{ gridTemplateColumns: m ? '1fr' : `repeat(${agentSplit.length}, minmax(0, 1fr))` }}
          >
            {agentSplit.map(agent => {
              const share = totalAgentTokens > 0 ? (agent.tokens / totalAgentTokens) * 100 : 0
              const accent = agent.accent || (agent.key === 'hermes' ? '#00C7BE' : '#5E5CE6')
              return (
                <div
                  key={agent.key}
                  className={m ? `${styles.agentCard} ${styles.agentCardMobile}` : styles.agentCard}
                  style={{
                    border: `1px solid ${accent}55`,
                    background: `linear-gradient(145deg, ${accent}22 0%, rgba(255,255,255,0.035) 45%, rgba(255,255,255,0.02) 100%)`,
                    boxShadow: `0 14px 34px ${accent}18`,
                  }}
                >
                  <div className={styles.agentCardTop}>
                    <div className={styles.agentCardLabel}>
                      <span
                        className={styles.agentDot}
                        style={{ background: accent, boxShadow: `0 0 18px ${accent}` }}
                      />
                      <span className={styles.agentName}>{agent.label}</span>
                    </div>
                    <span className={styles.agentShare}>{share.toFixed(1)}%</span>
                  </div>

                  <div className={styles.agentMetricGrid}>
                    <div>
                      <div className={styles.agentMetricLabel}>Cost</div>
                      <div className={m ? `${styles.agentMetricValue} ${styles.agentMetricValueMobile}` : styles.agentMetricValue}>
                        {formatAgentCostValue(agent.cost, agent.costLabel)}
                      </div>
                      <div
                        className={styles.agentCostLabel}
                        style={{ color: agent.costLabel === 'Metered' ? 'rgba(255,255,255,0.42)' : '#FFCC00' }}
                      >
                        {agent.costLabel}
                      </div>
                    </div>
                    <div title={`${formatTokens(agent.tokens)} tokens`}>
                      <div className={styles.agentMetricLabel}>Tokens</div>
                      <div
                        className={m ? `${styles.agentMetricValue} ${styles.agentMetricValueMobile}` : styles.agentMetricValue}
                        style={{ fontFeatureSettings: '"tnum"' } as CSSProperties}
                      >
                        {formatCompactTokenValue(agent.tokens)}
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
                    <div className={styles.agentTopModel} title={agent.topModel}>
                      Top model: {agent.topModel}
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
