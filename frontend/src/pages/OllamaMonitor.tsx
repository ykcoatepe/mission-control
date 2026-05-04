import { useEffect, useMemo, useState } from 'react'
import { Server, Activity, Cpu, HardDrive, RefreshCw, CircleAlert, Clock3, Settings2, Save, Wand2, Copy, ChevronDown, ChevronUp } from 'lucide-react'
import PageTransition from '../components/PageTransition'
import GlassCard from '../components/GlassCard'
import StatusBadge from '../components/StatusBadge'
import { useApi } from '../lib/hooks'
import { useIsMobile } from '../lib/useIsMobile'

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
  utilMemory?: number | null
  memTotalMiB?: number | null
  memUsedMiB?: number | null
  memFreeMiB?: number | null
  tempC?: number | null
  powerDraw?: number | null
  powerLimit?: number | null
  memUsedEstimate?: boolean
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

type OllamaOptimizationProfile = {
  enabled: boolean
  strategy: 'conservative' | 'balanced' | 'performance'
  keepAlive: string
  maxLoadedModels: number
  numCtx: number
  numParallel: number
}

type OllamaOptimizationRecommendation = OllamaOptimizationProfile & {
  reasons: string[]
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
  requestCount: number
  errorCount: number
  errorRate: number
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  requestsPerMinute: number
  status: string
  estimated: boolean
}

type OllamaModelTelemetryResponse = {
  generatedAt: string
  mode: string
  estimated: boolean
  telemetrySource: string
  windowMs: number
  models: OllamaModelTelemetryItem[]
}

type OllamaOptimizationPayload = {
  enabled: boolean
  current: OllamaOptimizationProfile
  recommendation: OllamaOptimizationRecommendation
  applyCommands: string[]
  platform: string
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
  optimization?: OllamaOptimizationPayload
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

function toNumberOrNull(value?: number | null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function formatBytes(bytes?: number | null) {
  if (!Number.isFinite(bytes || NaN) || (bytes || 0) <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Number(bytes)
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(index === 0 ? 0 : 2)} ${units[index]}`
}

function formatMiB(v?: number | null) {
  if (!Number.isFinite(v || NaN) || (v || 0) <= 0) return '—'
  return `${v} MB`
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
    return [device.utilGpu, device.utilMemory, device.tempC, device.powerDraw, device.powerLimit, memUsed].some((value) => Number.isFinite(value as number))
  })
}

function formatTime(dateStr?: string | null) {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function statusColor(status: string) {
  return status === 'online' ? 'ok' : status === 'degraded' ? 'idle' : 'error'
}

function healthColor(score: number) {
  if (score >= 85) return '#34C759'
  if (score >= 60) return '#FF9F0A'
  return '#FF453A'
}

function formatMetric(value?: number | null, digits = 2) {
  if (!Number.isFinite(value as number)) return '—'
  return Number(value).toFixed(digits)
}

function errorMessage(err: unknown, fallback: string) {
  return err instanceof Error ? err.message : fallback
}

function formatErrorRate(rate?: number | null) {
  if (!Number.isFinite(rate as number)) return '0.0%'
  return (Number(rate) * 100).toFixed(1) + '%'
}

function summarizePercentTrend(values: number[]) {
  const valid = values.filter((v) => Number.isFinite(v))
  if (!valid.length) return '—'
  const current = valid[valid.length - 1]
  const min = Math.min(...valid)
  const max = Math.max(...valid)
  return `Now ${Math.round(current)}% · Min ${Math.round(min)}% · Max ${Math.round(max)}%`
}

function safeProfile(current: OllamaOptimizationProfile): OllamaOptimizationProfile {
  return {
    enabled: !!current?.enabled,
    strategy: current?.strategy === 'conservative' || current?.strategy === 'performance' ? current.strategy : 'balanced',
    keepAlive: String(current?.keepAlive || '5m').trim(),
    maxLoadedModels: Number.isFinite(current?.maxLoadedModels as number) ? Number(current?.maxLoadedModels) : 2,
    numCtx: Number.isFinite(current?.numCtx as number) ? Number(current?.numCtx) : 2048,
    numParallel: Number.isFinite(current?.numParallel as number) ? Number(current?.numParallel) : 1,
  }
}

function renderSparkline(values: number[], color: string, gradientId: string) {
  if (!values.length) {
    return <div style={{ margin: 0, fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>Henüz metrik yok</div>
  }
  if (values.length === 1) {
    return (
      <p style={{ margin: 0, fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
        {`${Math.round(values[0])}%`}
      </p>
    )
  }

  const width = 260
  const height = 44
  const pad = 6
  const clamped = values.map((v) => Math.max(0, Math.min(100, v)))
  const min = Math.min(...clamped)
  const max = Math.max(...clamped)
  const span = Math.max(1, max - min)
  const points = clamped
    .map((v, index) => {
      const x = (index / (clamped.length - 1)) * width
      const y = (height - pad) - ((v - min) / span) * (height - pad * 2)
      return `${x},${y}`
    })
    .join(' ')

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: '100%', height: '52px', display: 'block' }}>
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.45" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline
        points={`0,${height - pad} ${points} ${width},${height - pad}`}
        fill={`url(#${gradientId})`}
        opacity={0.25}
      />
      <polyline points={points} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function OllamaLoadingState({ isMobile }: { isMobile: boolean }) {
  const panelStyle = {
    padding: isMobile ? 14 : 18,
    minHeight: 118,
    display: 'flex',
    flexDirection: 'column' as const,
    justifyContent: 'space-between',
    gap: 14,
  }
  const shimmer = {
    borderRadius: 999,
    background: 'linear-gradient(90deg, rgba(255,255,255,0.08), rgba(255,255,255,0.18), rgba(255,255,255,0.08))',
    backgroundSize: '220% 100%',
    animation: 'shimmer 1.4s ease-in-out infinite',
  }

  return (
    <PageTransition>
      <div style={{ maxWidth: 1240, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div>
            <h1 className="text-title">Ollama Monitor</h1>
            <p className="text-body" style={{ marginTop: 4 }}>
              Loading local model telemetry. Ollama is often a 10-15s check on first paint.
            </p>
          </div>
          <StatusBadge status="idle" label="Loading" />
        </div>

        <GlassCard delay={0.04} noPad>
          <div style={{ padding: isMobile ? 16 : 22, display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ width: 28, height: 28, border: '2px solid #007AFF', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 1s linear infinite', flexShrink: 0 }} />
            <div>
              <p style={{ margin: 0, color: 'rgba(255,255,255,0.9)', fontSize: 14, fontWeight: 700 }}>Checking local inference health</p>
              <p style={{ margin: '4px 0 0', color: 'rgba(255,255,255,0.56)', fontSize: 12 }}>Server, loaded models, GPU, memory, and optimization policy.</p>
            </div>
          </div>
        </GlassCard>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, minmax(0, 1fr))', gap: 12 }}>
          {['Server', 'Models', 'Memory', 'GPU'].map((label) => (
            <GlassCard key={label} delay={0.06} noPad>
              <div style={panelStyle}>
                <p style={{ margin: 0, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.48)' }}>{label}</p>
                <div style={{ ...shimmer, width: '68%', height: 14 }} />
                <div style={{ ...shimmer, width: '42%', height: 10, opacity: 0.7 }} />
              </div>
            </GlassCard>
          ))}
        </div>
      </div>
    </PageTransition>
  )
}

export default function OllamaMonitor() {
  const m = useIsMobile()
  const { data, loading, error, refetch } = useApi<OllamaTelemetry>('/api/ollama/telemetry', 2500)
  const { data: historyData } = useApi<OllamaTelemetryHistoryResponse>('/api/ollama/telemetry/history', 5000)
  const { data: modelTelemetryData } = useApi<OllamaModelTelemetryResponse>('/api/ollama/telemetry/models', 5000)
  const [gpuUtilHistory, setGpuUtilHistory] = useState<number[]>([])
  const [gpuMemHistory, setGpuMemHistory] = useState<number[]>([])
  const [optimizationProfile, setOptimizationProfile] = useState<OllamaOptimizationProfile | null>(null)
  const [isSavingOptimization, setIsSavingOptimization] = useState(false)
  const [optimizationMessage, setOptimizationMessage] = useState('')
  const [optimizationDirty, setOptimizationDirty] = useState(false)
  const [isRollingBackOptimization, setIsRollingBackOptimization] = useState(false)
  const [expandedModels, setExpandedModels] = useState<Record<string, boolean>>({})

  const models = useMemo(() => data?.models || [], [data?.models])
  const modelMetrics = useMemo(() => modelTelemetryData?.models || [], [modelTelemetryData?.models])
  const modelMetricMap = useMemo(() => {
    return new Map(modelMetrics.map((metric) => [metric.name, metric]))
  }, [modelMetrics])
  const modelSummary = useMemo(() => {
    const totalModels = models.length
    const runningCount = models.filter((model) => model.status === 'running').length
    const avgErrorRate = modelMetrics.length
      ? modelMetrics.reduce((sum, metric) => sum + (Number.isFinite(metric.errorRate) ? Number(metric.errorRate) : 0), 0) / modelMetrics.length
      : 0
    const totalRequests = modelMetrics.reduce((sum, metric) => sum + (Number.isFinite(metric.requestCount) ? Number(metric.requestCount) : 0), 0)

    return {
      totalModels,
      runningCount,
      avgErrorRate,
      totalRequests,
    }
  }, [modelMetrics, models])
  const allModelsExpanded = models.length > 0 && models.every((model) => expandedModels[model.name])
  const runningModelNames = useMemo(() => {
    return models
      .filter((model) => model.status === 'running')
      .map((model) => model.name)
      .filter(Boolean)
  }, [models])
  const visibleRunningModelNames = runningModelNames.slice(0, 2)
  const hiddenRunningModelCount = Math.max(0, runningModelNames.length - visibleRunningModelNames.length)
  const latestModelAt = useMemo(() => {
    let latest = ''
    for (const model of models) {
      const candidate = model.loadedAt || model.expiresAt || ''
      if (candidate && candidate > latest) latest = candidate
    }
    return latest ? formatTime(latest) : '—'
  }, [models])

  const gpu = data?.gpu
  const gpuHasDevices = !!gpu?.devices?.length
  const hasLiveGpuMetrics = hasAnyGpuMetricValue(gpu?.devices || [], { includeEstimated: false })
  const hasAnyGpuMetrics = hasAnyGpuMetricValue(gpu?.devices || [], { includeEstimated: true })
  const hasEstimatedGpuMetrics = hasAnyGpuMetrics && !hasLiveGpuMetrics
  const gpuPlatform = gpu?.platform || 'linux'
  const gpuLabel = !gpuHasDevices
    ? 'Metrik Yok'
    : hasLiveGpuMetrics && !gpu?.limited
      ? 'Etkin'
      : hasEstimatedGpuMetrics
        ? 'Tahmini'
        : 'Kısmi'
  const gpuBadgeStatus = !gpu?.available || !gpuHasDevices ? 'error' : gpu?.limited ? 'idle' : 'ok'

  const optimization = data?.optimization
  const optimizationCurrent = optimization?.current
  const recommendation = optimization?.recommendation
  const platform = optimization?.platform || 'unknown'
  const healthScore = Number.isFinite(Number(data?.healthScore)) ? Number(data?.healthScore) : 0
  const alertNotes = useMemo(() => {
    return data?.alerts || []
  }, [data?.alerts])
  const healthHistory = useMemo(() => historyData?.history || [], [historyData?.history])
  const healthTrend = useMemo(() => {
    return healthHistory
      .map((item) => item.healthScore)
      .filter((score) => Number.isFinite(score))
      .slice(-20)
  }, [healthHistory])

  useEffect(() => {
    if (!optimizationCurrent) return
    if (optimizationDirty) return
    const normalized = safeProfile(optimizationCurrent)
    setOptimizationProfile(normalized)
  }, [optimizationCurrent, optimizationDirty])

  const updateOptimizationProfile = (next: Partial<OllamaOptimizationProfile>) => {
    setOptimizationProfile((prev) => {
      if (!prev) {
        return null
      }
      const updated = { ...prev, ...next }
      setOptimizationDirty(true)
      return updated
    })
  }

  const toggleModelExpanded = (name: string) => {
    setExpandedModels((prev) => ({
      ...prev,
      [name]: !prev[name],
    }))
  }

  const setAllModelsExpanded = (expanded: boolean) => {
    setExpandedModels(
      Object.fromEntries(models.map((model) => [model.name, expanded])),
    )
  }

  const textPrimary = 'rgba(255,255,255,0.92)'
  const textSecondary = 'rgba(255,255,255,0.6)'
  const textTertiary = 'rgba(255,255,255,0.45)'
  const panelBorder = '1px solid rgba(255,255,255,0.08)'
  const inputStyle = {
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.16)',
    background: 'rgba(0,0,0,0.22)',
    color: textPrimary,
    padding: '10px 12px',
    fontSize: 13,
    outline: 'none',
    width: '100%',
  }
  const fieldLabelStyle = {
    margin: 0,
    fontSize: 11,
    fontWeight: 600,
    color: textSecondary,
  }
  const metricLabelStyle = {
    margin: 0,
    fontSize: 11,
    color: textSecondary,
  }
  const metricValueStyle = {
    margin: '4px 0 0',
    fontSize: 18,
    fontWeight: 600,
    color: textPrimary,
  }
  const helperTextStyle = {
    margin: '4px 0 0',
    fontSize: 11,
    color: textTertiary,
  }
  const sectionTitleStyle = {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
    color: textPrimary,
  }

  const handleCopyCommands = async (commands: string[]) => {
    if (!commands.length) return
    await navigator.clipboard.writeText(commands.join('\n'))
    setOptimizationMessage('Uygulama komutları panoya kopyalandı.')
    setTimeout(() => setOptimizationMessage(''), 2500)
  }

  const applyRecommendationToForm = () => {
    if (!recommendation) return
    setOptimizationProfile(recommendation)
    setOptimizationDirty(true)
    setOptimizationMessage('Öneri forma yüklendi. Kaydetmeniz gerekiyor.')
    setTimeout(() => setOptimizationMessage(''), 2500)
  }

  const handleSaveOptimization = async () => {
    if (!optimizationProfile) return
    setIsSavingOptimization(true)
    setOptimizationMessage('')
    try {
      const dryRunResponse = await fetch('/api/ollama/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dry-run', profile: optimizationProfile }),
      })
      if (!dryRunResponse.ok) {
        const text = await dryRunResponse.text()
        throw new Error(text || `HTTP ${dryRunResponse.status}`)
      }
      const dryRun = await dryRunResponse.json()
      const changedKeys = Array.isArray(dryRun?.diff?.changed) ? dryRun.diff.changed : []
      const confirmed = window.confirm(
        changedKeys.length
          ? `Bu değişiklikler uygulanacak: ${changedKeys.join(', ')}. Onaylıyor musun?`
          : 'Değişiklik farkı bulunamadı. Yine de uygula?'
      )
      if (!confirmed) {
        setOptimizationMessage('Uygulama iptal edildi.')
        return
      }

      const applyResponse = await fetch('/api/ollama/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'apply', profile: optimizationProfile, confirm: true }),
      })
      if (!applyResponse.ok) {
        const text = await applyResponse.text()
        throw new Error(text || `HTTP ${applyResponse.status}`)
      }
      const applied = await applyResponse.json()
      const verifyOk = applied?.verification?.ok ? 'OK' : 'FAIL'
      setOptimizationDirty(false)
      setOptimizationMessage(`Ayarlar uygulandı. Post-apply verify: ${verifyOk}${applied?.verification?.latencyMs ? ` (${applied.verification.latencyMs}ms)` : ''}.`)
      await refetch()
    } catch (err: unknown) {
      setOptimizationMessage(errorMessage(err, 'Kaydetme başarısız'))
    } finally {
      setIsSavingOptimization(false)
      setTimeout(() => setOptimizationMessage(''), 4000)
    }
  }

  const handleRollbackOptimization = async () => {
    setIsRollingBackOptimization(true)
    setOptimizationMessage('')
    try {
      const confirmed = window.confirm('Son optimization değişikliğini geri alayım mı?')
      if (!confirmed) {
        setOptimizationMessage('Rollback iptal edildi.')
        return
      }
      const response = await fetch('/api/ollama/optimization', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'rollback', confirm: true }),
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || `HTTP ${response.status}`)
      }
      const rolled = await response.json()
      setOptimizationDirty(false)
      setOptimizationMessage(`Rollback tamamlandı. Verify: ${rolled?.verification?.ok ? 'OK' : 'FAIL'}`)
      await refetch()
    } catch (err: unknown) {
      setOptimizationMessage(errorMessage(err, 'Rollback başarısız'))
    } finally {
      setIsRollingBackOptimization(false)
      setTimeout(() => setOptimizationMessage(''), 4000)
    }
  }

  const historyGpuAvailable = data?.gpu?.available
  const historyGpuDevices = data?.gpu?.devices
  const historyGpuDevice = historyGpuDevices?.[0]
  const historyGpuUtil = historyGpuDevice?.utilGpu
  const historyGpuMemUsed = historyGpuDevice?.memUsedMiB
  const historyGpuMemTotal = historyGpuDevice?.memTotalMiB

  useEffect(() => {
    if (!historyGpuAvailable || !historyGpuDevices?.length) {
      setGpuUtilHistory([])
      setGpuMemHistory([])
      return
    }

    const device = historyGpuDevices[0]
    const utilValue = toNumberOrNull(device?.utilGpu)
    if (utilValue !== null) {
      setGpuUtilHistory((prev) => [...prev, utilValue].slice(-30))
    }

    const memUsed = toNumberOrNull(device?.memUsedMiB)
    const memTotal = toNumberOrNull(device?.memTotalMiB)
    if (memUsed !== null && memTotal !== null && memTotal > 0) {
      const memPercent = Math.max(0, Math.min(100, (memUsed / memTotal) * 100))
      if (Number.isFinite(memPercent)) {
        setGpuMemHistory((prev) => [...prev, memPercent].slice(-30))
      }
    }
  }, [historyGpuAvailable, historyGpuDevices, historyGpuUtil, historyGpuMemUsed, historyGpuMemTotal])

  if (loading && !data) {
    return <OllamaLoadingState isMobile={m} />
  }

  if (!data || error) {
    return (
      <PageTransition>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '400px', flexDirection: 'column', gap: 12 }}>
          <CircleAlert size={48} style={{ color: '#FF453A' }} />
          <p style={{ color: 'rgba(255,255,255,0.65)' }}>{error || 'Ollama telemetri verisi alınamadı'}</p>
          <button
            onClick={() => refetch()}
            style={{
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.22)',
              background: 'rgba(255,255,255,0.1)',
              color: 'rgba(255,255,255,0.92)',
              padding: '8px 14px',
              cursor: 'pointer',
            }}
          >
            Yeniden Dene
          </button>
        </div>
      </PageTransition>
    )
  }

  return (
    <PageTransition>
      <div style={{ maxWidth: 1240, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 className="text-title">Ollama Monitor</h1>
            <p className="text-body" style={{ marginTop: 4 }}>Local inference health, loaded models, and hardware headroom in one operational surface.</p>
          </div>
          <button
            onClick={() => refetch()}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              borderRadius: 8,
              border: '1px solid rgba(0,122,255,0.35)',
              background: 'rgba(0,122,255,0.1)',
              color: 'rgba(255,255,255,0.9)',
              padding: m ? '8px 10px' : '10px 12px',
              cursor: 'pointer',
            }}
          >
            <RefreshCw size={14} />
            Yenile
          </button>
        </div>

        <GlassCard delay={0.08} noPad>
          <div style={{ padding: m ? 14 : 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Activity size={16} />
              <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.92)' }}>GPU</h3>
            </div>
              <StatusBadge
                status={gpuBadgeStatus}
                label={gpuLabel === 'Metrik Yok' ? 'Metrik Yok' : `${gpuLabel}${data.gpu?.devices?.length ? ` (${data.gpu.devices.length})` : ''}`}
              />
              {(!data.gpu?.available || !data.gpu?.devices?.length) && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <p style={{ fontSize: 12, margin: 0, color: 'rgba(255,255,255,0.62)' }}>
                    {data.gpu?.error ? `GPU metriği alınamadı: ${data.gpu.error}` : 'GPU metriği görünmüyor.'}
                  </p>
                  {!!data.gpu?.limitation && (
                    <p style={{ fontSize: 11, margin: 0, color: 'rgba(255,255,255,0.55)' }}>
                      Not: {data.gpu.limitation}
                    </p>
                  )}
                  {!!data.gpu?.tried?.length && (
                    <p style={{ fontSize: 11, margin: 0, color: 'rgba(255,255,255,0.45)' }}>
                      Denenen komutlar: {data.gpu.tried.join(', ')}
                    </p>
                  )}
                </div>
              )}
              {data.gpu?.available && data.gpu?.devices?.length && hasEstimatedGpuMetrics && !hasLiveGpuMetrics && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <p style={{ fontSize: 12, margin: 0, color: 'rgba(255,255,255,0.62)' }}>
                    GPU cihazları bulundu, canlı metrikler alınamadığı için VRAM değeri mevcut model yükünden tahmin edilir.
                  </p>
                </div>
              )}
              {data.gpu?.available && data.gpu?.devices?.length && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
                  {(gpuPlatform === 'darwin' || data.gpu?.limited) && data.gpu?.limitation && (
                    <p style={{ margin: 0, fontSize: 11, color: 'rgba(255,255,255,0.75)' }}>
                      {data.gpu.limitation}
                    </p>
                  )}
                  {data.gpu.devices.map((device) => (
                    <div
                      key={device.index}
                      style={{
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 12,
                        padding: 12,
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: 12,
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ minWidth: 220 }}>
                        <p style={{ margin: 0, fontSize: 13, color: 'rgba(255,255,255,0.9)', fontWeight: 600 }}>{device.name}</p>
                        <p style={{ margin: 0, fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>GPU {device.index}</p>
                        {(device.vendor || device.cores) && (
                          <p style={{ margin: 0, fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
                            {device.vendor || 'Vendor bilinmiyor'}{device.cores ? ` · ${device.cores} çekirdek` : ''}
                          </p>
                        )}
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))', gap: 10, minWidth: 420 }}>
                        <div>
                          <p style={{ margin: 0, fontSize: 10, color: 'rgba(255,255,255,0.55)' }}>GPU Kullanımı</p>
                          <p style={{ margin: 0, fontSize: 12, color: 'rgba(255,255,255,0.92)' }}>{device.utilGpu ?? '—'}%</p>
                        </div>
                        <div>
                          <p style={{ margin: 0, fontSize: 10, color: 'rgba(255,255,255,0.55)' }}>VRAM</p>
                          <p style={{ margin: 0, fontSize: 11, color: device.memUsedEstimate ? 'rgba(255, 178, 24, 0.95)' : 'rgba(255,255,255,0.45)' }}>
                            {device.memUsedEstimate ? 'Tahmini' : 'Ölçülen'}
                          </p>
                          <p style={{ margin: 0, fontSize: 12, color: 'rgba(255,255,255,0.92)' }}>
                            {formatMiB(device.memUsedMiB)} / {formatMiB(device.memTotalMiB)}
                            {device.memUsedEstimate && (
                              <span style={{ color: 'rgba(255,255,255,0.45)' }}> (Tahmini)</span>
                            )}
                            {!Number.isFinite(device.memUsedMiB as number | undefined) && !Number.isFinite(device.memTotalMiB as number | undefined) && (
                              <span style={{ color: 'rgba(255,255,255,0.45)' }}> (Bilinmeyen)</span>
                            )}
                          </p>
                        </div>
                        <div>
                          <p style={{ margin: 0, fontSize: 10, color: 'rgba(255,255,255,0.55)' }}>Sıcaklık</p>
                          <p style={{ margin: 0, fontSize: 12, color: 'rgba(255,255,255,0.92)' }}>{device.tempC ?? '—'} °C</p>
                        </div>
                        <div>
                          <p style={{ margin: 0, fontSize: 10, color: 'rgba(255,255,255,0.55)' }}>Güç</p>
                          <p style={{ margin: 0, fontSize: 12, color: 'rgba(255,255,255,0.92)' }}>{device.powerDraw ?? '—'} / {device.powerLimit ?? '—'} W</p>
                        </div>
                      </div>
                      {device.index === data.gpu?.devices?.[0]?.index && (
                        <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.72)' }}>GPU Kullanım Trendi</div>
                            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.62)' }}>{summarizePercentTrend(gpuUtilHistory)}</div>
                          </div>
                          {renderSparkline(gpuUtilHistory, '#5E5CE6', 'gpu-util-gradient')}
                          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.72)' }}>VRAM Kullanım Trendi</div>
                            <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.62)' }}>{summarizePercentTrend(gpuMemHistory)}</div>
                          </div>
                          {renderSparkline(gpuMemHistory, '#34C759', 'gpu-mem-gradient')}
                          {!hasLiveGpuMetrics && (
                            <p style={{ margin: 0, fontSize: 11, color: 'rgba(255,255,255,0.62)' }}>
                              GPU kullanım metrikleri toplanamadığı için trend verisi gösterilemiyor.
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
          </div>
        </GlassCard>

        <GlassCard delay={0.12} noPad>
          <div style={{ padding: m ? 14 : 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Settings2 size={16} />
              <h3 style={sectionTitleStyle}>Ollama Optimizasyon</h3>
            </div>
            {!optimization ? (
              <p style={{ margin: 0, fontSize: 12, color: textSecondary }}>Optimizasyon bilgisi alınmadı.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : 'minmax(0, 0.9fr) minmax(0, 1.1fr)', gap: 12 }}>
                  <div
                    style={{
                      border: panelBorder,
                      borderRadius: 14,
                      padding: 14,
                      background: 'rgba(255,255,255,0.03)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    <div>
                      <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: textPrimary }}>General</p>
                      <p style={{ ...helperTextStyle, marginTop: 2 }}>Açık/kapalı durumu ve tuning stratejisi.</p>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={fieldLabelStyle}>Enabled</span>
                        <span
                          style={{
                            ...inputStyle,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 10,
                            cursor: 'pointer',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={!!optimizationProfile?.enabled}
                            onChange={(event) => updateOptimizationProfile({ enabled: event.target.checked })}
                          />
                          <span style={{ fontSize: 13, color: textPrimary }}>{optimizationProfile?.enabled ? 'Aktif' : 'Pasif'}</span>
                        </span>
                      </label>

                      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={fieldLabelStyle}>Strategy</span>
                        <select
                          value={optimizationProfile?.strategy || 'balanced'}
                          onChange={(event) =>
                            updateOptimizationProfile({
                              strategy: (event.target.value === 'performance' || event.target.value === 'conservative'
                                ? event.target.value
                                : 'balanced') as OllamaOptimizationProfile['strategy'],
                            })
                          }
                          style={inputStyle}
                        >
                          <option value="conservative">Conservative</option>
                          <option value="balanced">Balanced</option>
                          <option value="performance">Performance</option>
                        </select>
                      </label>
                    </div>
                  </div>

                  <div
                    style={{
                      border: panelBorder,
                      borderRadius: 14,
                      padding: 14,
                      background: 'rgba(255,255,255,0.03)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 12,
                    }}
                  >
                    <div>
                      <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: textPrimary }}>Resources</p>
                      <p style={{ ...helperTextStyle, marginTop: 2 }}>Bellek ve concurrency limitleri.</p>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={fieldLabelStyle}>Keep-Alive</span>
                        <input
                          value={optimizationProfile?.keepAlive || ''}
                          onChange={(event) => updateOptimizationProfile({ keepAlive: event.target.value })}
                          style={inputStyle}
                        />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={fieldLabelStyle}>Maks. Yüklü Model</span>
                        <input
                          type="number"
                          min={1}
                          max={16}
                          value={optimizationProfile?.maxLoadedModels ?? ''}
                          onChange={(event) => updateOptimizationProfile({ maxLoadedModels: Number(event.target.value) })}
                          style={inputStyle}
                        />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={fieldLabelStyle}>num_ctx</span>
                        <input
                          type="number"
                          min={256}
                          max={65536}
                          step={256}
                          value={optimizationProfile?.numCtx ?? ''}
                          onChange={(event) => updateOptimizationProfile({ numCtx: Number(event.target.value) })}
                          style={inputStyle}
                        />
                      </label>
                      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <span style={fieldLabelStyle}>num_parallel</span>
                        <input
                          type="number"
                          min={1}
                          max={16}
                          value={optimizationProfile?.numParallel ?? ''}
                          onChange={(event) => updateOptimizationProfile({ numParallel: Number(event.target.value) })}
                          style={inputStyle}
                        />
                      </label>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' }}>
                  <button
                    onClick={applyRecommendationToForm}
                    disabled={!recommendation}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      borderRadius: 10,
                      border: '1px solid rgba(255,255,255,0.22)',
                      background: 'rgba(255,205,112,0.12)',
                      color: 'rgba(255,255,255,0.95)',
                      padding: '9px 12px',
                      cursor: recommendation ? 'pointer' : 'not-allowed',
                    }}
                  >
                    <Wand2 size={15} />
                    Öneriyi Uygula
                  </button>
                  <button
                    onClick={handleSaveOptimization}
                    disabled={isSavingOptimization || !optimizationDirty}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      borderRadius: 10,
                      border: '1px solid rgba(0,122,255,0.45)',
                      background: 'rgba(0,122,255,0.15)',
                      color: 'rgba(255,255,255,0.96)',
                      padding: '9px 12px',
                      cursor: optimizationDirty ? 'pointer' : 'not-allowed',
                    }}
                  >
                    <Save size={15} />
                    {isSavingOptimization ? 'Kaydediliyor...' : 'Kaydet'}
                  </button>
                  <button
                    onClick={handleRollbackOptimization}
                    disabled={isRollingBackOptimization}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      borderRadius: 10,
                      border: '1px solid rgba(255,69,58,0.45)',
                      background: 'rgba(255,69,58,0.14)',
                      color: 'rgba(255,255,255,0.96)',
                      padding: '9px 12px',
                      cursor: isRollingBackOptimization ? 'progress' : 'pointer',
                    }}
                  >
                    {isRollingBackOptimization ? 'Rollback...' : 'Rollback'}
                  </button>
                  <button
                    onClick={() => handleCopyCommands(optimization?.applyCommands || [])}
                    disabled={!optimization?.applyCommands?.length}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 8,
                      borderRadius: 10,
                      border: '1px solid rgba(0,255,255,0.3)',
                      background: 'rgba(0,255,255,0.08)',
                      color: 'rgba(255,255,255,0.95)',
                      padding: '9px 12px',
                      cursor: optimization?.applyCommands?.length ? 'pointer' : 'not-allowed',
                    }}
                  >
                    <Copy size={15} />
                    Komutları Kopyala
                  </button>
                </div>
                {!!optimizationMessage && <p style={{ margin: 0, fontSize: 12, color: textPrimary }}>{optimizationMessage}</p>}
                <div style={{ border: panelBorder, borderRadius: 12, padding: 12 }}>
                  <p style={{ margin: 0, marginBottom: 6, fontSize: 12, color: textSecondary }}>Durum Özeti</p>
                  <p style={{ margin: 0, fontSize: 12, color: textPrimary }}>
                    Mevcut: {optimization.current.strategy} / keepAlive={optimization.current.keepAlive} / maxLoadedModels={optimization.current.maxLoadedModels} / num_ctx={optimization.current.numCtx} / num_parallel={optimization.current.numParallel}
                  </p>
                  <p style={{ margin: '6px 0 0', fontSize: 11, color: textSecondary }}>
                    Önerilen profil: {recommendation?.strategy || '-'} / {recommendation?.keepAlive || '-'} / {recommendation?.maxLoadedModels || '-'} / {recommendation?.numCtx || '-'} / {recommendation?.numParallel || '-'}
                  </p>
                  <p style={{ margin: '6px 0 0', fontSize: 11, color: textSecondary }}>Platform: {platform}</p>
                  {!!recommendation?.reasons?.length && (
                    <div style={{ marginTop: 8 }}>
                      <p style={{ margin: '0 0 4px', fontSize: 11, color: textSecondary }}>Nedenler</p>
                      {recommendation.reasons.map((reason, index) => (
                        <p key={`${reason}-${index}`} style={{ margin: '0 0 4px', fontSize: 11, color: textTertiary }}>
                          • {reason}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </GlassCard>

        <GlassCard delay={0.16} noPad>
          <div style={{ padding: m ? 14 : 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <StatusBadge status={statusColor(data.server.status)} label={data.server.status} pulse={data.server.status === 'online'} />
                <div>
                  <p style={{ margin: 0, fontSize: 12, color: textSecondary }}>Sunucu</p>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: textPrimary }}>{data.server.baseUrl}</p>
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ margin: 0, fontSize: 12, color: textSecondary }}>Version</p>
                <p style={{ margin: 0, fontSize: 13, color: textPrimary }}>{data.server.version || '—'}</p>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : '1.35fr 0.85fr', gap: 12 }}>
                <div
                  style={{
                    border: panelBorder,
                    borderRadius: 16,
                    padding: m ? 14 : 16,
                    background: `radial-gradient(circle at top left, ${healthColor(healthScore)}22, transparent 34%), linear-gradient(180deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0.02) 100%)`,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 14,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: m ? 'flex-start' : 'center', flexDirection: m ? 'column' : 'row' }}>
                    <div style={{ minWidth: 0 }}>
                      <p style={{ margin: 0, fontSize: 12, fontWeight: 600, color: textSecondary }}>Health Score</p>
                      <p style={{ margin: '6px 0 0', fontSize: m ? 38 : 48, lineHeight: 1, fontWeight: 800, color: healthColor(healthScore) }}>{healthScore}</p>
                      <p style={{ ...helperTextStyle, marginTop: 6 }}>0-100 ölçekli genel sağlık</p>
                    </div>
                    <div style={{ flex: 1, width: '100%', minWidth: m ? '100%' : 240 }}>
                      {renderSparkline(healthTrend, healthColor(healthScore), 'ollama-health-sparkline')}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: textSecondary }}>Overall progress</span>
                      <span style={{ fontSize: 11, color: textPrimary, fontWeight: 600 }}>{healthScore}%</span>
                    </div>
                    <div style={{ height: 16, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                      <div
                        style={{
                          width: `${Math.max(0, Math.min(100, healthScore))}%`,
                          height: '100%',
                          borderRadius: 999,
                          background: `linear-gradient(90deg, ${healthColor(healthScore)} 0%, ${healthColor(healthScore)}CC 100%)`,
                          boxShadow: `0 0 20px ${healthColor(healthScore)}55`,
                        }}
                      />
                    </div>
                  </div>
                </div>
                <div style={{ border: panelBorder, borderRadius: 12, padding: 12 }}>
                  <p style={{ margin: 0, fontSize: 12, color: textSecondary }}>Uyarılar</p>
                  {alertNotes.length ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                      {alertNotes.slice(0, 4).map((alert) => (
                        <p key={`${alert.code}-${alert.triggeredAt}`} style={{ margin: 0, fontSize: 11, color: textPrimary }}>
                          • {alert.message}
                          {alert.suppressed ? ' (bekleme süresi)' : ''}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p style={{ margin: '8px 0 0', fontSize: 11, color: textTertiary }}>Aktif uyarı yok.</p>
                  )}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
                <div style={{ border: panelBorder, borderRadius: 12, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Cpu size={14} />
                    <span style={{ fontSize: 12, color: textSecondary }}>CPU</span>
                  </div>
                  <p style={metricLabelStyle}>Yük</p>
                  <p style={metricValueStyle}>{data.system.cpu.usagePercent}%</p>
                  <p style={helperTextStyle}>
                    Load: {data.system.cpu.load1} / {data.system.cpu.load5} / {data.system.cpu.load15}
                  </p>
                </div>
                <div style={{ border: panelBorder, borderRadius: 12, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <HardDrive size={14} />
                    <span style={{ fontSize: 12, color: textSecondary }}>Bellek</span>
                  </div>
                  <p style={metricLabelStyle}>Kullanım</p>
                  <p style={metricValueStyle}>{data.system.memory.usedPercent}%</p>
                  <p style={helperTextStyle}>
                    {formatBytes(data.system.memory.usedBytes)} / {formatBytes(data.system.memory.totalBytes)}
                  </p>
                </div>
                <div style={{ border: panelBorder, borderRadius: 12, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <Clock3 size={14} />
                    <span style={{ fontSize: 12, color: textSecondary }}>Runtime</span>
                  </div>
                  <p style={metricLabelStyle}>Çalışan modeller</p>
                  <p style={metricValueStyle}>{data.runtime.runningModels}</p>
                  {runningModelNames.length > 0 ? (
                    <div
                      title={runningModelNames.join('\n')}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 4,
                        marginTop: 6,
                        minWidth: 0,
                      }}
                    >
                      {visibleRunningModelNames.map((name) => (
                        <span
                          key={name}
                          style={{
                            borderRadius: 999,
                            border: '1px solid rgba(52,199,89,0.26)',
                            background: 'rgba(52,199,89,0.10)',
                            color: textPrimary,
                            fontSize: 11,
                            fontWeight: 600,
                            lineHeight: 1.25,
                            padding: '4px 8px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            maxWidth: '100%',
                          }}
                        >
                          {name}
                        </span>
                      ))}
                      {hiddenRunningModelCount > 0 && (
                        <span style={{ ...helperTextStyle, marginTop: 0 }}>+{hiddenRunningModelCount} model daha</span>
                      )}
                    </div>
                  ) : (
                    <p style={{ ...helperTextStyle, marginTop: 6 }}>Aktif model yok</p>
                  )}
                  <p style={{ ...helperTextStyle, marginTop: 6 }}>Toplam: {data.runtime.totalModels}</p>
                  <p style={{ ...helperTextStyle, marginTop: 3 }}>Son yükleme: {latestModelAt}</p>
                </div>
              </div>
            </div>
            {data.server.error && (
              <p style={{ margin: '12px 0 0', fontSize: 11, color: '#FF9F0A' }}>
                {data.server.error}
              </p>
            )}
          </div>
        </GlassCard>

        <GlassCard delay={0.2} noPad>
          <div style={{ padding: m ? 14 : 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Server size={16} />
                <h3 style={sectionTitleStyle}>Model Durumu</h3>
              </div>
              {models.length > 0 && (
                <button
                  onClick={() => setAllModelsExpanded(!allModelsExpanded)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 8,
                    borderRadius: 10,
                    border: panelBorder,
                    background: 'rgba(255,255,255,0.05)',
                    color: textPrimary,
                    padding: '8px 12px',
                    cursor: 'pointer',
                  }}
                >
                  {allModelsExpanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  {allModelsExpanded ? 'Collapse All' : 'Expand All'}
                </button>
              )}
            </div>
            {(models.length > 0 || modelMetrics.length > 0) && (
              <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))', gap: 10, marginBottom: 14 }}>
                <div style={{ border: panelBorder, borderRadius: 14, padding: 12, background: 'rgba(255,255,255,0.03)' }}>
                  <p style={metricLabelStyle}>Total models</p>
                  <p style={metricValueStyle}>{modelSummary.totalModels}</p>
                </div>
                <div style={{ border: panelBorder, borderRadius: 14, padding: 12, background: 'rgba(255,255,255,0.03)' }}>
                  <p style={metricLabelStyle}>Running</p>
                  <p style={metricValueStyle}>{modelSummary.runningCount}</p>
                </div>
                <div style={{ border: panelBorder, borderRadius: 14, padding: 12, background: 'rgba(255,255,255,0.03)' }}>
                  <p style={metricLabelStyle}>Avg err%</p>
                  <p style={metricValueStyle}>{formatErrorRate(modelSummary.avgErrorRate)}</p>
                </div>
                <div style={{ border: panelBorder, borderRadius: 14, padding: 12, background: 'rgba(255,255,255,0.03)' }}>
                  <p style={metricLabelStyle}>Total requests</p>
                  <p style={metricValueStyle}>{modelSummary.totalRequests}</p>
                </div>
              </div>
            )}
            {models.length === 0 ? (
              <p style={{ fontSize: 12, color: textSecondary }}>Model listesi boş.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {models.map((model) => {
                  const metric = modelMetricMap.get(model.name)
                  const isExpanded = !!expandedModels[model.name]

                  return (
                    <div
                      key={model.name}
                      style={{
                        border: panelBorder,
                        borderRadius: 14,
                        background: 'rgba(255,255,255,0.03)',
                        overflow: 'hidden',
                      }}
                    >
                      <button
                        onClick={() => toggleModelExpanded(model.name)}
                        style={{
                          width: '100%',
                          border: 'none',
                          background: 'transparent',
                          color: textPrimary,
                          padding: 14,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 12,
                          cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flexWrap: 'wrap' }}>
                            <p
                              style={{
                                margin: 0,
                                fontSize: 14,
                                fontWeight: 600,
                                color: textPrimary,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                minWidth: 0,
                              }}
                            >
                              {model.name}
                            </p>
                            <StatusBadge status={model.status === 'running' ? 'active' : 'ok'} label={model.status} />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: m ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 0.9fr) repeat(2, minmax(100px, 0.55fr))', gap: 10, alignItems: 'center' }}>
                            <p style={{ margin: 0, fontSize: 11, color: textTertiary }}>
                              {model.parameterSize || '—'} · {model.quantization || '—'} · {model.format || '—'}
                            </p>
                            <div>
                              <p style={metricLabelStyle}>Req/min</p>
                              <p style={{ margin: '3px 0 0', fontSize: 13, fontWeight: 600, color: textPrimary }}>{formatMetric(metric?.requestsPerMinute, 2)}</p>
                            </div>
                            <div>
                              <p style={metricLabelStyle}>Err%</p>
                              <p style={{ margin: '3px 0 0', fontSize: 13, fontWeight: 600, color: textPrimary }}>{formatErrorRate(metric?.errorRate)}</p>
                            </div>
                          </div>
                        </div>
                        {isExpanded ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                      </button>

                      {isExpanded && (
                        <div style={{ borderTop: panelBorder, padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
                          {metric && (
                            <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                              <div style={{ border: panelBorder, borderRadius: 12, padding: 10 }}>
                                <p style={metricLabelStyle}>Req/min</p>
                                <p style={{ ...metricValueStyle, fontSize: 16 }}>{formatMetric(metric.requestsPerMinute, 2)}</p>
                              </div>
                              <div style={{ border: panelBorder, borderRadius: 12, padding: 10 }}>
                                <p style={metricLabelStyle}>p95</p>
                                <p style={{ ...metricValueStyle, fontSize: 16 }}>{formatMetric(metric.p95LatencyMs, 0)} ms</p>
                              </div>
                              <div style={{ border: panelBorder, borderRadius: 12, padding: 10 }}>
                                <p style={metricLabelStyle}>Err%</p>
                                <p style={{ ...metricValueStyle, fontSize: 16 }}>{formatErrorRate(metric.errorRate)}</p>
                              </div>
                              <div style={{ border: panelBorder, borderRadius: 12, padding: 10 }}>
                                <p style={metricLabelStyle}>Requests</p>
                                <p style={{ ...metricValueStyle, fontSize: 16 }}>{metric.requestCount}</p>
                              </div>
                            </div>
                          )}

                          <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr 1fr' : 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
                            <div>
                              <p style={metricLabelStyle}>Boyut</p>
                              <p style={{ margin: '4px 0 0', fontSize: 13, color: textPrimary }}>{model.sizeLabel || '—'}</p>
                            </div>
                            <div>
                              <p style={metricLabelStyle}>Aile</p>
                              <p style={{ margin: '4px 0 0', fontSize: 13, color: textPrimary }}>{model.family || '—'}</p>
                            </div>
                            <div>
                              <p style={metricLabelStyle}>Keep-Alive</p>
                              <p style={{ margin: '4px 0 0', fontSize: 13, color: textPrimary }}>{model.keepAlive || '—'}</p>
                            </div>
                            <div>
                              <p style={metricLabelStyle}>Expired / Loaded</p>
                              <p style={{ margin: '4px 0 0', fontSize: 13, color: textPrimary }}>{formatTime(model.expiresAt)}/{formatTime(model.loadedAt)}</p>
                            </div>
                          </div>

                          <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
                            <div>
                              <p style={metricLabelStyle}>Digest</p>
                              <p style={{ margin: '4px 0 0', fontSize: 11, color: textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {model.digest || '—'}
                              </p>
                            </div>
                            <div>
                              <p style={metricLabelStyle}>Telemetry</p>
                              <p style={{ margin: '4px 0 0', fontSize: 11, color: textTertiary }}>
                                {metric ? `${metric.status}${metric.estimated ? ' · estimated' : ''}` : 'Telemetry unavailable'}
                              </p>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </GlassCard>
      </div>
    </PageTransition>
  )
}
