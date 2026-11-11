import { Meter, Mono, Panel } from '../../components/ui'
import type { UiState } from '../../lib/state'
import { formatCurrency } from './lib'
import type { AWSSCostData } from './types'
import styles from './BudgetPanel.module.css'

interface AwsCreditsPanelProps {
  awsCosts: AWSSCostData
  creditsUsed: number
  /** Days the remaining credits last at the current rate; Infinity when nothing has been used. */
  burnRate: number
  dailyAvg: number
}

function creditState(share: number): UiState {
  if (share > 0.75) return 'critical'
  if (share > 0.5) return 'warning'
  return 'healthy'
}

/** AWS credit balance. Only rendered while live AWS billing is the selected source. */
export default function AwsCreditsPanel({ awsCosts, creditsUsed, burnRate, dailyAvg }: AwsCreditsPanelProps) {
  const share = awsCosts.credits > 0 ? creditsUsed / awsCosts.credits : null
  return (
    <Panel title="AWS credits" description="How long the remaining balance lasts at the current rate.">
      <div className={styles.body}>
        <div className={styles.progress}>
          <div className={styles.progressLine}>
            <span className={styles.progressLabel}>Used</span>
            <Mono>
              {formatCurrency(creditsUsed)} of {formatCurrency(awsCosts.credits)}
            </Mono>
          </div>
          <Meter
            label="AWS credits used"
            value={share === null ? null : share * 100}
            state={share === null ? 'unavailable' : creditState(share)}
          />
          <div className={styles.progressLine}>
            <span className={styles.muted}>{formatCurrency(awsCosts.remaining)} left</span>
            <span className={styles.muted}>
              {burnRate === Infinity ? 'No burn yet' : `${Math.round(burnRate)} days at ${formatCurrency(dailyAvg)}/day`}
            </span>
          </div>
        </div>
      </div>
    </Panel>
  )
}
