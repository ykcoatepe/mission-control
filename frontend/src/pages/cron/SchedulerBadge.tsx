import type { CSSProperties } from 'react'
import { getCronSchedulerColor, getCronSchedulerLabel } from './lib'
import type { CronJob } from './types'
import styles from './SchedulerBadge.module.css'

export default function SchedulerBadge({ job }: { job: CronJob }) {
  const color = getCronSchedulerColor(job)
  return (
    <span
      className={styles.badge}
      style={{ '--scheduler-color': color } as CSSProperties}
    >
      {getCronSchedulerLabel(job)}
    </span>
  )
}
