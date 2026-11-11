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
  formatCompactTokenValue,
  formatCurrency,
  formatPreciseCurrency,
  formatTokens,
} from './lib'
import type { AgentUsageData, AggregatedBreakdownItem } from './types'
import styles from './CostDriversSection.module.css'

export type DriverTab = 'aws' | 'models' | 'sources' | 'sessions'

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
  channel: string
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
  sources: AgentSplitItem[]
  sourcesPending: boolean
  totalSourceTokens: number
  sessions: TopSession[]
  /** Set when the period is a past month: sessions are live, not that month's. */
  sessionsLiveOnlyNotice: string | null
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
      return details ? `Partly tracked · ${details}` : 'Partly tracked'
    case 'Mixed':
      return details ? `Mixed · ${details}` : 'Mixed'
    default:
      return 'Not tracked'
  }
}

function apiEquivalentText(cost: number, available: boolean) {
  return available && Number.isFinite(cost) ? formatPreciseCurrency(cost) : '—'
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

function TokenCell({ tokens }: { tokens: number }) {
  return <span title={`${formatTokens(tokens)} tokens`}>{formatCompactTokenValue(tokens)}</span>
}

export default function CostDriversSection({
  tab,
  setTab,
  models,
  modelApiEquivalentTotal,
  sources,
  sourcesPending,
  totalSourceTokens,
  sessions,
  sessionsLiveOnlyNotice,
  awsServices,
}: CostDriversSectionProps) {
  const hasSources = sourcesPending || sources.length > 0
  const tabs: Array<{ id: DriverTab; label: string }> = [
    ...(awsServices ? [{ id: 'aws' as const, label: 'By AWS service' }] : []),
    { id: 'models', label: 'By model' },
    ...(hasSources ? [{ id: 'sources' as const, label: 'By source' }] : []),
    { id: 'sessions', label: 'Live sessions' },
  ]
  const fallbackTab: DriverTab = awsServices ? 'aws' : 'models'
  const active: DriverTab = tab && tabs.some(item => item.id === tab) ? tab : fallbackTab

  const modelColumns: DataTableColumn<AggregatedBreakdownItem>[] = [
    {
      key: 'model',
      header: 'Model',
      cell: item => (
        <span className={styles.name}>
          <span className={styles.nameText}>{item.name}</span>
          {item.local && <span className={styles.tag}>Local</span>}
          {item.rawNames.length > 1 && <span className={styles.tag}>{item.rawNames.length} variants</span>}
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
    { key: 'tracked', header: 'Tracked spend', align: 'end', mono: true, cell: item => formatCurrency(item.cost) },
  ]

  const sourceColumns: DataTableColumn<AgentSplitItem>[] = [
    {
      key: 'source',
      header: 'Source',
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
      key: 'api',
      header: 'API equivalent',
      align: 'end',
      mono: true,
      cell: agent => apiEquivalentText(agent.apiEquivalentCost, agent.apiEquivalentAvailable),
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
          pct={totalSourceTokens > 0 ? (agent.tokens / totalSourceTokens) * 100 : null}
        />
      ),
    },
    { key: 'tokens', header: 'Tokens', align: 'end', mono: true, cell: agent => <TokenCell tokens={agent.tokens} /> },
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
          <span className={styles.nameText}>{session.sessionName}</span>
          <span className={styles.sub}>{session.channel}</span>
        </span>
      ),
    },
    { key: 'model', header: 'Model', cell: session => session.model },
    { key: 'tokens', header: 'Tokens', align: 'end', mono: true, cell: session => <TokenCell tokens={session.tokens} /> },
    {
      key: 'updated',
      header: 'Updated',
      align: 'end',
      cell: session => <TimeAgo value={session.timestamp === null ? null : session.timestamp * 1000} />,
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
        maxHeight="520px"
        empty={<EmptyState title="No AWS services billed" description="Live billing returned no services for this period." />}
      />
    )
  } else if (active === 'sources') {
    content = sourcesPending ? (
      <div className={styles.pad}>
        <Skeleton variant="block" label="Loading usage by source" />
      </div>
    ) : (
      <DataTable
        caption="Usage by source"
        columns={sourceColumns}
        rows={sources}
        rowKey={agent => agent.key}
        maxHeight="520px"
        empty={<EmptyState title="No source data yet" description="Usage by source appears once the usage ledger has been read." />}
      />
    )
  } else if (active === 'sessions') {
    content = (
      <>
        {sessionsLiveOnlyNotice && (
          <div className={styles.pad}>
            <Notice tone="warning">{sessionsLiveOnlyNotice}</Notice>
          </div>
        )}
        <DataTable
          caption="Heaviest live sessions by tokens"
          columns={sessionColumns}
          rows={sessions}
          rowKey={session => session.sessionId}
          maxHeight="520px"
          empty={<EmptyState title="No session load yet" description="Sessions with token usage appear here while they are live." />}
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
        maxHeight="520px"
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
