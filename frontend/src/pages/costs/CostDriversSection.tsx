import { Cpu, Zap } from 'lucide-react'
import GlassCard from '../../components/GlassCard'
import { formatApiEquivalentValue, formatCurrency, formatTokens, formatSessionTimestamp } from './lib'
import type { AWSSCostData, AggregatedBreakdownItem, CodexBarCostData, CodexBarDailyEntry } from './types'
import styles from './CostDriversSection.module.css'

interface TopSession {
  sessionId: string
  sessionName: string
  model: string
  tokens: number
  cost: number
  timestamp: number
  color: string
  channel: string
}

interface CostSignal {
  title: string
  body: string
  accent: string
  icon: typeof Cpu
}

interface CodexBarLatest {
  date: string
  models: Array<{
    model: string
    cost: number
    totalTokens: number
  }>
}

export interface CostDriversSectionProps {
  m: boolean
  isAwsEnabled: boolean
  hasAwsData: boolean
  awsCosts: AWSSCostData | null
  codexbarActive: boolean
  codexbarCosts: CodexBarCostData | null
  codexbarLatest: CodexBarLatest | null
  codexbarPeriodLabel: string
  codexbarPeriodCost: number
  codexbarPeriodTokens: number
  codexbarPeriodDaysList: CodexBarDailyEntry[]
  driverView: 'models' | 'sessions' | 'codexbar' | 'notes'
  setDriverView: (v: 'models' | 'sessions' | 'codexbar' | 'notes') => void
  tokenBreakdown: AggregatedBreakdownItem[]
  topSessions: TopSession[]
  sessionPressureMax: number
  costSignals: CostSignal[]
  creditsUsed: number
  burnRate: number
  dailyAvg: number
  ledgerActive: boolean
  tokenDataSource?: string
}

export default function CostDriversSection({
  m,
  isAwsEnabled,
  hasAwsData,
  awsCosts,
  codexbarActive,
  codexbarCosts,
  codexbarLatest,
  codexbarPeriodLabel,
  codexbarPeriodCost,
  codexbarPeriodTokens,
  codexbarPeriodDaysList,
  driverView,
  setDriverView,
  tokenBreakdown,
  topSessions,
  sessionPressureMax,
  costSignals,
  creditsUsed,
  burnRate,
  dailyAvg,
  ledgerActive,
  tokenDataSource,
}: CostDriversSectionProps) {
  return (
    <div
      className={m ? `${styles.outerGrid} ${styles.outerGridMobile}` : styles.outerGrid}
      style={{ gridTemplateColumns: m ? '1fr' : (isAwsEnabled && hasAwsData ? '1.45fr 0.8fr' : '1fr') }}
    >
      <GlassCard delay={0.28} noPad>
        <div className={m ? `${styles.driversInner} ${styles.driversInnerMobile}` : styles.driversInner}>
          <div className={styles.driversHeader}>
            <div>
              <h3 className={m ? `${styles.driversTitle} ${styles.driversTitleMobile}` : styles.driversTitle}>
                Cost Drivers
              </h3>
              <div className={styles.driversSubtitle}>
                One surface for model mix, session pressure, and methodology.
              </div>
            </div>

            <div className={styles.tabStrip}>
              {([
                ['models', 'By model'],
                ['sessions', 'By session'],
                ['codexbar', '🟠 CodexBar'],
                ['notes', 'Notes'],
              ] as const).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setDriverView(key)}
                  className={driverView === key ? `${styles.tabBtn} ${styles.tabBtnActive}` : styles.tabBtn}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {driverView === 'models' ? (
            <div className={styles.modelList}>
              {tokenBreakdown.length > 0 ? tokenBreakdown.map((item, index) => (
                <div
                  key={item.name}
                  className={m ? `${styles.modelRow} ${styles.modelRowMobile}` : styles.modelRow}
                  style={{ gridTemplateColumns: m ? '1fr' : 'minmax(0, 1.2fr) minmax(220px, 0.8fr)' }}
                >
                  <div className={styles.modelRowLeft}>
                    <div className={styles.modelRowTopLine}>
                      <div className={styles.modelNameGroup}>
                        <span className="macos-badge">#{index + 1}</span>
                        <span className={styles.modelColorDot} style={{ background: item.color }} />
                        <span className={m ? `${styles.modelName} ${styles.modelNameMobile}` : styles.modelName}>{item.name}</span>
                        {item.local ? <span className="macos-badge macos-badge-blue">Local</span> : null}
                      </div>
                      <div className={styles.modelShare}>{item.share.toFixed(1)}% share</div>
                    </div>

                    <div className={styles.modelProgressTrack}>
                      <div
                        className={styles.modelProgressFill}
                        style={{ width: `${Math.max(item.share, 2)}%`, background: item.color }}
                      />
                    </div>

                    <div className={styles.modelVariantNote}>
                      {item.rawNames.length > 1 ? `${item.rawNames.length} model variants merged into one family.` : 'Single model family.'}
                    </div>
                  </div>

                  <div className={styles.modelStatGrid}>
                    <div className={styles.modelStatCell}>
                      <div className={styles.modelStatLabel}>Tokens</div>
                      <div className={styles.modelStatValue}>{formatTokens(item.tokens)}</div>
                    </div>
                    <div className={styles.modelStatCell}>
                      <div className={styles.modelStatLabel}>Tracked Cost</div>
                      <div className={styles.modelStatValue}>{item.local ? '$0.00' : formatCurrency(item.cost)}</div>
                    </div>
                    <div className={styles.modelStatCell}>
                      <div className={styles.modelStatLabel}>API Equivalent</div>
                      <div className={styles.modelStatValue}>{formatApiEquivalentValue(item.apiEquivalentCost, item.apiEquivalentAvailable)}</div>
                    </div>
                  </div>
                </div>
              )) : (
                <div className={styles.emptyNote}>No model breakdown data yet</div>
              )}
            </div>
          ) : driverView === 'sessions' ? (
            <div className={styles.sessionList}>
              {topSessions.length > 0 ? topSessions.map((session, i) => (
                <div
                  key={session.sessionId}
                  className={m ? `${styles.sessionRow} ${styles.sessionRowMobile}` : styles.sessionRow}
                >
                  <div className={styles.sessionTopLine}>
                    <div className={styles.sessionBadgeGroup}>
                      <span className="macos-badge">#{i + 1}</span>
                      <span className="macos-badge macos-badge-blue">{session.channel}</span>
                    </div>
                    <div className={styles.sessionTimestamp}>Updated {formatSessionTimestamp(session.timestamp)}</div>
                  </div>

                  <div
                    className={styles.sessionDetail}
                    style={{ gridTemplateColumns: m ? '1fr' : 'minmax(0, 1.2fr) minmax(180px, 0.8fr)' }}
                  >
                    <div>
                      <div className={m ? `${styles.sessionName} ${styles.sessionNameMobile}` : styles.sessionName}>{session.sessionName}</div>
                      <div className={styles.sessionModel}>{session.model}</div>
                    </div>
                    <div className={styles.sessionCostBlock} style={{ textAlign: m ? 'left' : 'right' }}>
                      <div className={styles.sessionCost}>{formatCurrency(session.cost)}</div>
                      <div className={styles.sessionTokens}>{formatTokens(session.tokens)} tokens</div>
                    </div>
                  </div>

                  <div className={styles.sessionProgressTrack}>
                    <div
                      className={styles.sessionProgressFill}
                      style={{
                        width: `${Math.max((session.tokens / sessionPressureMax) * 100, 8)}%`,
                        background: session.color,
                      }}
                    />
                  </div>
                </div>
              )) : (
                <div
                  className={styles.sessionEmptyBox}
                  style={{ padding: m ? '32px 16px' : '48px 24px' }}
                >
                  <div className={styles.sessionEmptyTitle} style={{ fontSize: m ? '14px' : '16px' }}>No session load data yet</div>
                  <div style={{ fontSize: m ? '12px' : '14px' }}>Start using OpenClaw to see session pressure here</div>
                </div>
              )}
            </div>
          ) : driverView === 'codexbar' ? (
            <div className={styles.codexbarList}>
              {codexbarActive && codexbarCosts ? (
                <>
                  {/* Summary stats — Input/Output and the history below stay scoped to the
                      selected period; the widened scan payload may reach months past it. */}
                  <div
                    className={styles.codexbarStatGrid}
                    style={{ gridTemplateColumns: m ? '1fr 1fr' : 'repeat(4, 1fr)' }}
                  >
                    {[
                      { label: 'Last 30 Days', value: formatCurrency(codexbarCosts.last30DaysCostUSD), sub: formatTokens(codexbarCosts.last30DaysTokens) + ' tokens', accent: '#FF9500' },
                      { label: codexbarPeriodLabel, value: formatCurrency(codexbarPeriodCost), sub: formatTokens(codexbarPeriodTokens) + ' tokens', accent: '#FF9500' },
                      { label: 'Input', value: formatTokens(codexbarPeriodDaysList.reduce((sum, day) => sum + (day.inputTokens || 0), 0)), sub: 'selected period', accent: '#007AFF' },
                      { label: 'Output', value: formatTokens(codexbarPeriodDaysList.reduce((sum, day) => sum + (day.outputTokens || 0), 0)), sub: 'selected period', accent: '#32D74B' },
                    ].map(stat => (
                      <div
                        key={stat.label}
                        className={styles.codexbarStatCell}
                        style={{ padding: m ? '12px' : '14px 16px' }}
                      >
                        <div className={styles.codexbarStatLabel}>{stat.label}</div>
                        <div
                          className={styles.codexbarStatValue}
                          style={{ fontSize: m ? 16 : 18, color: stat.accent }}
                        >{stat.value}</div>
                        <div className={styles.codexbarStatSub}>{stat.sub}</div>
                      </div>
                    ))}
                  </div>

                  {/* Model breakdown from latest day */}
                  {codexbarLatest?.models && codexbarLatest.models.length > 0 && (
                    <>
                      <div className={styles.codexbarSectionLabel}>
                        {codexbarLatest.date} — Latest Day Breakdown
                      </div>
                      {codexbarLatest.models.map((model, index) => {
                        const dayTotal = codexbarLatest.models.reduce((s, mo) => s + (mo.cost || 0), 0)
                        const share = dayTotal > 0 ? ((model.cost || 0) / dayTotal) * 100 : 0
                        return (
                          <div
                            key={model.model}
                            className={m ? `${styles.codexbarModelRow} ${styles.codexbarModelRowMobile}` : styles.codexbarModelRow}
                          >
                            <div className={styles.codexbarModelTopLine}>
                              <div className={styles.codexbarModelBadgeGroup}>
                                <span className="macos-badge">#{index + 1}</span>
                                <span className={m ? `${styles.codexbarModelName} ${styles.codexbarModelNameMobile}` : styles.codexbarModelName}>{model.model}</span>
                                <span className="macos-badge macos-badge-orange">LOCAL ESTIMATE</span>
                              </div>
                              <div className={styles.codexbarModelShare}>{share.toFixed(1)}% share</div>
                            </div>
                            <div className={styles.codexbarModelProgressTrack}>
                              <div
                                className={styles.codexbarModelProgressFill}
                                style={{ width: Math.max(share, 3) + '%' }}
                              />
                            </div>
                            <div className={styles.codexbarModelStatGrid}>
                              <div className={styles.codexbarModelStatCell}>
                                <div className={styles.codexbarModelStatLabel}>Cost</div>
                                <div className={styles.codexbarModelStatCostValue}>{formatCurrency(model.cost)}</div>
                              </div>
                              <div className={styles.codexbarModelStatCell}>
                                <div className={styles.codexbarModelStatLabel}>Tokens</div>
                                <div className={styles.codexbarModelStatTokenValue}>{formatTokens(model.totalTokens)}</div>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </>
                  )}

                  {/* Daily history — selected period only, days with usage */}
                  {codexbarPeriodDaysList.some(day => (day.totalTokens || 0) > 0 || (day.totalCost || 0) > 0) && (
                    <>
                      <div className={styles.codexbarSectionLabel}>Daily History</div>
                      {codexbarPeriodDaysList.filter(day => (day.totalTokens || 0) > 0 || (day.totalCost || 0) > 0).slice().reverse().map((day) => {
                        const dayTotal = day.totalCost || 0
                        const dayTokens = day.totalTokens || 0
                        const isLatest = day.date === codexbarLatest?.date
                        return (
                          <div
                            key={day.date}
                            className={styles.codexbarDayRow}
                            style={{
                              padding: m ? '12px 14px' : '12px 16px',
                              background: isLatest ? 'rgba(255,149,0,0.06)' : 'rgba(255,255,255,0.03)',
                              border: '1px solid ' + (isLatest ? 'rgba(255,149,0,0.18)' : 'rgba(255,255,255,0.07)'),
                            }}
                          >
                            <div className={styles.codexbarDayInner}>
                              <div className={styles.codexbarDayLeft}>
                                <span className={styles.codexbarDayDate}>{day.date}</span>
                                {isLatest && <span className="macos-badge macos-badge-orange">LATEST</span>}
                              </div>
                              <div className={styles.codexbarDayRight}>
                                <span className={styles.codexbarDayCost}>{formatCurrency(dayTotal)}</span>
                                <span className={styles.codexbarDayTokens}>{formatTokens(dayTokens)} tok</span>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </>
                  )}

                  <div className={styles.codexbarFooter}>
                    Source: CodexBar · {codexbarCosts.updatedAt ? 'Updated ' + new Date(codexbarCosts.updatedAt).toLocaleString() : 'Loading...'}
                  </div>
                </>
              ) : (
                <div className={styles.codexbarEmpty}>
                  <div className={styles.codexbarEmptyTitle}>CodexBar verisi yok</div>
                  <div className={styles.codexbarEmptySubtitle}>Mission Control + CodexBar entegrasyonu aktif değil</div>
                </div>
              )}
            </div>
          ) : (
            <div
              className={styles.notesGrid}
              style={{ gridTemplateColumns: m ? '1fr' : '1fr 1fr' }}
            >
              {costSignals.map(signal => {
                const Icon = signal.icon
                return (
                  <div
                    key={signal.title}
                    className={m ? `${styles.signalCard} ${styles.signalCardMobile}` : `${styles.signalCard} ${styles.signalCardDesktop}`}
                    style={{ boxShadow: `inset 0 1px 0 rgba(255,255,255,0.04), 0 12px 30px ${signal.accent}18` }}
                  >
                    <div className={styles.signalTitle}>
                      <Icon size={15} style={{ color: signal.accent }} />
                      {signal.title}
                    </div>
                    <div className={styles.signalBody}>{signal.body}</div>
                  </div>
                )
              })}

              <div
                className={m ? `${styles.methodologyCard} ${styles.signalCardMobile}` : `${styles.methodologyCard} ${styles.signalCardDesktop}`}
                style={{ gridColumn: m ? 'auto' : '1 / -1' }}
              >
                <div className={styles.methodologyTitle}>
                  <Zap size={15} className={styles.iconOrange} />
                  Methodology
                </div>
                <div className={styles.methodologyBody}>
                  {ledgerActive
                    ? 'Tracked spend follows billing mode. API equivalent applies public rate cards across OpenClaw, Codex App, Hermes, and Claude Code without treating subscription usage as an invoice.'
                    : codexbarActive
                      ? 'This view combines local Codex and Claude Code logs through CodexBar. Costs are API-equivalent estimates, not subscription invoices.'
                      : hasAwsData
                    ? 'This view is backed by AWS billing data.'
                    : ledgerActive
                      ? tokenDataSource === 'openclaw.usage'
                        ? 'This view is backed by OpenClaw usage summaries extracted from session transcripts.'
                        : 'This view is backed by token ledger rows and estimated model pricing.'
                      : 'This view is currently using session token fallback, so spend is estimated from token volume rather than model-resolved ledger data.'}
                </div>
              </div>
            </div>
          )}
        </div>
      </GlassCard>

      {isAwsEnabled && hasAwsData && awsCosts && (
        <GlassCard delay={0.35} noPad>
          <div className={m ? `${styles.runwayInner} ${styles.runwayInnerMobile}` : styles.runwayInner}>
            <div className={m ? `${styles.runwayHeader} ${styles.runwayHeaderMobile}` : styles.runwayHeader}>
              <h3 className={m ? `${styles.runwayTitle} ${styles.runwayTitleMobile}` : styles.runwayTitle}>Credits Runway</h3>
              <div className={styles.runwaySubtitle}>
                How long the remaining AWS credit balance can support current usage.
              </div>
            </div>
            <div className={styles.runwayProgressSection}>
              <div className={styles.runwayProgressHeader}>
                <span className={m ? `${styles.runwayProgressLabel} ${styles.runwayProgressLabelMobile}` : styles.runwayProgressLabel}>Used</span>
                <span className={m ? `${styles.runwayProgressValue} ${styles.runwayProgressValueMobile}` : styles.runwayProgressValue}>
                  {formatCurrency(creditsUsed)} / {formatCurrency(awsCosts.credits)}
                </span>
              </div>
              <div className={styles.runwayTrack}>
                <div
                  className={styles.runwayFill}
                  style={{
                    width: `${(creditsUsed / awsCosts.credits) * 100}%`,
                    background: creditsUsed / awsCosts.credits > 0.75 ? '#FF453A' : creditsUsed / awsCosts.credits > 0.5 ? '#FF9500' : '#32D74B',
                  }}
                />
              </div>
            </div>
            <div className={styles.runwayStats}>
              <div className={styles.runwayStatRow}>
                <span className={m ? `${styles.runwayStatLabel} ${styles.runwayStatLabelMobile}` : `${styles.runwayStatLabel} ${styles.runwayStatLabelDesktop}`}>At current rate, credits last:</span>
                <span className={m ? `${styles.runwayStatValue} ${styles.runwayStatValueMobile}` : `${styles.runwayStatValue} ${styles.runwayStatValueDesktop}`}>{burnRate === Infinity ? '∞' : `${Math.round(burnRate)} days`}</span>
              </div>
              <div className={styles.runwayStatRow}>
                <span className={m ? `${styles.runwayStatLabel} ${styles.runwayStatLabelMobile}` : `${styles.runwayStatLabel} ${styles.runwayStatLabelDesktop}`}>Daily burn rate:</span>
                <span className={m ? `${styles.runwayStatValue} ${styles.runwayStatValueMobile}` : `${styles.runwayStatValue} ${styles.runwayStatValueDesktop}`}>{formatCurrency(dailyAvg)}/day</span>
              </div>
            </div>
          </div>
        </GlassCard>
      )}
    </div>
  )
}
