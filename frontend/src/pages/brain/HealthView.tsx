import { useMemo, useState } from 'react'
import { ElementDrawer } from './ElementDetail'
import { LineProfile } from './LineProfile'
import { MaintenancePanel } from './MaintenancePanel'
import { NotesPanel } from './NotesPanel'
import { ReadingsBars } from './ReadingsBars'
import { ReadingsTimeline } from './ReadingsTimeline'
import { TrackDiagram } from './TrackDiagram'
import { buildDiagram } from './diagram'
import {
  collapseIncidents,
  currentNotes,
  deriveReadings,
  describeElement,
  recentReadings,
  type BrainModel,
  type Verdict,
} from './lib'
import type {
  GBrainSynoptic,
  HealthReading,
  OperationCapability,
  SourcesReading,
  TimelineReading,
  TrendsReading,
} from './types'
import { useAcknowledgedIncidents } from './useAcknowledged'
import styles from './HealthView.module.css'

export interface BrainData {
  syn: GBrainSynoptic
  model: BrainModel
  verdict: Verdict
  /** `undefined` while loading; a failed read is `{ ok: false }`. */
  health: HealthReading | null | undefined
  sources: SourcesReading | null
  /** `null` when the ledger could not be read. */
  timeline: TimelineReading | null
  timelineStale: boolean
  /** The 24-hour series from the ledger; `null` when they could not be read (then there is no trend). */
  trends: TrendsReading | null
  /** When the current (synoptic) reading was taken: the history is compared with it. */
  observedAt: string | null
  capabilities: OperationCapability[] | null
}

/**
 * The Health view, top to bottom: the track diagram with the three analog bars beside it, the line
 * profile, the recent readings, then the quiet tiers (notes, maintenance). The alarm line above it all
 * belongs to the page.
 */
export function HealthView({
  data,
  running,
  onRun,
}: {
  data: BrainData
  running: string | null
  onRun: (action: OperationCapability) => void
}) {
  const { syn, model, verdict, health, sources, timeline, capabilities, trends } = data
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { acknowledged, acknowledge } = useAcknowledgedIncidents()

  const diagram = useMemo(() => buildDiagram(syn, sources), [syn, sources])
  const readings = deriveReadings(syn, model, health, verdict.state)
  const detail = selectedId ? describeElement(selectedId, syn, model, { sources, health }) : null
  const recovered = collapseIncidents(timeline?.incidentBanners, acknowledged)
  // The notes are the verdict's own reasons, split by the server into what needs action and what is
  // for information. The alarm line carries the first one to act on.
  const notes = currentNotes(verdict)
  const rows = recentReadings(timeline?.entries, 6, { state: verdict.state, observedAt: data.observedAt })
  const showNotes = notes.action.length > 1 || notes.info.length > 0 || recovered.length > 0

  const runFromDetail = (action: OperationCapability) => {
    // Close the drawer first: a confirmation must not stack on a second modal.
    setSelectedId(null)
    onRun(action)
  }

  return (
    <div className={styles.root}>
      <div className={styles.top}>
        <TrackDiagram syn={syn} model={model} diagram={diagram} health={health} selectedId={selectedId} onSelect={setSelectedId} />
        <ReadingsBars syn={syn} verdict={verdict} readings={readings} trends={trends} />
      </div>

      <LineProfile diagram={diagram} />

      <ReadingsTimeline
        rows={rows}
        retained={timeline?.retainedEntryCount ?? null}
        observedAt={timeline?.meta?.observedAt ?? null}
        stale={data.timelineStale}
        readable={timeline !== null && timeline.entries !== null}
      />

      {showNotes && (
        <NotesPanel notes={notes} recovered={recovered} onAcknowledge={() => acknowledge(recovered.map((entry) => entry.key))} />
      )}
      <MaintenancePanel capabilities={capabilities} running={running} onRun={onRun} />

      <ElementDrawer
        detail={detail}
        capabilities={capabilities}
        running={running}
        onClose={() => setSelectedId(null)}
        onRun={runFromDetail}
      />
    </div>
  )
}
