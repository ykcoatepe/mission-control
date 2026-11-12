import type { UiState } from '../../lib/state'
import { deriveLinkExtraction, fmtCount, groupBlockId, isSyncOff } from './lib'
import type { GBrainSynoptic, HealthReading, SourcesReading, SynopticSource } from './types'

/** The four line colours identify the four source groups, and nothing else. */
export type GroupTone = 'reference' | 'projects' | 'agent' | 'curated'

const GROUP_ORDER = ['reference', 'projects', 'agent-memory', 'curated'] as const

const GROUP_LOOK: Record<string, { label: string; tone: GroupTone }> = {
  reference: { label: 'Reference', tone: 'reference' },
  projects: { label: 'Projects', tone: 'projects' },
  'agent-memory': { label: 'Agent memory', tone: 'agent' },
  curated: { label: 'Curated', tone: 'curated' },
}

export interface DiagramSource {
  id: string
  /** Short name for the line profile ("gstack" for "gstack-code"). */
  shortName: string
  state: UiState
  /** The server excluded the source from sync scoring: drawn as a dash, never as a state. */
  syncOff: boolean
  pages: number | null
  chunks: number | null
  lastSyncAt: string | null
  behind: number | null
  groupId: string
  groupLabel: string
  tone: GroupTone | undefined
}

export interface DiagramGroup {
  id: string
  blockId: string
  label: string
  tone: GroupTone | undefined
  state: UiState
  sources: DiagramSource[]
  /** Sum of the pages that were read; null when none were. */
  totalPages: number | null
  /** At least one source's page count was not read. */
  partialPages: boolean
}

export interface Diagram {
  groups: DiagramGroup[]
  /** Every source in diagram order: the order of the line profile. */
  sources: DiagramSource[]
  /** Page counts could not be read at all (the sources reading is missing). */
  pagesUnread: boolean
}

/** "gstack-code" -> "gstack", "tk-a320-line-ops" -> "tk-a320": the first word, or two when the first is a prefix. */
export function shortSourceName(id: string): string {
  const parts = id.split('-').filter(Boolean)
  if (parts.length <= 1) return id
  return parts[0].length <= 2 ? `${parts[0]}-${parts[1]}` : parts[0]
}

function sourceFrom(
  item: SynopticSource,
  groupId: string,
  look: { label: string; tone: GroupTone | undefined },
  records: Map<string, NonNullable<SourcesReading['sources']>[number]>,
): DiagramSource {
  const record = records.get(item.id)
  const syncOff = isSyncOff(item)
  return {
    id: item.id,
    shortName: shortSourceName(item.id),
    state: syncOff ? 'inactive' : item.state,
    syncOff,
    pages: typeof record?.pages === 'number' ? record.pages : null,
    chunks: typeof record?.chunks === 'number' ? record.chunks : null,
    lastSyncAt: item.lastSyncAt ?? record?.lastSyncAt ?? null,
    behind: item.behind ?? null,
    groupId,
    groupLabel: look.label,
    tone: look.tone,
  }
}

/**
 * The four groups in their fixed order, each source with its page count (from the sources reading),
 * largest first. Pure: a source whose pages were not read has `pages: null` and goes last.
 */
export function buildDiagram(syn: GBrainSynoptic, sources: SourcesReading | null): Diagram {
  const records = new Map((sources?.sources ?? []).map((record) => [record.id, record]))
  const known = syn.sources.filter((group) => GROUP_ORDER.includes(group.id as (typeof GROUP_ORDER)[number]))
  const extra = syn.sources.filter((group) => !known.includes(group))
  const ordered = [
    ...GROUP_ORDER.flatMap((id) => known.filter((group) => group.id === id)),
    ...extra,
  ]
  const groups = ordered.map((group): DiagramGroup => {
    const look = GROUP_LOOK[group.id] ?? { label: group.label || group.id, tone: undefined }
    const items = group.items
      .map((item, index) => ({ source: sourceFrom(item, group.id, look, records), index }))
      .sort((a, b) => (b.source.pages ?? -1) - (a.source.pages ?? -1) || a.index - b.index)
      .map(({ source }) => source)
    const read = items.filter((source) => source.pages !== null)
    return {
      id: group.id,
      blockId: groupBlockId(group.id),
      label: look.label,
      tone: look.tone,
      state: group.state,
      sources: items,
      totalPages: read.length ? read.reduce((sum, source) => sum + (source.pages ?? 0), 0) : null,
      partialPages: read.length < items.length,
    }
  })
  return {
    groups,
    sources: groups.flatMap((group) => group.sources),
    pagesUnread: sources === null || !Array.isArray(sources.sources),
  }
}

/** Embedded chunks as a percent of all chunks, or null when either was not read. Never above 100. */
export function embeddedPercent(core: GBrainSynoptic['core']): number | null {
  const chunks = core.chunks?.value
  const embedded = core.embedded?.value
  if (typeof chunks !== 'number' || typeof embedded !== 'number' || chunks <= 0) return null
  return Math.min(100, (embedded / chunks) * 100)
}

export const fmtPercent = (value: number | null, digits = 2): string => (value === null ? '—' : `${value.toFixed(digits)}%`)

export interface CoreReading {
  label: string
  value: string
  state: UiState
  /** A source of the figure was not read: drawn as a hollow circle and "not read". */
  unread: boolean
}

/** "2 min ago", "3 h ago", "just now"; a missing or unreadable time gives null. */
export function agoText(at: string | null | undefined, now: number): string | null {
  const t = at ? Date.parse(at) : Number.NaN
  if (!Number.isFinite(t)) return null
  const seconds = Math.max(0, Math.floor((now - t) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.floor(hours / 24)} d ago`
}

/** The six readings beside the core: pages, chunks, embedded, sources, link extraction, last sync. */
export function coreReadings(
  syn: GBrainSynoptic,
  diagram: Diagram,
  health: HealthReading | null | undefined,
  now: number,
): CoreReading[] {
  const count = (m: { value: number | null; state: UiState } | undefined, label: string): CoreReading => {
    const unread = typeof m?.value !== 'number'
    return { label, value: unread ? 'not read' : fmtCount(m?.value), state: m?.state ?? 'unavailable', unread }
  }
  const items = diagram.sources
  const off = items.filter((source) => source.syncOff).length
  const fresh = items.filter((source) => !source.syncOff && source.state === 'healthy').length
  const stale = items.filter((source) => !source.syncOff && (source.state === 'warning' || source.state === 'critical')).length
  const unread = items.filter((source) => !source.syncOff && source.state === 'unavailable').length
  const parts = [
    fresh > 0 ? `${fresh} fresh` : null,
    stale > 0 ? `${stale} stale` : null,
    unread > 0 ? `${unread} not read` : null,
    off > 0 ? `${off} sync off` : null,
  ].filter(Boolean)
  const sourcesReading: CoreReading = {
    label: 'Sources',
    value: items.length ? `${items.length}${parts.length ? ` (${parts.join(', ')})` : ''}` : 'not read',
    state: items.length ? (stale > 0 ? 'warning' : 'healthy') : 'unavailable',
    unread: items.length === 0,
  }
  const link = deriveLinkExtraction(health)
  const linkReading: CoreReading = {
    label: 'Link extraction',
    value: link.value === null ? 'not read' : `${link.value === 'current' ? 'Current' : link.value}${link.unit && link.value !== 'current' ? ` ${link.unit}` : ''}`,
    state: link.state,
    unread: link.value === null,
  }
  const newest = items
    .filter((source) => !source.syncOff && source.lastSyncAt)
    .map((source) => Date.parse(source.lastSyncAt as string))
    .filter(Number.isFinite)
  const lastSync = newest.length ? agoText(new Date(Math.max(...newest)).toISOString(), now) : null
  return [
    count(syn.core.pages, 'Pages'),
    count(syn.core.chunks, 'Chunks'),
    count(syn.core.embedded, 'Embedded'),
    sourcesReading,
    linkReading,
    { label: 'Last sync', value: lastSync ?? 'not read', state: lastSync ? 'healthy' : 'unavailable', unread: lastSync === null },
  ]
}
