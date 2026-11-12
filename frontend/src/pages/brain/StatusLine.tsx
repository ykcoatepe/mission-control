import { AlarmLine, Button, Freshness, StateMark } from '../../components/ui'
import type { Alarm, AlarmAction } from './alarm'
import type { Verdict } from './lib'
import styles from './StatusLine.module.css'

/**
 * The top of the work area (HMI rule 4). Something to act on is the one alarm line, with at most one
 * action at its right end. When nothing is abnormal there is no alarm line: one quiet sentence says
 * what was read, and a reading that could not be taken says so with the hollow circle, not an alarm.
 */
export function StatusLine({
  verdict,
  alarm,
  action,
  running,
  stale,
  observedAt,
  onRun,
  onRunCheck,
  runCheckDisabled,
  checkRunning,
}: {
  verdict: Verdict
  alarm: Alarm | null
  action: AlarmAction | null
  /** The id of the action that is running now, if any. */
  running: string | null
  stale: boolean
  observedAt: string | null
  onRun: (action: AlarmAction) => void
  /** The quiet "Run check" for a reading that was not taken. */
  onRunCheck?: () => void
  runCheckDisabled: boolean
  checkRunning: boolean
}) {
  if (alarm) {
    const parts: string[] = []
    if (alarm.more > 0) parts.push(`and ${alarm.more} more in Notes`)
    return (
      <AlarmLine
        state={alarm.state}
        title={alarm.title}
        detail={
          parts.length > 0 || stale ? (
            <>
              {parts.join(' · ')}
              {parts.length > 0 && stale ? ' · ' : null}
              {stale && <Freshness observedAt={observedAt} state="stale" />}
            </>
          ) : undefined
        }
        action={
          action
            ? { label: action.label, busy: running === action.capability.id, onClick: () => onRun(action) }
            : undefined
        }
      />
    )
  }
  // Information alone (a limited reading, a source with sync off) is never an alarm and never the headline:
  // when it is all there is, the page says it is normal and points to the notes.
  const informationOnly = verdict.conditions.length > 0 && verdict.conditions.every((condition) => condition.kind === 'info')
  const unread = verdict.state === 'unavailable' && !informationOnly
  const sentence = informationOnly && verdict.state !== 'healthy' && verdict.state !== 'inactive' ? 'GBrain is normal' : verdict.text
  const note = informationOnly && sentence !== verdict.text ? 'Some readings are limited: see Notes' : verdict.caveat
  return (
    <div className={styles.quiet} data-state={unread ? 'unavailable' : 'healthy'}>
      <StateMark state={unread ? 'unavailable' : 'healthy'} />
      <p className={styles.sentence} role="status">
        {sentence}
      </p>
      {note && <span className={styles.caveat}>{note}</span>}
      <Freshness observedAt={observedAt} state={stale ? 'stale' : observedAt ? 'fresh' : 'unavailable'} />
      {unread && onRunCheck && (
        <Button className={styles.run} loading={checkRunning} disabled={runCheckDisabled} onClick={onRunCheck}>
          Run check
        </Button>
      )}
    </div>
  )
}
