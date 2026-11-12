import { AnalogBar, Block } from '../../components/ui'
import type { UiState } from '../../lib/state'
import { embeddedPercent } from './diagram'
import { fmtCount, type ReadingSet, type Verdict } from './lib'
import type { GBrainSynoptic, TrendsReading } from './types'
import { QUALITY_NORMAL, queueScaleMax, trendOf } from './bars'
import styles from './ReadingsBars.module.css'

export interface BarsProps {
  syn: GBrainSynoptic
  verdict: Verdict
  readings: ReadingSet
  trends: TrendsReading | null
}

const num = (value: number | null | undefined): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

const fmtPercentValue = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)}%`

/** Quality, embedded and queue as analog bars: a normal band where the server defines one, and the 24-hour trend where the ledger has one. */
export function ReadingsBars({ syn, verdict, readings, trends }: BarsProps) {
  const quality = num(syn.core.quality?.value)
  const percent = embeddedPercent(syn.core)
  const waiting = num(syn.queue.waiting?.value)
  const active = num(syn.queue.active?.value)
  const stalled = num(syn.queue.stalled?.value)
  const queueRead = waiting !== null && active !== null && stalled !== null
  const total = queueRead ? waiting + active + stalled : 0

  const missingReason = verdict.conditions.find((condition) => condition.id === 'missing-embeddings' && condition.kind === 'action')
  const embeddedState: UiState | undefined = missingReason && (missingReason.state === 'warning' || missingReason.state === 'critical') ? missingReason.state : undefined

  return (
    <Block title="Readings" meta="24-hour trends" className={styles.block}>
      <div className={styles.bars}>
        <AnalogBar
          label="Quality, out of 100"
          value={quality}
          min={0}
          max={100}
          band={QUALITY_NORMAL}
          limits={[0, ...QUALITY_NORMAL]}
          format={(n) => (Number.isInteger(n) ? String(n) : n.toFixed(1))}
          state={readings.quality.state}
          unread={quality === null}
          trend={trendOf(trends?.series.quality)}
          className={styles.fill}
        />
        <div className={styles.bar}>
          <AnalogBar
            label="Embedded"
            value={percent}
            min={0}
            max={100}
            limits={[0, 100]}
            format={fmtPercentValue}
            state={embeddedState}
            unread={percent === null}
            trend={trendOf(trends?.series.embeddedPercent)}
            className={styles.fill}
          />
          {percent !== null && (
            <p className={styles.note}>
              {fmtCount(num(syn.core.embedded?.value))} of {fmtCount(num(syn.core.chunks?.value))} chunks
            </p>
          )}
        </div>
        <div className={styles.bar}>
          <AnalogBar
            label={queueRead ? `Queue (total ${fmtCount(total)})` : 'Queue'}
            value={queueRead ? total : null}
            min={0}
            max={queueScaleMax(total)}
            limits={[0, queueScaleMax(total)]}
            format={(n) => fmtCount(n)}
            state={readings.queue.state}
            unread={!queueRead}
            trend={trendOf(trends?.series.queue)}
            className={styles.fill}
          />
          {queueRead && (
            <p className={styles.note}>
              {fmtCount(waiting)} waiting, {fmtCount(active)} active, {fmtCount(stalled)} stalled. Normal: 0 stalled.
            </p>
          )}
        </div>
      </div>
    </Block>
  )
}
