import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Clock, Play, Plus, Trash2 } from 'lucide-react'
import {
  Button,
  DataTable,
  Dialog,
  EmptyState,
  ErrorState,
  FilterChips,
  IconButton,
  Mono,
  Notice,
  Panel,
  SearchInput,
  Skeleton,
  StateDot,
  StatePill,
  Stat,
  StatRow,
  Switch,
  TimeAgo,
  useToast,
} from '../../components/ui'
import type { DataTableColumn } from '../../components/ui'
import { useApi } from '../../lib/hooks'
import { applyCommitted, isStaleWrite, isUnconfirmedWrite, isUpstreamRefusal } from '../../lib/writes'
import { StaleWriteNote } from '../../components/StaleWriteNote'
import { useNow } from '../../lib/useNow'
import { normalizeCronStatus } from '../../lib/status'
import {
  buildCronModelOptions,
  buildCronOverlapMarkers,
  applyCronWrite,
  cronWrite,
  errorMessage,
  getCronScheduler,
  getCronSchedulerLabel,
  normalizeCronModelValue,
} from './lib'
import type { CronWriteArg, CronWriteResponse } from './lib'
import type {
  CreateCronJobPayload,
  CronApiResponse,
  CronJob,
  CronModelResponse,
  CronScheduler,
  CronStatusFilter,
} from './types'
import { jobState } from './jobState'
import { NextRun } from './NextRun'
import { scheduleDisplay } from './cronSchedule'
import { isJobOn, summarizeJobs } from './jobsSummary'
import {
  SCHEDULERS,
  SCHEDULER_NAMES,
  joinNames,
  readSchedulers,
  readingNotices,
  schedulersIn,
  useLastGoodReadings,
} from './schedulerReadings'
import { oneOf, useQueryParam, useQueryParams } from './urlState'
import CreateJobDialog from './CreateJobDialog'
import JobDrawer from './JobDrawer'
import styles from './JobsView.module.css'

type SchedulerFilter = 'all' | CronScheduler

const STATE_FILTERS = ['all', 'active', 'disabled', 'failed', 'overlap'] as const
const SCHEDULER_FILTERS = ['all', 'openclaw', 'hermes'] as const

const stopRowClick = (event: { stopPropagation: () => void }) => event.stopPropagation()

const STATE_RANK = { critical: 0, healthy: 1, unavailable: 1, inactive: 2, warning: 1 } as const

/** A short hint with the server's own definition of the count as its tooltip. */
function defined(hint: string | undefined, definition: string | undefined) {
  if (!definition || !hint) return hint
  return <span title={definition}>{hint}</span>
}

export default function JobsView() {
  const { data, loading, error, refetch } = useApi<CronApiResponse>('/api/cron', 30000)
  const { data: modelsData } = useApi<CronModelResponse[]>('/api/models', 60000)
  const toast = useToast()
  const queryClient = useQueryClient()
  const now = useNow()
  const [params, setParams] = useSearchParams()
  const [showCreate, setShowCreate] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<CronJob | null>(null)
  const [runTarget, setRunTarget] = useState<CronJob | null>(null)
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  // The last write succeeded but the server could not confirm its follow-up reading yet.
  const [writeNote, setWriteNote] = useState<'stale' | 'unconfirmed' | null>(null)
  // What the system said when it refused a change, by job: shown next to the control until the job is changed again.
  const [refusals, setRefusals] = useState<Record<string, string>>({})
  // A job that was just created: tagged for a few seconds, scrolled to and focused once its row is on screen.
  const [justCreated, setJustCreated] = useState<string | null>(null)
  const [focusRequest, setFocusRequest] = useState<{ id: string; nonce: number } | null>(null)
  const focused = useRef(0)
  // A created job the current search or filters would hide: said, with a way to see it.
  const [hiddenCreated, setHiddenCreated] = useState<{ id: string; name: string } | null>(null)
  // A confirmation opened from the drawer hides the drawer; when it closes, focus goes back to the button that opened it.
  const returnFocus = useRef<'run' | 'delete' | null>(null)
  // Filters and search live in the URL, so a reload or a shared link keeps them.
  const [stateParam, setStateParam] = useQueryParam('state')
  const [schedulerParam, setSchedulerParam] = useQueryParam('scheduler')
  const [searchParam, setSearchParam] = useQueryParam('q')
  const setQueryParams = useQueryParams()
  const statusFilter: CronStatusFilter = oneOf(stateParam, STATE_FILTERS, 'all')
  const schedulerFilter: SchedulerFilter = oneOf(schedulerParam, SCHEDULER_FILTERS, 'all')
  const jobSearch = searchParam ?? ''
  const setStatusFilter = (value: CronStatusFilter) => setStateParam(value === 'all' ? null : value)
  const setSchedulerFilter = (value: SchedulerFilter) => setSchedulerParam(value === 'all' ? null : value)
  const setJobSearch = (value: string) => setSearchParam(value.trim() === '' ? null : value)

  const jobs = useMemo<CronJob[]>(() => data?.jobs || [], [data?.jobs])
  // Which schedulers were actually read. A scheduler that was not read has no jobs in the list,
  // which must never look like "no jobs" or "nothing failed".
  const lastGood = useLastGoodReadings(readSchedulers(data, now))
  const readings = useMemo(() => readSchedulers(data, now, lastGood), [data, now, lastGood])
  const notRead = schedulersIn(readings, 'not-read')
  const incomplete = notRead.length > 0
  const notices = readingNotices(readings, data?.meta, now)
  const modelOptions = useMemo(
    () => buildCronModelOptions(Array.isArray(modelsData) ? modelsData : [], jobs),
    [modelsData, jobs],
  )
  const modelLabelByValue = useMemo(
    () => new Map(modelOptions.map((option) => [option.value, option.label])),
    [modelOptions],
  )
  const displayModel = (model?: string) => {
    const normalized = normalizeCronModelValue(model) || ''
    return modelLabelByValue.get(normalized) || normalized || 'Default'
  }
  const overlapState = useMemo(() => buildCronOverlapMarkers(jobs), [jobs])

  // ---- summary ----

  const summary = useMemo(() => summarizeJobs(jobs, data?.summary, now), [jobs, data?.summary, now])

  const schedulerCounts = useMemo(
    () => ({
      openclaw: jobs.filter((job) => getCronScheduler(job) === 'openclaw').length,
      hermes: jobs.filter((job) => getCronScheduler(job) === 'hermes').length,
    }),
    [jobs],
  )

  // ---- filtering ----

  const filteredJobs = useMemo(() => {
    const query = jobSearch.trim().toLowerCase()
    let result = jobs
    if (schedulerFilter !== 'all') result = result.filter((job) => getCronScheduler(job) === schedulerFilter)
    if (query) {
      result = result.filter((job) =>
        [job.name, job.id, job.sourceId, job.description, getCronSchedulerLabel(job)].some((value) =>
          String(value || '').toLowerCase().includes(query),
        ),
      )
    }
    if (statusFilter === 'overlap') {
      result = result.filter((job) => overlapState.markers.has(job.id))
    } else if (statusFilter === 'active') {
      // "Active" is every job switched on, which is what the summary counts too.
      result = result.filter(isJobOn)
    } else if (statusFilter !== 'all') {
      result = result.filter((job) => normalizeCronStatus(job.status, job.enabled) === statusFilter)
    }
    return [...result].sort((left, right) => {
      // Failed first, paused last, then by scheduler and name.
      const rank = STATE_RANK[jobState(left).state] - STATE_RANK[jobState(right).state]
      if (rank !== 0) return rank
      const order = { openclaw: 0, hermes: 1 } as const
      const schedulerOrder = order[getCronScheduler(left)] - order[getCronScheduler(right)]
      if (schedulerOrder !== 0) return schedulerOrder
      return String(left.name || '').localeCompare(String(right.name || ''))
    })
  }, [jobs, jobSearch, overlapState, schedulerFilter, statusFilter])

  /** Whether the current search and filters would list this job (the overlap filter needs the whole list, so it counts as hiding). */
  const passesFilters = (job: CronJob) => {
    const query = jobSearch.trim().toLowerCase()
    if (schedulerFilter !== 'all' && getCronScheduler(job) !== schedulerFilter) return false
    if (
      query &&
      ![job.name, job.id, job.sourceId, job.description, getCronSchedulerLabel(job)].some((value) =>
        String(value || '').toLowerCase().includes(query),
      )
    )
      return false
    if (statusFilter === 'overlap') return overlapState.markers.has(job.id)
    if (statusFilter === 'active') return isJobOn(job)
    if (statusFilter !== 'all') return normalizeCronStatus(job.status, job.enabled) === statusFilter
    return true
  }

  const hasActiveFilters = statusFilter !== 'all' || schedulerFilter !== 'all' || jobSearch.trim() !== ''

  const clearFilters = () => setQueryParams({ state: null, scheduler: null, q: null })

  // ---- selected job (?job=<id>) ----

  const jobParam = params.get('job')
  const selectedJob = useMemo(
    () => (jobParam ? jobs.find((job) => job.id === jobParam || job.sourceId === jobParam) ?? null : null),
    [jobParam, jobs],
  )

  const setJobParam = (id: string | null) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (id) next.set('job', id)
        else next.delete('job')
        return next
      },
      { replace: true },
    )
  }

  // ---- write mutations ----

  const toggleMutation = useMutation({
    mutationFn: (job: CronJob) =>
      cronWrite(`/api/cron/${job.id}/toggle`, 'POST', { enabled: !job.enabled, scheduler: getCronScheduler(job) }),
  })

  const runMutation = useMutation({
    mutationFn: (job: CronJob) =>
      cronWrite(`/api/cron/${job.id}/run`, 'POST', { scheduler: getCronScheduler(job) }),
  })

  const deleteMutation = useMutation({
    mutationFn: (job: CronJob) =>
      cronWrite(`/api/cron/${job.id}`, 'DELETE', { scheduler: getCronScheduler(job) }),
  })

  const createMutation = useMutation({
    mutationFn: (job: CreateCronJobPayload) =>
      cronWrite('/api/cron/create', 'POST', { job }),
  })

  const modelMutation = useMutation({
    mutationFn: ({ job, model }: { job: CronJob; model: string }) =>
      cronWrite(`/api/cron/${job.id}/model`, 'PATCH', { model, scheduler: getCronScheduler(job) }),
  })

  /** Shows what the server committed at once, then refetches. A reading that is still catching up is said so, calmly. */
  const showCommitted = async (
    response: CronWriteResponse | null,
    write: (response: CronWriteResponse | null) => CronWriteArg,
  ) => {
    setWriteNote(isUnconfirmedWrite(response) ? 'unconfirmed' : isStaleWrite(response) ? 'stale' : null)
    await applyCommitted<CronApiResponse>(queryClient, '/api/cron', (current) => applyCronWrite(current, write(response)))
  }

  const clearRefusal = (job: CronJob) =>
    setRefusals((prev) => {
      if (!(job.id in prev)) return prev
      const { [job.id]: _removed, ...rest } = prev
      void _removed
      return rest
    })

  /**
   * A change the system refused (409 upstream_rejected / upstream_unverified): its own message, next to the
   * control, and the real state read again. No requested value stays on screen.
   */
  const refuse = (job: CronJob, err: unknown, fallback: string) => {
    setRefusals((prev) => ({ ...prev, [job.id]: errorMessage(err) }))
    setWriteNote(null)
    toast.show('error', `${fallback}: ${errorMessage(err)}`)
    void queryClient.invalidateQueries({ queryKey: ['api', '/api/cron'] })
  }

  const handleToggle = async (job: CronJob) => {
    if (job.actions?.toggle === false) return
    setPendingAction(`toggle-${job.id}`)
    clearRefusal(job)
    try {
      const response = await toggleMutation.mutateAsync(job)
      await showCommitted(response, (r) => ({ kind: 'update', jobId: job.id, response: r }))
    } catch (err) {
      if (isUpstreamRefusal(err)) refuse(job, err, `"${job.name}" was not changed`)
      else toast.show('error', `Failed to toggle "${job.name}": ${errorMessage(err)}`)
    } finally {
      setPendingAction(null)
    }
  }

  const requestRun = (job: CronJob, fromDrawer = false) => {
    if (job.actions?.run === false) return
    returnFocus.current = fromDrawer ? 'run' : null
    setRunTarget(job)
  }

  const confirmRun = async () => {
    const job = runTarget
    if (!job) return
    setPendingAction(`run-${job.id}`)
    try {
      const response = await runMutation.mutateAsync(job)
      if (isUnconfirmedWrite(response)) toast.show('warning', `"${job.name}": run sent, not yet confirmed`)
      else toast.show('success', `"${job.name}" triggered`)
      await showCommitted(response, (r) => ({ kind: 'update', jobId: job.id, response: r }))
    } catch (err) {
      if (isUpstreamRefusal(err)) refuse(job, err, `"${job.name}" did not run`)
      else toast.show('error', `Run failed: ${errorMessage(err)}`)
    } finally {
      setRunTarget(null)
      setPendingAction(null)
    }
  }

  const requestDelete = (job: CronJob, fromDrawer = false) => {
    if (job.actions?.delete === false) return
    returnFocus.current = fromDrawer ? 'delete' : null
    setDeleteTarget(job)
  }

  const confirmDelete = async () => {
    const job = deleteTarget
    if (!job) return
    setPendingAction(`delete-${job.id}`)
    try {
      const response = await deleteMutation.mutateAsync(job)
      if (isUnconfirmedWrite(response)) toast.show('warning', `"${job.name}": delete sent, not yet confirmed`)
      else {
        toast.show('success', `"${job.name}" deleted`)
        if (selectedJob?.id === job.id) setJobParam(null)
      }
      await showCommitted(response, (r) => ({ kind: 'delete', jobId: job.id, response: r }))
    } catch (err) {
      if (isUpstreamRefusal(err)) refuse(job, err, `"${job.name}" was not deleted`)
      else toast.show('error', `Delete failed: ${errorMessage(err)}`)
    } finally {
      setDeleteTarget(null)
      setPendingAction(null)
    }
  }

  const revealCreated = (id: string) => {
    setHiddenCreated(null)
    setJustCreated(id)
    setFocusRequest({ id, nonce: Date.now() + Math.random() })
  }

  const showHiddenCreated = () => {
    if (!hiddenCreated) return
    clearFilters()
    revealCreated(hiddenCreated.id)
  }

  useEffect(() => {
    if (!justCreated) return
    const timer = window.setTimeout(() => setJustCreated(null), 6000)
    return () => window.clearTimeout(timer)
  }, [justCreated])

  // Scroll to the new row and focus it, once it is rendered and the create dialog has closed.
  useEffect(() => {
    if (!focusRequest || showCreate || focused.current === focusRequest.nonce) return
    const mark = [...document.querySelectorAll<HTMLElement>('[data-created-job]')].find(
      (element) => element.dataset.createdJob === focusRequest.id,
    )
    const row = mark?.closest('tr')
    if (!row) return
    focused.current = focusRequest.nonce
    row.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    row.focus({ preventScroll: true })
  })

  const handleCreateJob = async (job: CreateCronJobPayload) => {
    try {
      const response = await createMutation.mutateAsync(job)
      const unconfirmed = isUnconfirmedWrite(response)
      if (unconfirmed) toast.show('warning', `"${job.name}": create sent, not yet confirmed`)
      else toast.show('success', `"${job.name}" created`)
      await showCommitted(response, (r) => ({ kind: 'create', response: r }))
      const created = response?.entity ?? response?.job
      if (!unconfirmed && created?.id && created.name) {
        if (passesFilters(created as CronJob)) revealCreated(created.id)
        else setHiddenCreated({ id: created.id, name: created.name })
      }
    } catch (err) {
      toast.show('error', `${isUpstreamRefusal(err) ? 'Not created' : 'Create failed'}: ${errorMessage(err)}`)
      if (isUpstreamRefusal(err)) void queryClient.invalidateQueries({ queryKey: ['api', '/api/cron'] })
      throw err
    }
  }

  const handleModelChange = async (job: CronJob, model: string) => {
    if (job.actions?.model === false) return
    setPendingAction(`model-${job.id}`)
    clearRefusal(job)
    try {
      const response = await modelMutation.mutateAsync({ job, model })
      if (isUnconfirmedWrite(response)) toast.show('warning', `"${job.name}": model change sent, not yet confirmed`)
      else toast.show('success', `"${job.name}" model set to ${model || 'default'}`)
      await showCommitted(response, (r) => ({ kind: 'update', jobId: job.id, response: r }))
    } catch (err) {
      if (isUpstreamRefusal(err)) refuse(job, err, `"${job.name}" model was not changed`)
      else toast.show('error', `Model update failed: ${errorMessage(err)}`)
    } finally {
      setPendingAction(null)
    }
  }

  const confirming = runTarget !== null || deleteTarget !== null
  useEffect(() => {
    if (confirming || !returnFocus.current) return
    const kind = returnFocus.current
    returnFocus.current = null
    document.querySelector<HTMLElement>(`[data-return-focus="${kind}"]`)?.focus()
  }, [confirming])

  // ---- table ----

  const columns: DataTableColumn<CronJob>[] = [
    {
      key: 'name',
      header: 'Name',
      cell: (job) => (
        <div className={styles.nameCell}>
          <span className={styles.name}>
            {job.name}
            {justCreated === job.id && (
              <span className={styles.createdTag} data-created-job={job.id}>
                Created
              </span>
            )}
          </span>
          <span className={styles.meta}>
            {getCronSchedulerLabel(job)} · <Mono muted>{job.sourceId || job.id}</Mono>
          </span>
        </div>
      ),
    },
    {
      key: 'schedule',
      header: 'Schedule',
      cell: (job) => {
        const overlap = overlapState.markers.get(job.id)
        const schedule = scheduleDisplay(job.schedule, job.scheduleKind)
        return (
          <div className={styles.scheduleCell}>
            {schedule.raw ? <Mono>{schedule.text}</Mono> : <span className={styles.unknown}>{schedule.text}</span>}
            {overlap && (
              <span className={styles.overlap} title={overlap.detail}>
                <Clock size={12} aria-hidden="true" />
                {overlap.count} jobs, same time slot
              </span>
            )}
          </div>
        )
      },
    },
    {
      key: 'state',
      header: 'State',
      cell: (job) => {
        const state = jobState(job)
        return (
          <div className={styles.stateCell} onClick={stopRowClick} onKeyDown={stopRowClick}>
            {job.actions?.toggle !== false && (
              <Switch
                checked={job.enabled}
                onChange={() => handleToggle(job)}
                disabled={pendingAction === `toggle-${job.id}`}
                aria-label={`${job.name} enabled`}
              />
            )}
            <StatePill state={state.state} label={state.label} />
            {job.verified === false && (
              <span className={styles.unconfirmed}>
                <StateDot state="warning" />
                Not confirmed
              </span>
            )}
            {refusals[job.id] && (
              <span className={styles.refusal} role="alert">
                {refusals[job.id]}
              </span>
            )}
          </div>
        )
      },
    },
    {
      key: 'last',
      header: 'Last run',
      cell: (job) => <TimeAgo className={styles.time} value={job.lastRun} />,
    },
    {
      key: 'next',
      header: 'Next run',
      cell: (job) => <NextRun className={styles.time} job={job} />,
    },
    {
      key: 'model',
      header: 'Model',
      hideOnMobile: true,
      cell: (job) =>
        job.payload === 'agentTurn' ? (
          <span className={styles.model} title={displayModel(job.model)}>
            {displayModel(job.model)}
          </span>
        ) : (
          <span className={styles.model}>{job.model || '—'}</span>
        ),
    },
    {
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      mobileLabel: 'Actions',
      align: 'end',
      width: '136px',
      cell: (job) => {
        const canRun = job.actions?.run !== false
        const canDelete = job.actions?.delete !== false
        if (!canRun && !canDelete) return null
        return (
          <div className={styles.rowActions} onClick={stopRowClick} onKeyDown={stopRowClick}>
            {canRun && (
              <Button
                size="sm"
                variant="ghost"
                icon={<Play size={12} />}
                loading={pendingAction === `run-${job.id}`}
                onClick={() => requestRun(job)}
                aria-label={`Run ${job.name} now`}
              >
                Run now
              </Button>
            )}
            {canDelete && (
              <IconButton
                size="sm"
                label={`Delete ${job.name}`}
                icon={<Trash2 size={14} />}
                disabled={pendingAction === `delete-${job.id}`}
                onClick={() => requestDelete(job)}
              />
            )}
          </div>
        )
      },
    },
  ]

  if (loading && !data) {
    return (
      <div className={styles.view}>
        <Skeleton variant="block" label="Loading automations" />
        <Skeleton lines={8} label="Loading jobs" />
      </div>
    )
  }

  if (error && !data) {
    return <ErrorState title="Automations could not be read" message={error} onRetry={refetch} />
  }

  // With a scheduler unread, the totals would be a count of part of the jobs: they are not read, not smaller.
  const stateChip = (value: string, label: string, count: number) =>
    incomplete ? { value, label: `${label} —` } : { value, label, count }
  const stateOptions = [
    { value: 'all', label: 'All' },
    stateChip('active', 'Active', summary.active),
    stateChip('disabled', 'Paused', summary.paused),
    stateChip('failed', 'Failed', summary.failed),
    ...(overlapState.affectedJobs > 0 || statusFilter === 'overlap'
      ? [{ value: 'overlap', label: 'Same time slot', count: overlapState.affectedJobs }]
      : []),
  ]

  const schedulerOptions = [
    { value: 'all', label: 'All schedulers' },
    ...SCHEDULERS.map((scheduler) =>
      readings[scheduler].state === 'not-read'
        ? { value: scheduler, label: `${SCHEDULER_NAMES[scheduler]} · not read` }
        : { value: scheduler, label: SCHEDULER_NAMES[scheduler], count: schedulerCounts[scheduler] },
    ),
  ]

  // The failed count is shown once, in its own card.
  const activeHint = summary.waiting > 0 ? `${summary.waiting} waiting for a first result` : undefined
  const notReadHint = incomplete ? `${joinNames(notRead)} not read` : undefined
  const filteredUnread = schedulerFilter !== 'all' && readings[schedulerFilter].state === 'not-read'

  return (
    <div className={styles.view}>
      <StaleWriteNote show={writeNote !== null} unconfirmed={writeNote === 'unconfirmed'} />
      {hiddenCreated && (
        <Notice
          tone="info"
          title="Created, hidden by the current filter"
          action={<Button size="sm" onClick={showHiddenCreated}>Show it</Button>}
        >
          “{hiddenCreated.name}” was created, but the current search or filters do not list it.
        </Notice>
      )}
      {notices.map((notice) => (
        <Notice key={notice.id} tone={notice.tone} title={notice.title}>
          {notice.body}
        </Notice>
      ))}

      <StatRow aria-label="Automations summary">
        <Stat
          label="Active"
          value={incomplete ? null : summary.active}
          hint={incomplete ? notReadHint : defined(activeHint, data?.summary?.definitions?.active)}
        />
        <Stat label="Paused" value={incomplete ? null : summary.paused} hint={notReadHint} />
        <Stat
          label="Failed"
          value={incomplete ? null : summary.failed}
          state={!incomplete && summary.failed > 0 ? 'critical' : undefined}
          hint={
            incomplete
              ? notReadHint
              : defined(summary.failed > 0 ? 'Last run failed' : undefined, data?.summary?.definitions?.failed)
          }
        />
        <Stat
          label="Next run"
          value={!incomplete && summary.nextRun ? <TimeAgo value={summary.nextRun.at} /> : null}
          hint={incomplete ? notReadHint : (summary.nextRun?.name ?? undefined)}
        />
      </StatRow>

      <div className={styles.toolbar}>
        <FilterChips
          ariaLabel="Filter by state"
          options={stateOptions}
          value={statusFilter}
          onChange={(value) => setStatusFilter(value as CronStatusFilter)}
        />
        <span className={styles.divider} aria-hidden="true" />
        <FilterChips
          ariaLabel="Filter by scheduler"
          options={schedulerOptions}
          value={schedulerFilter}
          onChange={(value) => setSchedulerFilter(value as SchedulerFilter)}
        />
        <div className={styles.toolbarEnd}>
          {filteredJobs.length !== jobs.length && (
            <span className={styles.count} aria-live="polite">
              Showing {filteredJobs.length} of {jobs.length}
            </span>
          )}
          <SearchInput
            className={styles.search}
            value={jobSearch}
            onChange={setJobSearch}
            label="Search jobs"
            placeholder="Search jobs"
          />
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
            Create automation
          </Button>
        </div>
      </div>

      {jobParam && !selectedJob && (
        <Notice
          tone="info"
          action={
            <Button size="sm" variant="ghost" onClick={() => setJobParam(null)}>
              Dismiss
            </Button>
          }
        >
          No automation with id {jobParam} was found.
        </Notice>
      )}

      <Panel padding="none">
        <DataTable
          className={styles.table}
          caption="Automations"
          columns={columns}
          rows={filteredJobs}
          rowKey={(job) => job.id}
          onRowClick={(job) => setJobParam(job.id)}
          selectedKey={selectedJob?.id ?? null}
          dimmed={(job) => !job.enabled || normalizeCronStatus(job.status, job.enabled) === 'disabled'}
          empty={
            <EmptyState
              icon={<Clock size={20} />}
              title={
                filteredUnread
                  ? `${SCHEDULER_NAMES[schedulerFilter as CronScheduler]} was not read`
                  : jobs.length === 0 && incomplete
                    ? 'Automations were not read'
                    : jobs.length === 0
                      ? 'No automations yet'
                      : 'No jobs match'
              }
              description={
                filteredUnread
                  ? 'Its jobs are not in this list, so none can be shown. This does not mean it has none.'
                  : jobs.length === 0 && incomplete
                    ? 'No job list could be read. This does not mean there are none.'
                    : jobs.length === 0
                      ? 'Create a scheduled job and it will appear here.'
                      : 'No jobs match the current search and filters.'
              }
              action={
                jobs.length === 0 && !incomplete ? (
                  <Button variant="primary" icon={<Plus size={14} />} onClick={() => setShowCreate(true)}>
                    Create automation
                  </Button>
                ) : hasActiveFilters ? (
                  <Button onClick={clearFilters}>Clear filters</Button>
                ) : undefined
              }
            />
          }
        />
      </Panel>

      <JobDrawer
        job={selectedJob}
        open={Boolean(selectedJob) && !runTarget && !deleteTarget}
        onClose={() => setJobParam(null)}
        overlapMarker={selectedJob ? overlapState.markers.get(selectedJob.id) : undefined}
        modelOptions={modelOptions}
        displayModel={displayModel}
        staleSince={selectedJob && readings[getCronScheduler(selectedJob)].state === 'stale' ? readings[getCronScheduler(selectedJob)] : null}
        pendingAction={pendingAction}
        error={selectedJob ? refusals[selectedJob.id] ?? null : null}
        onToggle={handleToggle}
        onRun={(job) => requestRun(job, true)}
        onDelete={(job) => requestDelete(job, true)}
        onModelChange={handleModelChange}
      />

      <CreateJobDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSubmit={handleCreateJob}
        modelOptions={modelOptions}
      />

      <Dialog
        open={deleteTarget !== null}
        onClose={() => {
          if (!pendingAction?.startsWith('delete-')) setDeleteTarget(null)
        }}
        role="alertdialog"
        title="Delete automation?"
        description={
          deleteTarget
            ? `"${deleteTarget.name}" will be removed from ${getCronSchedulerLabel(deleteTarget)}. This cannot be undone.`
            : undefined
        }
        actions={
          <>
            <Button
              data-autofocus
              onClick={() => setDeleteTarget(null)}
              disabled={pendingAction === `delete-${deleteTarget?.id}`}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete} loading={pendingAction === `delete-${deleteTarget?.id}`}>
              Delete
            </Button>
          </>
        }
      />

      <Dialog
        open={runTarget !== null}
        onClose={() => {
          if (!pendingAction?.startsWith('run-')) setRunTarget(null)
        }}
        role="alertdialog"
        title="Run automation now?"
        description={
          runTarget
            ? `"${runTarget.name}" will be queued for an immediate ${getCronSchedulerLabel(runTarget)} run. The normal schedule stays unchanged.`
            : undefined
        }
        actions={
          <>
            <Button
              data-autofocus
              onClick={() => setRunTarget(null)}
              disabled={pendingAction === `run-${runTarget?.id}`}
            >
              Cancel
            </Button>
            <Button variant="primary" onClick={confirmRun} loading={pendingAction === `run-${runTarget?.id}`}>
              Run now
            </Button>
          </>
        }
      />
    </div>
  )
}
