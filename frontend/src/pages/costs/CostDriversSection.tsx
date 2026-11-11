import type { ReactNode } from 'react'
import {
  DataTable,
  EmptyState,
  Meter,
  Notice,
  Panel,
  Skeleton,
  StatePill,
  Tabs,
  TimeAgo,
} from '../../components/ui'
import type { DataTableColumn } from '../../components/ui'
import {
  BILLING_NOT_READ,
  formatCompactTokenValue,
  formatCurrency,
  formatPreciseCurrency,
  formatTokenPhrase,
} from './lib'
import type { AgentUsageData, AggregatedBreakdownItem } from './types'
import styles from './CostDriversSection.module.css'

export type DriverTab = 'aws' | 'models' | 'platforms' | 'sessions'

export interface AgentSplitItem extends AgentUsageData {
  tokens: number
  cost: number
  costLabel: string
  meteredCost: number
  estimatedCost: number
  apiEquivalentCost: number
  apiEquivalentAvailable: boolean
  topModel: string
}

export interface TopSession {
  sessionId: string
  sessionName: string
  model: string
  tokens: number
  /** Epoch seconds, or null when the session has no update time. */
  timestamp: number | null
  /** Agent and channel, in words. The raw session key (it carries chat ids) is never shown. */
  detail: string
  /** True: running now. False: not running. Null: the gateway did not say. */
  active: boolean | null
}

export interface AwsServiceDriver {
  name: string
  cost: number
  share: number
}

export interface CostDriversSectionProps {
  /** Tab the user picked; null = the default for the data in view. */
  tab: DriverTab | null
  setTab: (tab: DriverTab) => void
  models: AggregatedBreakdownItem[]
  /** Sum of API-equivalent cost across models that have one. */
  modelApiEquivalentTotal: number
  /** Per-platform split of the period: share, top model and billing mix. Tokens and cost sit in the Platforms panel. */
  platforms: AgentSplitItem[]
  platformsPending: boolean
  totalPlatformTokens: number
  sessions: TopSession[]
  /** Set when the period is a past month: sessions are recent, not that month's. */
  sessionsOnlyNotice: string | null
  /** How many of all sessions are running now (for the line above the list). */
  activeSessionCount: number
  /** Sessions with no token count: not listed, and not counted as 0. */
  sessionsWithoutTokens: number
  awsServices: AwsServiceDriver[] | null
}

const SOURCE_SCOPES: Record<string, { scope: string; title: string }> = {
  openclaw: {
    scope: 'Sessions launched by OpenClaw',
    title: 'Everything OpenClaw launched: native sessions plus its nested agent/codex-home Codex runs.',
  },
  codex_app: {
    scope: 'Codex desktop app',
    title: 'Standalone ~/.codex/sessions rollouts whose originator is the Codex (ChatGPT) desktop app, subagent spawns included.',
  },
  codex_cli: {
    scope: 'Standalone Codex CLI runs',
    title: 'Standalone ~/.codex/sessions rollouts from codex exec / CLI spawns (Claude Code and Hermes delegations, scripts) that run outside OpenClaw.',
  },
  hermes: {
    scope: 'Hermes profiles',
    title: 'Hermes profile usage from the local Hermes state database.',
  },
  claude_code: {
    scope: 'Local Claude Code sessions',
    title: 'Claude Code usage from local logs via CodexBar. Cost is an API-equivalent estimate, not a subscription invoice.',
  },
}

function billingStatus(agent: AgentSplitItem) {
  const details = [
    agent.meteredCost > 0 ? `${formatPreciseCurrency(agent.meteredCost)} metered` : null,
    agent.estimatedCost > 0 ? `${formatPreciseCurrency(agent.estimatedCost)} estimated` : null,
  ].filter(Boolean).join(' + ')
  switch (agent.costLabel) {
    case 'Included':
      return 'Included'
    case 'Metered':
      return `Metered · ${formatPreciseCurrency(agent.meteredCost)}`
    case 'Estimated':
      return `Estimated · ${formatPreciseCurrency(agent.estimatedCost)}`
    case 'Partial':
      return details ? `Billing partly read · ${details}` : 'Billing partly read'
    case 'Mixed':
      return details ? `Mixed · ${details}` : 'Mixed'
    default:
      return BILLING_NOT_READ
  }
}

function apiEquivalentText(cost: number, available: boolean) {
  return <span className={styles.num}>{available && Number.isFinite(cost) ? formatPreciseCurrency(cost) : '—'}</span>
}

function ShareCell({ pct, label }: { pct: number | null; label: string }) {
  if (pct === null) return <>—</>
  return (
    <span className={styles.share}>
      <span className={styles.shareValue}>{pct.toFixed(1)}%</span>
      <Meter className={styles.shareMeter} value={pct} state="inactive" label={`${label} share`} />
    </span>
  )
}

function TokenCell({ tokens }: { tokens: number | null }) {
  return <span className={styles.num} title={formatTokenPhrase(tokens)}>{formatCompactTokenValue(tokens)}</span>
}

/** Billed spend; a dash with its reason when billing for the row was not read. Never $0.00. */
function TrackedSpendCell({ cost }: { cost: number | null }) {
  if (cost === null || !Number.isFinite(cost)) {
    return (
      <span className={styles.num} role="img" aria-label={BILLING_NOT_READ} title={BILLING_NOT_READ}>—</span>
    )
  }
  return <span className={styles.num}>{formatCurrency(cost)}</span>
}

export default function CostDriversSection({
  tab,
  setTab,
  models,
  modelApiEquivalentTotal,
  platforms,
  platformsPending,
  totalPlatformTokens,
  sessions,
  sessionsOnlyNotice,
  activeSessionCount,
  sessionsWithoutTokens,
  awsServices,
}: CostDriversSectionProps) {
  const hasPlatforms = platformsPending || platforms.length > 0
  const tabs: Array<{ id: DriverTab; label: string }> = [
    ...(awsServices ? [{ id: 'aws' as const, label: 'By AWS service' }] : []),
    { id: 'models', label: 'By model' },
    ...(hasPlatforms ? [{ id: 'platforms' as const, label: 'By platform' }] : []),
    { id: 'sessions', label: 'Recent sessions' },
  ]
  const fallbackTab: DriverTab = awsServices ? 'aws' : 'models'
  const active: DriverTab = tab && tabs.some(item => item.id === tab) ? tab : fallbackTab

  const modelColumns: DataTableColumn<AggregatedBreakdownItem>[] = [
    {
      key: 'model',
      header: 'Model',
      cell: item => (
        <span className={styles.nameStack}>
          <span className={styles.name}>
            <span className={styles.nameText}>{item.name}</span>
            {item.isLocal === true && <span className={styles.tag}>Local</span>}
            {item.rawNames.length > 1 && <span className={styles.tag} title={item.rawNames.join('\n')}>{item.rawNames.length} variants</span>}
          </span>
          {item.platforms.length > 0 && <span className={styles.sub}>{item.platforms.join(', ')}</span>}
        </span>
      ),
    },
    {
      key: 'api',
      header: 'API equivalent',
      align: 'end',
      mono: true,
      cell: item => apiEquivalentText(item.apiEquivalentCost, item.apiEquivalentAvailable),
    },
    {
      key: 'share',
      header: 'Share of estimate',
      mobileLabel: 'Share',
      align: 'end',
      mono: true,
      width: '160px',
      cell: item => (
        <ShareCell
          label={item.name}
          pct={item.apiEquivalentAvailable && modelApiEquivalentTotal > 0
            ? (item.apiEquivalentCost / modelApiEquivalentTotal) * 100
            : null}
        />
      ),
    },
    { key: 'tokens', header: 'Tokens', align: 'end', mono: true, cell: item => <TokenCell tokens={item.tokens} /> },
    { key: 'tracked', header: 'Tracked spend', align: 'end', mono: true, cell: item => <TrackedSpendCell cost={item.cost} /> },
  ]

  // Tokens and API-equivalent cost per platform are in the Platforms panel
  // above; this view only adds what that table does not show.
  const platformColumns: DataTableColumn<AgentSplitItem>[] = [
    {
      key: 'platform',
      header: 'Platform',
      cell: agent => {
        const details = SOURCE_SCOPES[agent.key]
        return (
          <span className={styles.nameStack} title={details?.title}>
            <span className={styles.name}>
              <span className={styles.nameText}>{agent.label}</span>
              {agent.status === 'stale' && <StatePill state="warning" label="Stale" />}
            </span>
            {details && <span className={styles.sub}>{details.scope}</span>}
          </span>
        )
      },
    },
    {
      key: 'share',
      header: 'Share of tokens',
      mobileLabel: 'Share',
      align: 'end',
      mono: true,
      width: '160px',
      cell: agent => (
        <ShareCell
          label={agent.label}
          pct={totalPlatformTokens > 0 && agent.tokens > 0 && agent.status !== 'unavailable'
            ? (agent.tokens / totalPlatformTokens) * 100
            : null}
        />
      ),
    },
    {
      key: 'model',
      header: 'Top model',
      cell: agent => <span className={styles.nameText} title={agent.topModel}>{agent.topModel}</span>,
    },
    { key: 'billing', header: 'Billing', cell: agent => billingStatus(agent) },
  ]

  const sessionColumns: DataTableColumn<TopSession>[] = [
    {
      key: 'session',
      header: 'Session',
      cell: session => (
        <span className={styles.nameStack}>
          <span className={styles.name}>
            <span className={styles.nameText}>{session.sessionName}</span>
            {session.active === true && <StatePill state="healthy" label="Running" />}
          </span>
          <span className={styles.sub}>{session.detail}</span>
        </span>
      ),
    },
    { key: 'model', header: 'Model', cell: session => session.model },
    { key: 'tokens', header: 'Tokens', align: 'end', mono: true, cell: session => <TokenCell tokens={session.tokens} /> },
    {
      key: 'updated',
      header: 'Updated',
      align: 'end',
      cell: session => <span className={styles.num}><TimeAgo value={session.timestamp === null ? null : session.timestamp * 1000} /></span>,
    },
  ]

  const awsColumns: DataTableColumn<AwsServiceDriver>[] = [
    { key: 'service', header: 'Service', cell: service => service.name },
    { key: 'cost', header: 'Cost', align: 'end', mono: true, cell: service => formatCurrency(service.cost) },
    {
      key: 'share',
      header: 'Share',
      align: 'end',
      mono: true,
      width: '160px',
      cell: service => <ShareCell label={service.name} pct={service.share} />,
    },
  ]

  let content: ReactNode
  if (active === 'aws' && awsServices) {
    content = (
      <DataTable
        caption="AWS cost by service"
        columns={awsColumns}
        rows={awsServices}
        rowKey={service => service.name}
        maxHeight="none"
        empty={<EmptyState title="No AWS services billed" description="Live billing returned no services for this period." />}
      />
    )
  } else if (active === 'platforms') {
    content = platformsPending ? (
      <div className={styles.pad}>
        <Skeleton variant="block" label="Loading usage by platform" />
      </div>
    ) : (
      <DataTable
        caption="Usage by platform"
        columns={platformColumns}
        rows={platforms}
        rowKey={agent => agent.key}
        maxHeight="none"
        empty={<EmptyState title="No platform data yet" description="The split by platform appears once the usage ledger has been read." />}
      />
    )
  } else if (active === 'sessions') {
    content = (
      <>
        {sessionsOnlyNotice && (
          <div className={styles.pad}>
            <Notice tone="warning">{sessionsOnlyNotice}</Notice>
          </div>
        )}
        <p className={styles.sessionsLine}>
          {activeSessionCount === 0
            ? 'No session is running now; these are the heaviest recent ones.'
            : `${activeSessionCount} ${activeSessionCount === 1 ? 'session is' : 'sessions are'} running now; the heaviest recent sessions are listed.`}
          {sessionsWithoutTokens > 0 && ` ${sessionsWithoutTokens} more ${sessionsWithoutTokens === 1 ? 'has' : 'have'} no token count and ${sessionsWithoutTokens === 1 ? 'is' : 'are'} not listed.`}
        </p>
        <DataTable
          caption="Heaviest recent sessions by tokens"
          columns={sessionColumns}
          rows={sessions}
          rowKey={session => session.sessionId}
          maxHeight="none"
          empty={<EmptyState title="No session with a token count" description="Sessions appear here once the gateway reports their tokens." />}
        />
      </>
    )
  } else {
    content = (
      <DataTable
        caption="Usage by model"
        columns={modelColumns}
        rows={models}
        rowKey={item => item.name}
        maxHeight="none"
        empty={<EmptyState title="No model usage yet" description="Models appear here once usage is recorded for this period." />}
      />
    )
  }

  return (
    <Panel
      title="Drivers"
      description="What the usage and spend came from."
      padding="none"
    >
      <div className={styles.tabsRow}>
        <Tabs
          ariaLabel="Driver views"
          tabs={tabs}
          value={active}
          onChange={id => setTab(id as DriverTab)}
        />
      </div>
      {content}
    </Panel>
  )
}
