import { startSentence, type Verdict } from './lib'
import type { OperationCapability } from './types'

export interface Alarm {
  state: 'warning' | 'critical'
  /** The plain sentence of the first thing to act on. */
  title: string
  /** How many other things to act on there are. Information never counts. */
  more: number
  /** The verdict reason it is about; null for a stale reading. */
  elementId: string | null
}

/**
 * The page's one alarm line (HMI rule 4). It comes from the verdict's reasons that ask for action
 * (`kind: 'action'`) and are cautions or worse. Information never raises it and is never counted in its
 * headline. A reading that was not taken is not an alarm; the page says so quietly instead.
 * One exception: the reading itself being stale raises a caution, as the top bar does.
 */
export function alarmFrom(verdict: Verdict): Alarm | null {
  const actions = verdict.conditions.filter((condition) => condition.kind === 'action' && condition.state !== 'inactive')
  const raised = actions.filter((condition) => condition.state === 'warning' || condition.state === 'critical')
  const first = raised[0]
  if (first) {
    return {
      state: first.state === 'critical' ? 'critical' : 'warning',
      title: startSentence(first.text),
      more: actions.length - 1,
      elementId: first.id,
    }
  }
  if (verdict.staleReading) return { state: 'warning', title: 'The last reading is stale', more: actions.length, elementId: null }
  return null
}

/** A reason about the core or the readings themselves, never about one source. */
const CORE_REASONS = new Set(['gbrain-core', 'embed-job-probe', 'stale-pages', 'link-extraction', 'queue', 'sources', 'readers'])

const SHORT_LABEL: Record<string, string> = {
  'embed-missing': 'Backfill embeddings',
  'sync-sources': 'Sync sources',
  'retry-failed-sync': 'Retry syncs',
  'doctor-fast': 'Run check',
}

/** The id of the maintenance action that matches a reason. Anything without a fitting repair gets the check. */
export function actionIdFor(elementId: string | null): string {
  if (elementId === 'missing-embeddings') return 'embed-missing'
  if (elementId === null || CORE_REASONS.has(elementId) || elementId.startsWith('gbrain.')) return 'doctor-fast'
  // Anything else is a source id: a stale source is repaired by syncing.
  return 'sync-sources'
}

export interface AlarmAction {
  capability: OperationCapability
  label: string
}

/**
 * The one action for the alarm line: the matching maintenance action, or the check when that one is not
 * offered or is switched off. W2 actions are never offered. Null when nothing can be run.
 */
export function alarmAction(elementId: string | null, capabilities: readonly OperationCapability[] | null): AlarmAction | null {
  if (!capabilities) return null
  const usable = (id: string) => capabilities.find((capability) => capability.id === id && capability.enabled && capability.safetyClass !== 'W2')
  const found = usable(actionIdFor(elementId)) ?? usable('doctor-fast')
  return found ? { capability: found, label: SHORT_LABEL[found.id] ?? found.label } : null
}
