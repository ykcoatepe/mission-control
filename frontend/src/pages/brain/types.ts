export type OperationSystemId = 'gbrain' | 'hermes' | 'openclaw'
export type OperationState = 'healthy' | 'warning' | 'critical' | 'inactive' | 'unavailable'
export type FreshnessState = 'fresh' | 'stale' | 'unknown' | 'unavailable'
export type SafetyClass = 'R0' | 'W1' | 'W2'

export interface EvidenceItem {
  id: string
  system: OperationSystemId
  kind: string
  status: OperationState
  observedAt: string | null
  summary: string
  sourceRef: string
  detailHref: string
}

export interface AttentionItem {
  id: string
  system: OperationSystemId
  severity: OperationState
  reasonCode: string
  title: string
  detail: string
  detailHref: string
  evidenceRefs: string[]
}

export interface OperationSystem {
  id: OperationSystemId
  label: string
  state: OperationState
  observedAt: string | null
  freshness: FreshnessState
  caveats: string[]
  metrics: Record<string, string | number | null>
  evidence: EvidenceItem[]
  detailHref: string
}

export interface OperationCapability {
  id: string
  system: 'gbrain'
  label: string
  description: string
  kind: string
  safetyClass: SafetyClass
  requiresConfirmation: boolean
  timeoutMs: number | null
  refreshAfter: boolean
  enabled: boolean
  disabledReason: string
  actionEndpoint: '/api/gbrain/actions'
}

export interface OperationsOverview {
  ok: boolean
  schemaVersion: '1'
  generatedAt: string
  mode: 'live-read-first'
  overall: { state: OperationState; reasonCodes: string[] }
  systems: Record<OperationSystemId, OperationSystem>
  attention: AttentionItem[]
  evidence: EvidenceItem[]
  capabilities: OperationCapability[]
}

export type DrawerSelection = {
  system: OperationSystemId
  title: string
  detail: string
  detailHref: string
  caveats: string[]
  evidence: EvidenceItem[]
}

export type ActionStatus = {
  state: 'running' | 'verifying' | 'verified' | 'pending-proof' | 'failed' | 'complete'
  message: string
}
