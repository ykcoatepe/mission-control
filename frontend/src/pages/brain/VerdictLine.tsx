import { Button, StateDot, TimeAgo } from '../../components/ui'
import type { Verdict } from './lib'
import styles from './VerdictLine.module.css'

/** The page's answer in one sentence, with when it was last read and the one refresh that is allowed. */
export function VerdictLine({
  verdict,
  probeAt,
  caveat = null,
  stale,
  verifying,
  onRunCheck,
  runCheckDisabled,
  running,
}: {
  verdict: Verdict
  probeAt: string | null
  /** What the reading could not observe, kept next to a normal verdict. */
  caveat?: string | null
  stale: boolean
  verifying: boolean
  /** Runs the fast doctor Check through the action flow; never a page reload. */
  onRunCheck?: () => void
  runCheckDisabled: boolean
  running: boolean
}) {
  return (
    <div className={styles.verdict} data-state={verdict.state}>
      <StateDot state={verdict.state} className={styles.dot} />
      <div className={styles.text}>
        <p className={styles.sentence} role="status">
          {verdict.text}
        </p>
        <p className={styles.probe}>
          last probe <TimeAgo value={probeAt} fallback="not read" />
          {stale && <span className={styles.stale}> · stale</span>}
          {caveat && <span> · {caveat}</span>}
          {verifying && <span className={styles.stale}> · verifying, waiting for a newer reading</span>}
        </p>
      </div>
      {onRunCheck && (
        <Button className={styles.run} loading={running} disabled={runCheckDisabled} onClick={onRunCheck}>
          Run check
        </Button>
      )}
    </div>
  )
}
