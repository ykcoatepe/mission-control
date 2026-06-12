import { Fragment } from 'react'
import type { CSSProperties } from 'react'
import { Clock, Play, RotateCcw, Trash2, Cpu } from 'lucide-react'
import { motion } from 'framer-motion'
import GlassCard from '../../components/GlassCard'
import StatusBadge from '../../components/StatusBadge'
import { timeAgo, formatDate } from '../../lib/hooks'
import { normalizeCronStatus } from '../../lib/status'
import {
  calcSuccessRate,
  getCronScheduler,
  getCronSchedulerColor,
  getCronSchedulerLabel,
  normalizeCronModelValue,
  rowStaggerDelay,
} from './lib'
import type { CronJob, CronOverlapMarker, ModelOption } from './types'
import SchedulerBadge from './SchedulerBadge'
import SuccessBar from './SuccessBar'
import ToggleSwitch from './ToggleSwitch'
import styles from './JobsTable.module.css'

interface JobsTableProps {
  jobs: CronJob[]
  overlapMarkers: Map<string, CronOverlapMarker>
  modelOptions: ModelOption[]
  displayModel: (model?: string) => string
  pendingAction: string | null
  onToggle: (job: CronJob) => void
  onRun: (job: CronJob) => void
  onDelete: (job: CronJob) => void
  onModelChange: (job: CronJob, model: string) => void
}

export default function JobsTable({
  jobs,
  overlapMarkers,
  modelOptions,
  displayModel,
  pendingAction,
  onToggle,
  onRun,
  onDelete,
  onModelChange,
}: JobsTableProps) {
  return (
    <GlassCard delay={0.2} hover={false} noPad>
      <div className={styles.tableWrap}>
        <div className={styles.tableInner}>
          <div className={`${styles.tableGrid} ${styles.tableHead}`}>
            {['Name', 'Source', 'Schedule', 'Status', 'Last Run', 'Next Run', 'Model', 'Actions'].map((h) => (
              <span key={h} className={styles.tableHeadCell}>{h}</span>
            ))}
          </div>
          {jobs.map((job, i) => {
            const normStatus = normalizeCronStatus(job.status, job.enabled)
            const isFailed = normStatus === 'failed'
            const sr = calcSuccessRate(job.history)
            const overlapMarker = overlapMarkers.get(job.id)
            const showGroupHeader = i === 0 || getCronScheduler(jobs[i - 1]) !== getCronScheduler(job)
            return (
              <Fragment key={job.id}>
                {showGroupHeader ? (
                  <div
                    className={i === 0 ? `${styles.tableGroupHeader} ${styles.tableGroupHeaderFirst}` : styles.tableGroupHeader}
                    style={{ '--scheduler-color': getCronSchedulerColor(job) } as CSSProperties}
                  >
                    {getCronSchedulerLabel(job)} · {jobs.filter((candidate) => getCronScheduler(candidate) === getCronScheduler(job)).length} jobs
                  </div>
                ) : null}
                <motion.div
                  key={job.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: rowStaggerDelay(i, 0.25, 0.04) }}
                  className={[styles.tableGrid, styles.tableRow, isFailed ? styles.tableRowFailed : ''].join(' ')}
                >
                  {/* Name */}
                  <div className={styles.tableCell}>
                    <p title={job.name} className={[styles.cellName, isFailed ? styles.cellNameFailed : ''].join(' ')}>{job.name}</p>
                    <p title={job.sourceId || job.id} className={styles.cellId}>{job.sourceId || job.id}</p>
                  </div>
                  <div className={styles.tableCell}><SchedulerBadge job={job} /></div>
                  {/* Schedule */}
                  <div className={styles.tableCell}>
                    <div className={styles.scheduleColInner}>
                      <code className={styles.scheduleCode}>{job.schedule}</code>
                      {overlapMarker ? (
                        <span title={overlapMarker.detail} className={styles.overlapTag}>
                          <Clock size={10} />
                          {overlapMarker.count} jobs
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {/* Status */}
                  <div className={`${styles.tableCell} ${styles.statusCell}`}>
                    <ToggleSwitch
                      enabled={job.enabled}
                      onChange={() => onToggle(job)}
                      disabled={job.actions?.toggle === false}
                    />
                    <div className={styles.statusCellInner}>
                      <StatusBadge status={normStatus} label={job.enabled ? job.status : 'disabled'} />
                      {sr ? <div className={styles.successBarWrap}><SuccessBar rate={sr} /></div> : null}
                    </div>
                  </div>
                  {/* Last Run */}
                  <div className={styles.tableCell}>
                    {job.lastRun ? (
                      <>
                        <p className={styles.timeCell}>{timeAgo(job.lastRun)}</p>
                        <p className={styles.timeCellSub}>{formatDate(job.lastRun)}</p>
                      </>
                    ) : <span className={styles.timeCellEmpty}>—</span>}
                  </div>
                  {/* Next Run */}
                  <div className={styles.tableCell}>
                    {job.nextRun ? (
                      <>
                        <p className={styles.timeCell}>{timeAgo(job.nextRun)}</p>
                        <p className={styles.timeCellSub}>{formatDate(job.nextRun)}</p>
                      </>
                    ) : <span className={styles.timeCellEmpty}>—</span>}
                  </div>
                  {/* Model */}
                  <div className={`${styles.tableCell} ${styles.modelCell}`}>
                    <Cpu size={12} color='#8e8e93' />
                    {job.payload === 'agentTurn' ? (
                      <select
                        value={normalizeCronModelValue(job.model) || ''}
                        onChange={(e) => onModelChange(job, e.target.value)}
                        disabled={pendingAction === `model-${job.id}` || job.actions?.model === false}
                        aria-label={`Change model for ${job.name}`}
                        title={`Change model: ${displayModel(job.model)}`}
                        className={styles.modelSelect}
                      >
                        {modelOptions.map((option) => (
                          <option key={option.value || 'default'} value={option.value} title={option.value || 'Default'}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className={styles.modelText}>{job.model || 'default'}</span>
                    )}
                  </div>
                  {/* Actions */}
                  <div className={`${styles.tableCell} ${styles.actionsCell}`}>
                    <button
                      onClick={() => onRun(job)}
                      disabled={pendingAction === `run-${job.id}` || job.actions?.run === false}
                      title="Run now"
                      className={styles.runBtn}
                    >
                      {pendingAction === `run-${job.id}` ? (
                        <RotateCcw size={14} className={styles.spinIcon} />
                      ) : (
                        <Play size={14} />
                      )}
                    </button>
                    <button
                      onClick={() => onDelete(job)}
                      disabled={pendingAction === `delete-${job.id}` || job.actions?.delete === false}
                      title="Delete"
                      className={styles.deleteBtn}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </motion.div>
              </Fragment>
            )
          })}
        </div>
      </div>
    </GlassCard>
  )
}
