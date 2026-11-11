import { useState } from 'react'
import { Panel, Stat, StatRow } from '../../components/ui'
import { ElementDrawer } from './ElementDetail'
import { MaintenancePanel } from './MaintenancePanel'
import { NotesPanel } from './NotesPanel'
import { ReadingsTimeline } from './ReadingsTimeline'
import { Synoptic } from './Synoptic'
import {
  collapseIncidents,
  currentNotes,
  deriveReadings,
  describeElement,
  recentReadings,
  type BrainModel,
  type Verdict,
} from './lib'
import styles from './HealthView.module.css'
import type {
  GBrainSynoptic,
  HealthReading,
  OperationCapability,
  SourcesReading,
  TimelineReading,
} from './types'
import { useAcknowledgedIncidents } from './useAcknowledged'

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
  capabilities: OperationCapability[] | null
  caveats: string[]
}

export function HealthView({
  data,
  running,
  onRun,
}: {
  data: BrainData
  running: string | null
  onRun: (action: OperationCapability) => void
}) {
  const { syn, model, verdict, health, sources, timeline, capabilities } = data
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { acknowledged, acknowledge } = useAcknowledgedIncidents()

  const readings = deriveReadings(syn, model, health)
  const detail = selectedId ? describeElement(selectedId, syn, model, { sources, health }) : null
  const recovered = collapseIncidents(timeline?.incidentBanners, acknowledged)
  const notes = currentNotes(verdict, data.caveats, syn.readersNote)
  const rows = recentReadings(timeline?.entries)

  const runFromDetail = (action: OperationCapability) => {
    // Close the drawer first: a confirmation must not stack on a second modal.
    setSelectedId(null)
    onRun(action)
  }

  return (
    <>
      <StatRow aria-label="Readings">
        <Stat
          label="Quality"
          value={readings.quality.value}
          unit="/100"
          state={readings.quality.state}
          hint="Coverage, links, timelines and orphans"
        />
        <Stat
          label="Source sync"
          value={readings.sourceSync.value}
          unit="fresh"
          state={readings.sourceSync.state}
          hint={readings.sourceSync.hint}
        />
        <Stat
          label="Link extraction"
          value={readings.linkExtraction.value}
          unit={readings.linkExtraction.unit ?? undefined}
          state={readings.linkExtraction.state}
          hint={readings.linkExtraction.hint}
        />
        <Stat
          label="Embedding queue"
          value={readings.queue.value}
          unit="waiting"
          state={readings.queue.state}
          hint={readings.queue.hint}
        />
      </StatRow>

      <Panel
        title="System synoptic"
        description="Select a block or a line for its readings and actions."
      >
        <Synoptic model={model} selectedId={selectedId} onSelect={setSelectedId} />
      </Panel>

      <div className={styles.pair}>
        <NotesPanel
          notes={notes}
          recovered={recovered}
          onAcknowledge={() => acknowledge(recovered.map((entry) => entry.key))}
        />
        <MaintenancePanel capabilities={capabilities} running={running} onRun={onRun} />
      </div>

      <ReadingsTimeline
        rows={rows}
        retained={timeline?.retainedEntryCount ?? null}
        observedAt={timeline?.meta?.observedAt ?? null}
        stale={data.timelineStale}
        readable={timeline !== null && timeline.entries !== null}
      />

      <ElementDrawer
        detail={detail}
        capabilities={capabilities}
        running={running}
        onClose={() => setSelectedId(null)}
        onRun={runFromDetail}
      />
    </>
  )
}
