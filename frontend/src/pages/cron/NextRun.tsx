import { StateDot, TimeAgo } from '../../components/ui'
import { overdueSince } from './overdue'
import type { CronJob } from './types'
import styles from './NextRun.module.css'

/**
 * When a job runs next. A job that is on but whose next run is already in the past is overdue, in warning
 * tone: the scheduler has not run it when it said it would. It is never shown as a next run.
 */
export function NextRun({ job, className }: { job: Pick<CronJob, 'enabled' | 'nextRun' | 'nextRunOverdue' | 'nextRunDue'>; className?: string }) {
  if (!job.enabled) return <>—</>
  const since = job.nextRunOverdue ? overdueSince(job.nextRun) : null
  if (since) {
    return (
      <span className={styles.overdue} data-state="warning">
        <StateDot state="warning" />
        Overdue since {since}
      </span>
    )
  }
  // Past its time but inside the server's grace window: the scheduler is about to run it.
  if (job.nextRunDue) return <span className={className}>Due now</span>
  return <TimeAgo className={className} value={job.nextRun} />
}
