import { useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import {
  Button,
  DataTable,
  Drawer,
  EmptyState,
  ErrorState,
  Freshness,
  Meter,
  Mono,
  Notice,
  Page,
  Panel,
  Select,
  Skeleton,
  Stat,
  StatePill,
  StatRow,
  TimeAgo,
} from '../components/ui'
import type { DataTableColumn } from '../components/ui'
import { worstState } from '../lib/state'
import type { UiState } from '../lib/state'
import { fetchJson, useApi } from '../lib/hooks'
import { nextTokenUsageRefetch, shouldRetryTokenUsageFast } from './ollamaTokenRetry'
import type { TokenUsageRetryState } from './ollamaTokenRetry'
import {
  describeTokenUsage,
  finiteNumber,
  formatMiB,
  formatSize,
  formatTokens,
  aggregateLocalTokenUsage,
  canonicalLocalModelName,
  countUnknownLocality,
  splitLocalTokens,
} from './ollamaFormat'
import type { TokenServiceUsage } from './ollamaFormat'
import styles from './OllamaMonitor.module.css'

type OllamaModel = {
  name: string
  status: 'running' | 'ready'
  sizeLabel?: string | null
  digest?: string | null
  parameterSize?: string | null
  quantization?: string | null
  format?: string | null
  family?: string | null
  keepAlive?: string | null
  expiresAt?: string | null
  loadedAt?: string | null
}

type OllamaGpuDevice = {
  index: string
  name: string
  vendor?: string | null
  cores?: string | null
  utilGpu?: number | null
  /** Apple tiler utilization (not memory utilization). */
  tilerUtilPercent?: number | null
  /** Unified memory allocated to the GPU; not the hardware total. */
  memAllocatedMiB?: number | null
  /** Hardware capacity; null where the probe cannot measure it. */
  memHardwareTotalMiB?: number | null
  memUsedMiB?: number | null
  tempC?: number | null
  powerDraw?: number | null
  powerLimit?: number | null
  memUsedEstimate?: boolean
  metricSource?: string | null
  /** The server's plain-words note on what the counters measure. */
  metricSourceNote?: string | null
}

type OllamaGpu = {
  available: boolean
  platform?: string
  limited?: boolean
  limitation?: string
  error?: string
  tried?: string[]
  devices?: OllamaGpuDevice[]
}

type OllamaAlert = {
  code: string
  severity: 'critical' | 'warning' | string
  message: string
  triggeredAt: string
  suppressed: boolean
  cooldownUntil: string
}

type OllamaTelemetryHistoryItem = {
  generatedAt: string
  healthScore: number
  status: 'online' | 'degraded' | 'offline'
  latencyMs: number | null
  memoryUsedPercent: number
  cpuUsagePercent: number
  gpuUtilPercent?: number | null
  gpuMemoryPercent?: number | null
  runningModels: number
  totalModels: number
  alerts: OllamaAlert[]
}

type OllamaTelemetryHistoryResponse = {
  generatedAt: string
  history: OllamaTelemetryHistoryItem[]
  total: number
}

type OllamaModelTelemetryItem = {
  name: string
  requestCount: number | null
  errorCount: number | null
  errorRate: number | null
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  requestsPerMinute: number | null
  status: string
  estimated: boolean
}

type OllamaModelTelemetryResponse = {
  generatedAt: string
  mode: string
  estimated: boolean
  telemetrySource: string
  limitations?: string[]
  windowMs: number | null
  models: OllamaModelTelemetryItem[]
}

type TokenUsageResponse = {
  source?: string
  period?: { key?: string; start?: string | null; end?: string | null }
  summary?: {
    periodTokens?: number
    totalTokens?: number
  }
  byService?: TokenServiceUsage[]
  meta?: {
    updatedAt?: string
    refreshing?: boolean
    stale?: boolean
    ageMs?: number
    refreshStartedAt?: string
    preservedPreviousOpenClaw?: boolean
    preservedPreviousUsage?: boolean
  }
}

type OllamaTelemetry = {
  generatedAt: string
  healthScore: number
  alerts: OllamaAlert[]
  server: {
    baseUrl: string
    status: 'online' | 'degraded' | 'offline'
    enabled: boolean
    host: string
    port: number
    latencyMs?: number | null
    version?: string | null
    checks?: {
      ps: { ok: boolean; error?: string | null }
      tags: { ok: boolean; error?: string | null }
      version: { ok: boolean; error?: string | null }
    }
    error?: string | null
  }
  runtime: {
    runningModels: number
    totalModels: number
    canAcceptRequests: boolean
  }
  models: OllamaModel[]
  system: {
    cpu: {
      cores: number
      load1: number
      load5: number
      load15: number
      usagePercent: number
    }
    memory: {
      totalBytes: number
      freeBytes: number
      usedBytes: number
      usedPercent: number
    }
    node: {
      uptimeSeconds: number
    }
    measuredAt: string
  }
  gpu?: OllamaGpu
}

type UsagePeriod = 'day' | '7d' | 'month'

const PERIOD_OPTIONS: { value: UsagePeriod; label: string }[] = [
  { value: 'day', label: 'Today' },
  { value: '7d', label: 'Last 7 days' },
  { value: 'month', label: 'This month' },
]

function presentText(value?: string | null): string | null {
  const text = String(value || '').trim()
  return text && text !== '—' ? text : null
}

/** "0 GB" (cloud-hosted entries) carries no information; treat it as not read. */
function presentSize(value?: string | null): string | null {
  const text = presentText(value)
  if (!text || /^0(\.0+)?\s*[a-z]*$/i.test(text)) return null
  return text
}

function modelMetaParts(model: OllamaModel) {
  return [model.parameterSize, model.quantization, model.format].map(presentText).filter(Boolean) as string[]
}

function hasAnyGpuMetricValue(
  devices?: OllamaGpuDevice[],
  options?: {
    includeEstimated?: boolean
  },
): boolean {
  if (!devices?.length) return false
  const includeEstimated = options?.includeEstimated ?? false
  return devices.some((device) => {
    const memUsed = Number.isFinite(device.memUsedMiB as number) && (!device.memUsedEstimate || includeEstimated)
      ? device.memUsedMiB
      : null
    return [device.utilGpu, device.tilerUtilPercent, device.tempC, device.powerDraw, device.powerLimit, memUsed].some((value) => Number.isFinite(value as number))
  })
}

function scoreState(score: number | null): UiState {
  if (score === null) return 'unavailable'
  if (score >= 85) return 'healthy'
  if (score >= 60) return 'warning'
  return 'critical'
}

function percentState(percent: number | null): UiState | undefined {
  if (percent === null) return undefined
  if (percent >= 92) return 'critical'
  if (percent >= 80) return 'warning'
  return undefined
}

function serverState(status: string): UiState {
  if (status === 'online') return 'healthy'
  if (status === 'degraded') return 'warning'
  if (status === 'offline') return 'critical'
  return 'unavailable'
}

function formatMetric(value?: number | null, digits = 2) {
  if (!Number.isFinite(value as number)) return '—'
  return Number(value).toFixed(digits)
}

function formatErrorRate(rate?: number | null) {
  if (!Number.isFinite(rate as number)) return '—'
  return (Number(rate) * 100).toFixed(1) + '%'
}

/** Health-score trend: absolute 0-100 scale, so a flat line near the top reads as flat. */
function HealthSpark({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const width = 100
  const height = 24
  const points = values
    .map((v, index) => {
      const x = (index / (values.length - 1)) * width
      const y = height - (Math.max(0, Math.min(100, v)) / 100) * height
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')
  return (
    <svg
      className={styles.spark}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Health score over the last ${values.length} readings`}
    >
      <polyline points={points} className={styles.sparkLine} />
    </svg>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.detailRow}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

const MISSING = <Mono muted>—</Mono>

export default function OllamaMonitor() {
  const { data, loading, error, refetch: refetchTelemetry } = useApi<OllamaTelemetry>('/api/ollama/telemetry', 2500)
  const { data: historyData, refetch: refetchHistory } = useApi<OllamaTelemetryHistoryResponse>('/api/ollama/telemetry/history', 5000)
  const { data: modelTelemetryData, refetch: refetchModelTelemetry } = useApi<OllamaModelTelemetryResponse>('/api/ollama/telemetry/models', 5000)
  const [usagePeriod, setUsagePeriod] = useState<UsagePeriod>('month')
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const tokenUsageRetry = useRef<TokenUsageRetryState | null>(null)
  const tokenUsageUrl = `/api/costs?period=${usagePeriod}`
  const tokenUsageQuery = useQuery<TokenUsageResponse, Error>({
    queryKey: ['api', tokenUsageUrl],
    queryFn: () => fetchJson<TokenUsageResponse>(tokenUsageUrl),
    refetchInterval: (query) => {
      const decision = nextTokenUsageRefetch(
        query.state.data as TokenUsageResponse | undefined,
        usagePeriod,
        tokenUsageRetry.current,
        Date.now(),
      )
      tokenUsageRetry.current = decision.state
      return decision.interval
    },
    refetchOnWindowFocus: false,
  })

  const tokenUsageData = tokenUsageQuery.data ?? null
  const tokenUsageError = tokenUsageQuery.error ? String(tokenUsageQuery.error.message || 'Unknown error') : null
  const tokenUsageFastRetrying = !tokenUsageError && shouldRetryTokenUsageFast(tokenUsageData)

  const models = useMemo(() => {
    const list = data?.models || []
    // Loaded models first; otherwise keep the server's order.
    return [...list].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'))
  }, [data?.models])
  const modelMetrics = useMemo(() => modelTelemetryData?.models || [], [modelTelemetryData?.models])
  const modelTelemetryIsEstimated = !!modelTelemetryData?.estimated
  // Per-model request and error figures exist only when the API actually measured them.
  const requestFiguresMeasured =
    !modelTelemetryIsEstimated &&
    modelMetrics.some((metric) => finiteNumber(metric.requestsPerMinute) !== null || finiteNumber(metric.errorRate) !== null)
  const requestFiguresUnmeasured = !!modelTelemetryData && !modelTelemetryIsEstimated && !requestFiguresMeasured
  const modelMetricMap = useMemo(() => new Map(modelMetrics.map((metric) => [metric.name, metric])), [modelMetrics])
  const modelTokenUsageMap = useMemo(() => aggregateLocalTokenUsage(tokenUsageData?.byService || []), [tokenUsageData?.byService])
  const unknownLocality = useMemo(() => countUnknownLocality(tokenUsageData?.byService || []), [tokenUsageData?.byService])
  const tokenSplit = useMemo(
    () =>
      splitLocalTokens(
        modelTokenUsageMap,
        new Set(models.map((model) => canonicalLocalModelName(model.name))),
      ),
    [modelTokenUsageMap, models],
  )
  const probeSamples = useMemo(() => {
    const counts = modelMetrics.map((metric) => finiteNumber(metric.requestCount)).filter((n): n is number => n !== null)
    return counts.length ? Math.max(...counts) : null
  }, [modelMetrics])
  const runningModelNames = useMemo(() => models.filter((model) => model.status === 'running').map((model) => model.name).filter(Boolean), [models])
  const latestLoadedAt = useMemo(() => {
    let latest = ''
    for (const model of models) {
      if (model.loadedAt && model.loadedAt > latest) latest = model.loadedAt
    }
    return latest || null
  }, [models])
  const healthTrend = useMemo(() => {
    return (historyData?.history || [])
      .map((item) => item.healthScore)
      .filter((score) => Number.isFinite(score))
      .slice(-20)
  }, [historyData?.history])

  const getModelTokenUsage = (name: string) => modelTokenUsageMap.get(canonicalLocalModelName(name))

  const handleRefresh = async () => {
    setRefreshing(true)
    try {
      await Promise.all([
        refetchTelemetry(),
        refetchHistory(),
        refetchModelTelemetry(),
        tokenUsageQuery.refetch(),
      ])
    } finally {
      setRefreshing(false)
    }
  }

  const refreshButton = (
    <Button size="sm" icon={<RefreshCw size={14} aria-hidden="true" />} loading={refreshing} onClick={handleRefresh}>
      Refresh
    </Button>
  )

  if (loading && !data) {
    return (
      <Page title="Local models" description="Reading Ollama. The first read can take 10–15 seconds.">
        <Skeleton variant="block" label="Reading Ollama telemetry" />
      </Page>
    )
  }

  if (!data) {
    return (
      <Page title="Local models" description="Is Ollama OK?">
        <ErrorState
          title="Ollama telemetry could not be read"
          message={error || undefined}
          onRetry={() => void refetchTelemetry()}
        />
      </Page>
    )
  }

  const gpu = data.gpu
  const gpuDevices = gpu?.devices || []
  const firstGpuDevice = gpuDevices[0]
  const hasLiveGpuMetrics = hasAnyGpuMetricValue(gpuDevices, { includeEstimated: false })
  const gpuLoad = finiteNumber(firstGpuDevice?.utilGpu)

  const healthScore = finiteNumber(data.healthScore)
  const memPercent = finiteNumber(data.system?.memory?.usedPercent)
  const alerts = data.alerts || []
  const status = data.server.status
  // Unknown stays unknown: only an explicit false is "not accepting requests".
  const canAccept = typeof data.runtime.canAcceptRequests === 'boolean' ? data.runtime.canAcceptRequests : null
  const alertState: UiState = alerts.some((a) => a.severity === 'critical') ? 'critical' : alerts.length ? 'warning' : 'healthy'
  const verdictState = worstState([
    serverState(status),
    scoreState(healthScore),
    alertState,
    canAccept === null ? 'unavailable' : canAccept ? 'healthy' : 'warning',
  ])
  let verdictText = 'Ollama is running normally'
  if (status === 'offline') verdictText = 'Ollama is not responding'
  else if (status === 'degraded') verdictText = 'Ollama is degraded'
  else if (status !== 'online') verdictText = 'Ollama status could not be read'
  else if (canAccept === false) verdictText = 'Ollama is running but not accepting requests'
  else if (alerts.length) verdictText = `Ollama is running with ${alerts.length} active alert${alerts.length === 1 ? '' : 's'}`
  else if (canAccept === null) verdictText = 'Ollama is running, but it did not report whether it accepts requests'
  else if (verdictState !== 'healthy') verdictText = 'Ollama is running with a low health score'

  const verdict = (
    <span className={styles.verdict}>
      <StatePill state={verdictState} label={verdictText} />
      <Freshness observedAt={data.generatedAt} staleAfterMs={60_000} />
    </span>
  )

  const periodLabel = PERIOD_OPTIONS.find((option) => option.value === usagePeriod)?.label || ''
  const selectedModel = selectedName ? models.find((model) => model.name === selectedName) || null : null
  const selectedMetric = selectedModel ? modelMetricMap.get(selectedModel.name) : undefined
  const selectedUsage = selectedModel ? getModelTokenUsage(selectedModel.name) : undefined

  const columns: DataTableColumn<OllamaModel>[] = [
    {
      key: 'name',
      header: 'Model',
      cell: (model) => {
        const meta = modelMetaParts(model)
        return (
          <span className={styles.modelCell}>
            <Mono truncate>{model.name}</Mono>
            {meta.length > 0 ? <span className={styles.modelMeta}>{meta.join(' · ')}</span> : null}
          </span>
        )
      },
    },
    {
      key: 'state',
      header: 'State',
      width: '120px',
      cell: (model) =>
        model.status === 'running' ? (
          <StatePill state="healthy" label="Loaded" />
        ) : (
          <span className={styles.quiet}>Not loaded</span>
        ),
    },
    {
      key: 'size',
      header: 'Size',
      align: 'end',
      mono: true,
      width: '112px',
      cell: (model) => presentSize(model.sizeLabel) || '—',
    },
    {
      key: 'tokens',
      header: 'Tokens',
      align: 'end',
      mono: true,
      width: '112px',
      mobileLabel: `Tokens (${periodLabel.toLowerCase()})`,
      cell: (model) => {
        const usage = getModelTokenUsage(model.name)
        return usage && usage.tokens > 0 ? formatTokens(usage.tokens) : '—'
      },
    },
  ]
  if (requestFiguresMeasured) {
    columns.push(
      {
        key: 'rate',
        header: 'Requests/min',
        align: 'end',
        mono: true,
        width: '128px',
        cell: (model) => {
          const rate = finiteNumber(modelMetricMap.get(model.name)?.requestsPerMinute)
          return rate !== null ? formatMetric(rate, 2) : '—'
        },
      },
      {
        key: 'errors',
        header: 'Error rate',
        align: 'end',
        mono: true,
        width: '112px',
        cell: (model) => formatErrorRate(modelMetricMap.get(model.name)?.errorRate),
      },
    )
  }

  const tokenNote = tokenUsageError ? (
    <Notice tone="warning" title="Token usage could not be read">
      {tokenUsageError}
    </Notice>
  ) : tokenUsageData?.meta?.stale ? (
    <Notice tone="warning" title="Token counts come from a stale cache">
      Last updated <TimeAgo value={tokenUsageData.meta.updatedAt} />.{tokenUsageData.meta.refreshing ? ' Refreshing now.' : ''}
    </Notice>
  ) : tokenUsageData && (tokenUsageData.meta?.refreshing || tokenUsageFastRetrying) ? (
    <Notice title="Token counts are still refreshing">Totals may rise when the refresh finishes.</Notice>
  ) : null

  const panelDescription = tokenUsageData
    ? describeTokenUsage(tokenSplit, periodLabel, unknownLocality)
    : tokenUsageQuery.isFetching && !tokenUsageError
      ? 'Reading token usage…'
      : undefined

  const gpuMetricsNote = [
    gpu?.limited || gpu?.platform === 'darwin' ? presentText(gpu?.limitation) : null,
    firstGpuDevice?.memUsedEstimate
      ? 'Memory is estimated from the size of the loaded models; this system does not expose per-process GPU memory.'
      : null,
    // What the counters measure, in the server's own words.
    presentText(firstGpuDevice?.metricSourceNote),
  ].filter(Boolean) as string[]

  return (
    <Page title="Local models" description={verdict} actions={refreshButton}>
      {alerts.length > 0 ? (
        <Notice tone={alertState} title={`${alerts.length} active alert${alerts.length === 1 ? '' : 's'}`}>
          <ul className={styles.alertList}>
            {alerts.map((alert) => (
              <li key={`${alert.code}-${alert.triggeredAt}`}>
                {alert.message}
                {alert.suppressed ? ' (cooldown)' : ''}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {data.server.error ? (
        <Notice tone="warning" title="Ollama reported a problem">
          {data.server.error}
        </Notice>
      ) : null}

      {error ? (
        <Notice tone="warning" title="The latest refresh failed">
          Showing the last reading. {error}
        </Notice>
      ) : null}

      <StatRow aria-label="Ollama readings">
        <Stat
          label="Health"
          value={healthScore !== null ? Math.round(healthScore) : null}
          unit="/ 100"
          state={verdictState !== 'healthy' ? scoreState(healthScore) : undefined}
          hint={
            <>
              <span className={styles.hintLine}>
                {data.server.baseUrl}
                {data.server.version ? ` · v${data.server.version}` : ''}
              </span>
              <HealthSpark values={healthTrend} />
            </>
          }
        />
        <Stat
          label="Memory"
          value={memPercent !== null ? Math.round(memPercent) : null}
          unit="%"
          state={percentState(memPercent)}
          hint={
            finiteNumber(data.system?.memory?.usedBytes) !== null && finiteNumber(data.system?.memory?.totalBytes) !== null
              ? `${formatSize(data.system.memory.usedBytes)} of ${formatSize(data.system.memory.totalBytes)}`
              : undefined
          }
        />
        <Stat
          label="GPU load"
          value={gpuLoad !== null ? Math.round(gpuLoad) : null}
          unit="%"
          hint={firstGpuDevice?.name || 'No GPU metrics'}
        />
        <Stat
          label="Models loaded"
          value={finiteNumber(data.runtime.runningModels)}
          unit={finiteNumber(data.runtime.totalModels) !== null ? `of ${data.runtime.totalModels}` : undefined}
          hint={
            runningModelNames.length
              ? runningModelNames.join(', ')
              : latestLoadedAt
                ? (
                  <>
                    None loaded · last load <TimeAgo value={latestLoadedAt} />
                  </>
                )
                : 'None loaded'
          }
        />
      </StatRow>

      {(!gpu?.available || gpuDevices.length === 0) && (gpu?.error || gpu?.limitation) ? (
        <Notice tone="unavailable" title="GPU metrics could not be read">
          {[gpu?.error, gpu?.limitation].filter(Boolean).join(' · ')}
          {gpu?.tried?.length ? ` Commands tried: ${gpu.tried.join(', ')}.` : ''}
        </Notice>
      ) : null}

      {modelTelemetryIsEstimated ? (
        <Notice title="Request figures are not measured per model">
          Mission Control samples Ollama&rsquo;s health probe
          {probeSamples !== null && finiteNumber(modelTelemetryData?.windowMs) !== null
            ? ` (${probeSamples} samples in the last ${Math.round((modelTelemetryData?.windowMs ?? 0) / 60000)} min)`
            : ''}
          {' '}rather than reading a request log, so request and error counts are not shown per model.
          {finiteNumber(data.server.latencyMs) !== null ? ` Latest probe: ${data.server.latencyMs} ms.` : ''}
          {' '}Updated <TimeAgo value={modelTelemetryData?.generatedAt} />.
        </Notice>
      ) : null}

      {tokenNote}

      <Panel
        title="Models"
        description={panelDescription}
        padding="none"
        actions={
          <Select
            aria-label="Token usage period"
            title="Token usage period"
            value={usagePeriod}
            onChange={(event) => setUsagePeriod(event.target.value as UsagePeriod)}
            options={PERIOD_OPTIONS}
          />
        }
      >
        <DataTable
          caption="Local models"
          columns={columns}
          rows={models}
          rowKey={(model) => model.name}
          onRowClick={(model) => setSelectedName(model.name)}
          selectedKey={selectedName}
          maxHeight="none"
          empty={<EmptyState title="No models found" description="Ollama did not list any local models." />}
        />
        {requestFiguresUnmeasured ? (
          <p className={styles.tableNote}>
            Requests per minute and error rate are not shown: Ollama does not count requests per model.
          </p>
        ) : null}
      </Panel>

      {gpuDevices.length > 0 ? (
        <Panel title="GPU" description={hasLiveGpuMetrics ? undefined : 'Live GPU counters are not exposed on this system.'}>
          <div className={styles.gpuList}>
            {gpuDevices.map((device) => {
              const tilerUtil = finiteNumber(device.tilerUtilPercent)
              const memUsed = finiteNumber(device.memUsedMiB)
              const memAllocated = finiteNumber(device.memAllocatedMiB)
              const memHardware = finiteNumber(device.memHardwareTotalMiB)
              const tempC = finiteNumber(device.tempC)
              const powerDraw = finiteNumber(device.powerDraw)
              const powerLimit = finiteNumber(device.powerLimit)
              const subtitle = [device.vendor, device.cores ? `${device.cores} cores` : null].map(presentText).filter(Boolean).join(' · ')
              return (
                <div key={device.index} className={styles.gpuDevice}>
                  <p className={styles.gpuName}>
                    {device.name}
                    <span className={styles.gpuMeta}>{` GPU ${device.index}${subtitle ? ` · ${subtitle}` : ''}`}</span>
                  </p>
                  <dl className={styles.gpuGrid}>
                    {memUsed !== null ? (
                      <DetailRow label={device.memUsedEstimate ? 'Memory (estimated)' : 'Memory used'}>
                        <Mono>
                          {formatMiB(memUsed)}
                          {memAllocated !== null ? ` of ${formatMiB(memAllocated)} allocated` : ''}
                          {memHardware !== null ? ` · ${formatMiB(memHardware)} installed` : ''}
                        </Mono>
                        {memAllocated !== null ? (
                          <Meter value={memUsed} max={memAllocated} label="GPU memory used of allocated" />
                        ) : null}
                      </DetailRow>
                    ) : null}
                    {tilerUtil !== null ? <DetailRow label="Tiler load"><Mono>{Math.round(tilerUtil)}%</Mono></DetailRow> : null}
                    {tempC !== null ? <DetailRow label="Temperature"><Mono>{Math.round(tempC)} °C</Mono></DetailRow> : null}
                    {powerDraw !== null || powerLimit !== null ? (
                      <DetailRow label="Power">
                        <Mono>
                          {[powerDraw !== null ? `${Math.round(powerDraw)} W` : null, powerLimit !== null ? `${Math.round(powerLimit)} W limit` : null]
                            .filter(Boolean)
                            .join(' / ')}
                        </Mono>
                      </DetailRow>
                    ) : null}
                  </dl>
                </div>
              )
            })}
          </div>
          {gpuMetricsNote.length > 0 ? <p className={styles.note}>{gpuMetricsNote.join(' ')}</p> : null}
        </Panel>
      ) : null}

      <Drawer
        open={!!selectedModel}
        onClose={() => setSelectedName(null)}
        title={selectedModel?.name || 'Model'}
        description={selectedModel ? (selectedModel.status === 'running' ? 'Loaded in memory' : 'Available, not loaded') : undefined}
      >
        {selectedModel ? (
          <div className={styles.drawerBody}>
            <dl className={styles.detailList}>
              <DetailRow label="Size">{presentSize(selectedModel.sizeLabel) ? <Mono>{presentSize(selectedModel.sizeLabel)}</Mono> : MISSING}</DetailRow>
              <DetailRow label="Family">{presentText(selectedModel.family) ? <Mono>{selectedModel.family}</Mono> : MISSING}</DetailRow>
              <DetailRow label="Parameters">{presentText(selectedModel.parameterSize) ? <Mono>{selectedModel.parameterSize}</Mono> : MISSING}</DetailRow>
              <DetailRow label="Quantization">{presentText(selectedModel.quantization) ? <Mono>{selectedModel.quantization}</Mono> : MISSING}</DetailRow>
              <DetailRow label="Format">{presentText(selectedModel.format) ? <Mono>{selectedModel.format}</Mono> : MISSING}</DetailRow>
              <DetailRow label="Keep-alive">{presentText(selectedModel.keepAlive) ? <Mono>{selectedModel.keepAlive}</Mono> : MISSING}</DetailRow>
              <DetailRow label="Loaded">{selectedModel.loadedAt ? <TimeAgo value={selectedModel.loadedAt} /> : MISSING}</DetailRow>
              <DetailRow label="Unloads">{selectedModel.expiresAt ? <TimeAgo value={selectedModel.expiresAt} /> : MISSING}</DetailRow>
              <DetailRow label="Digest">{presentText(selectedModel.digest) ? <Mono className={styles.digest}>{selectedModel.digest}</Mono> : MISSING}</DetailRow>
            </dl>

            <section aria-label="Usage">
              <h3 className={styles.drawerHeading}>Usage · {periodLabel.toLowerCase()}</h3>
              <dl className={styles.detailList}>
                <DetailRow label="Tokens">
                  {selectedUsage && selectedUsage.tokens > 0 ? <Mono>{selectedUsage.tokens.toLocaleString()}</Mono> : MISSING}
                </DetailRow>
                <DetailRow label="Sessions">
                  {selectedUsage && selectedUsage.sessions > 0 ? <Mono>{selectedUsage.sessions}</Mono> : MISSING}
                </DetailRow>
                <DetailRow label="Used by">
                  {selectedUsage && selectedUsage.sources.length > 0 ? selectedUsage.sources.join(', ') : MISSING}
                </DetailRow>
                {requestFiguresMeasured && selectedMetric ? (
                  <>
                    <DetailRow label="Requests/min">
                      {finiteNumber(selectedMetric.requestsPerMinute) !== null ? <Mono>{formatMetric(selectedMetric.requestsPerMinute, 2)}</Mono> : MISSING}
                    </DetailRow>
                    <DetailRow label="Requests in window">
                      {finiteNumber(selectedMetric.requestCount) !== null ? <Mono>{selectedMetric.requestCount}</Mono> : MISSING}
                    </DetailRow>
                    <DetailRow label="Error rate">
                      {finiteNumber(selectedMetric.errorRate) !== null ? <Mono>{formatErrorRate(selectedMetric.errorRate)}</Mono> : MISSING}
                    </DetailRow>
                    <DetailRow label="p95 latency">
                      {finiteNumber(selectedMetric.p95LatencyMs) !== null ? <Mono>{formatMetric(selectedMetric.p95LatencyMs, 0)} ms</Mono> : MISSING}
                    </DetailRow>
                  </>
                ) : null}
              </dl>
            </section>
          </div>
        ) : null}
      </Drawer>
    </Page>
  )
}
