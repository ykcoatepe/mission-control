import type {
  AttentionItem,
  DrawerSelection,
  EvidenceItem,
  OperationCapability,
  OperationsOverview,
  OperationState,
  OperationSystem,
  OperationSystemId,
} from './types'

const severityRank: Record<OperationState, number> = {
  critical: 5,
  warning: 4,
  unavailable: 3,
  inactive: 2,
  healthy: 1,
}

export type SearchResult = {
  id: string
  label: string
  detail: string
  href: string
  system: OperationSystemId
}

export function sortAttention(items: AttentionItem[]) {
  return [...items].sort(
    (a, b) => severityRank[b.severity] - severityRank[a.severity] || a.id.localeCompare(b.id),
  )
}

export function actionNeedsConfirmation(action: OperationCapability) {
  return action.safetyClass === 'W1' && action.requiresConfirmation
}

export function findSearchResults(query: string, overview: OperationsOverview): SearchResult[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const destinations: SearchResult[] = [
    { id: 'brain', label: 'Brain', detail: 'Shared evidence and decisions', href: '/', system: 'gbrain' },
    { id: 'work', label: 'Work', detail: 'Hermes work and handoffs', href: '/work', system: 'hermes' },
    { id: 'automations', label: 'Automations', detail: 'OpenClaw and Hermes schedules', href: '/automations', system: 'openclaw' },
    { id: 'sessions', label: 'Sessions', detail: 'OpenClaw sessions', href: '/sessions', system: 'openclaw' },
    { id: 'gbrain', label: 'Explore', detail: 'GBrain sources and memory', href: '/gbrain', system: 'gbrain' },
    { id: 'usage', label: 'Usage', detail: 'Spend and model mix', href: '/usage', system: 'openclaw' },
    { id: 'systems', label: 'Systems', detail: 'Agents, models, integrations', href: '/systems', system: 'openclaw' },
  ]
  const dynamic: SearchResult[] = [
    ...overview.attention.map((item) => ({
      id: item.id,
      label: item.title,
      detail: item.detail,
      href: item.detailHref,
      system: item.system,
    })),
    ...overview.evidence.map((item) => ({
      id: item.id,
      label: item.summary,
      detail: item.sourceRef,
      href: item.detailHref,
      system: item.system,
    })),
  ]
  return [...dynamic, ...destinations]
    .filter((item) => `${item.label} ${item.detail} ${item.system}`.toLowerCase().includes(needle))
    .slice(0, 8)
}

export function selectionFromSystem(system: OperationSystem): DrawerSelection {
  return {
    system: system.id,
    title: system.label,
    detail: `${system.state} · ${system.freshness}`,
    detailHref: system.detailHref,
    caveats: system.caveats,
    evidence: system.evidence,
  }
}

export function selectionFromAttention(
  item: AttentionItem,
  evidence: EvidenceItem[],
): DrawerSelection {
  return {
    system: item.system,
    title: item.title,
    detail: item.detail,
    detailHref: item.detailHref,
    caveats: [],
    evidence: evidence.filter((proof) => item.evidenceRefs.includes(proof.id)),
  }
}

export function selectionFromEvidence(item: EvidenceItem): DrawerSelection {
  return {
    system: item.system,
    title: item.summary,
    detail: item.sourceRef,
    detailHref: item.detailHref,
    caveats: item.status === 'healthy' ? [] : [item.summary],
    evidence: [item],
  }
}
