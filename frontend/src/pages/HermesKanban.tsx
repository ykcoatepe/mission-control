import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Archive, Play, Plus } from 'lucide-react'
import {
  Button,
  Dialog,
  Drawer,
  ErrorState,
  Field,
  FilterChips,
  Freshness,
  Mono,
  Notice,
  Page,
  SearchInput,
  Select,
  Skeleton,
  StatRow,
  Stat,
  StateDot,
  StatePill,
  Switch,
  TextInput,
  TimeAgo,
  cx,
  useToast,
} from '../components/ui'
import type { UiState } from '../lib/state'
import { apiQueryOptions, fetchJson } from '../lib/hooks'
import styles from './HermesKanban.module.css'

type HermesTask = {
  id: string
  title: string
  body?: string | null
  assignee?: string | null
  status: string
  priority?: number
  tenant?: string | null
  workspace_kind?: string
  workspace_path?: string | null
  created_by?: string | null
  createdAt?: string | null
  startedAt?: string | null
  completedAt?: string | null
  lastHeartbeatAt?: string | null
  worker_pid?: number | null
  result?: string | null
  skills?: string[]
}

type HermesBoardPayload = {
  ok: boolean
  error?: string
  profile: string
  refreshedAt?: string
  statuses: string[]
  columns: Record<string, HermesTask[]>
  stats?: {
    by_status?: Record<string, number>
    oldest_ready_age_seconds?: number | null
  } | null
  assignees?: Array<{ name: string; onDisk: boolean; counts: Record<string, number>; active: number }>
  summary?: {
    total: number
    active: number
    done: number
    blocked: number
    running: number
    byAssignee: Record<string, number>
  }
}

type HermesDetailPayload = {
  ok: boolean
  error?: string
  task?: HermesTask
  comments?: Array<{ author?: string; body?: string; createdAt?: string }>
  events?: Array<{ kind: string; payload?: Record<string, unknown>; createdAt?: string }>
  runs?: Array<{ id: number; profile?: string; status?: string; outcome?: string; summary?: string; error?: string; worker_pid?: number | null; startedAt?: string; endedAt?: string }>
}

type ActionResult = { ok: boolean; error?: string }

/** Column order: what is stuck first, then what is moving, then what waits, then what finished. */
const STATUS_ORDER = ['blocked', 'running', 'ready', 'triage', 'todo', 'done']

const STATUS_COPY: Record<string, { label: string; empty: string }> = {
  blocked: { label: 'Blocked', empty: 'Nothing blocked.' },
  running: { label: 'Running', empty: 'Nothing running.' },
  ready: { label: 'Ready', empty: 'Nothing ready.' },
  triage: { label: 'Triage', empty: 'No specs waiting.' },
  todo: { label: 'To do', empty: 'Nothing parked.' },
  done: { label: 'Done', empty: 'Nothing done yet.' },
}

const defaultStatuses = ['triage', 'todo', 'ready', 'running', 'blocked', 'done']
const emptyColumns: Record<string, HermesTask[]> = {}
const EMPTY_CREATE_FORM = { title: '', body: '', assignee: 'hmudur', workspace: '', priority: '10', triage: true, skills: '' }

const ACTION_DONE: Record<string, string> = {
  create: 'Task created',
  dispatch: 'Dispatch requested',
  assign: 'Task assigned',
  comment: 'Comment added',
  block: 'Task blocked',
  unblock: 'Task unblocked',
  archive: 'Task archived',
}

function statusCopy(status: string) {
  return STATUS_COPY[status] ?? { label: status.charAt(0).toUpperCase() + status.slice(1), empty: 'Nothing here.' }
}

function statusRank(status: string) {
  const index = STATUS_ORDER.indexOf(status)
  return index === -1 ? STATUS_ORDER.length : index
}

/** Only moving and stuck work gets a lit dot; waiting and finished work stays grey. */
function statusState(status: string): UiState {
  if (status === 'blocked') return 'warning'
  if (status === 'running') return 'healthy'
  return 'inactive'
}

function priorityText(priority?: number) {
  if (priority === undefined || priority === null || !Number.isFinite(Number(priority))) return null
  const value = Number(priority)
  const word = value >= 50 ? 'High' : value >= 10 ? 'Medium' : 'Low'
  return `${word} · ${value}`
}

function compactAge(seconds?: number | null) {
  const value = Number(seconds)
  if (seconds === null || seconds === undefined || !Number.isFinite(value) || value <= 0) return null
  const mins = Math.floor(value / 60)
  if (mins < 60) return `${Math.max(mins, 1)}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 48) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

function actionPost(payload: Record<string, unknown>) {
  return fetchJson<ActionResult>('/api/hermes-kanban/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  } as RequestInit)
}

function TaskCard({ task, onSelect }: { task: HermesTask; onSelect: (task: HermesTask) => void }) {
  return (
    <button type="button" onClick={() => onSelect(task)} className={styles.card}>
      <span className={styles.cardTitle}>
        <StateDot state={statusState(task.status)} label={statusCopy(task.status).label} />
        <span className={styles.cardTitleText}>{task.title}</span>
      </span>
      <span className={styles.cardMeta}>
        <span className={styles.cardAssignee}>{task.assignee || 'Unassigned'}</span>
        <TimeAgo value={task.createdAt} className={styles.cardAge} />
      </span>
    </button>
  )
}

export default function HermesKanban() {
  const queryClient = useQueryClient()
  const toast = useToast()
  const [selectedTask, setSelectedTask] = useState<HermesTask | null>(null)
  const [commentText, setCommentText] = useState('')
  const [assigneeText, setAssigneeText] = useState('')
  const [blockReason, setBlockReason] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [confirm, setConfirm] = useState<'dispatch' | 'archive' | null>(null)
  const [searchText, setSearchText] = useState('')
  const [assigneeFilter, setAssigneeFilter] = useState('all')
  const [statusMode, setStatusMode] = useState<'active' | 'all'>('all')
  const [createForm, setCreateForm] = useState(EMPTY_CREATE_FORM)
  const [slowRead, setSlowRead] = useState(false)

  const boardQuery = useQuery(apiQueryOptions<HermesBoardPayload>('/api/hermes-kanban', 10000))
  const detailQuery = useQuery({
    ...apiQueryOptions<HermesDetailPayload>(selectedTask ? `/api/hermes-kanban/tasks/${encodeURIComponent(selectedTask.id)}` : '/api/hermes-kanban/tasks/none', 10000),
    enabled: Boolean(selectedTask),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['api', '/api/hermes-kanban'] })
    if (selectedTask) queryClient.invalidateQueries({ queryKey: ['api', `/api/hermes-kanban/tasks/${selectedTask.id}`] })
  }

  const actionMutation = useMutation({
    mutationFn: actionPost,
    onSuccess: invalidate,
  })

  const board = boardQuery.data
  const detail = detailQuery.data
  const boardLoading = boardQuery.isLoading

  // The board endpoint can take 6 s or more; say so instead of leaving a silent skeleton.
  useEffect(() => {
    if (!boardLoading) return
    const timer = window.setTimeout(() => setSlowRead(true), 5000)
    return () => window.clearTimeout(timer)
  }, [boardLoading])

  const statuses = useMemo(() => {
    const source = board?.statuses?.length ? board.statuses : defaultStatuses
    return source.slice().sort((a, b) => statusRank(a) - statusRank(b))
  }, [board?.statuses])
  const columns = useMemo(() => board?.columns || emptyColumns, [board?.columns])
  const visibleStatuses = statusMode === 'active' ? statuses.filter((status) => status !== 'done') : statuses
  const filteredColumns = useMemo(() => {
    const query = searchText.trim().toLowerCase()
    return Object.fromEntries(statuses.map((status) => {
      const tasks = (columns[status] || []).filter((task) => {
        const matchesAssignee = assigneeFilter === 'all' || (task.assignee || 'unassigned') === assigneeFilter
        if (!matchesAssignee) return false
        if (!query) return true
        return [
          task.id,
          task.title,
          task.body || '',
          task.assignee || '',
          task.tenant || '',
          task.workspace_path || '',
          ...(task.skills || []),
        ].join(' ').toLowerCase().includes(query)
      })
      return [status, tasks]
    }))
  }, [assigneeFilter, columns, searchText, statuses])
  const assigneeOptions = useMemo(() => {
    const names = new Set<string>()
    board?.assignees?.forEach((assignee) => names.add(assignee.name))
    Object.values(columns).flat().forEach((task) => names.add(task.assignee || 'unassigned'))
    return Array.from(names).sort()
  }, [board?.assignees, columns])
  const filteredCount = visibleStatuses.reduce((sum, status) => sum + (filteredColumns[status]?.length ?? 0), 0)
  const filtering = Boolean(searchText.trim()) || assigneeFilter !== 'all'

  /** Runs one named action. Returns true when the server accepted it; failures are reported, not swallowed. */
  const runAction = async (payload: Record<string, unknown>): Promise<boolean> => {
    try {
      const result = await actionMutation.mutateAsync(payload)
      if (result && result.ok === false) {
        toast.show('error', result.error || 'The action was not accepted')
        return false
      }
      toast.show('success', ACTION_DONE[String(payload.action)] ?? 'Done')
      return true
    } catch (error) {
      toast.show('error', error instanceof Error ? `Action failed: ${error.message}` : 'Action failed')
      return false
    }
  }
  const pendingKind = actionMutation.isPending ? String(actionMutation.variables?.action ?? '') : ''

  const createTask = async () => {
    if (!createForm.title.trim()) return
    const ok = await runAction({
      action: 'create',
      title: createForm.title.trim(),
      body: createForm.body.trim(),
      assignee: createForm.assignee.trim(),
      workspace: createForm.workspace.trim(),
      priority: Number(createForm.priority || 0),
      triage: createForm.triage,
      skills: createForm.skills.split(',').map((item) => item.trim()).filter(Boolean),
    })
    if (!ok) return
    setCreateForm(EMPTY_CREATE_FORM)
    setShowCreate(false)
  }

  const closeTask = () => {
    setSelectedTask(null)
    setConfirm(null)
  }

  const boardFailed = board?.ok === false || (boardQuery.isError && !board)
  const refreshFailed = boardQuery.isError && Boolean(board) && board?.ok !== false
  const task = selectedTask ? { ...selectedTask, ...(detail?.task ?? {}) } : null
  const isBlocked = task?.status === 'blocked'
  const blockedCount = board?.summary?.blocked ?? columns.blocked?.length ?? null
  const readyCount = board?.stats?.by_status?.ready ?? columns.ready?.length ?? null
  const oldestReady = compactAge(board?.stats?.oldest_ready_age_seconds)

  const stats = board && !boardFailed ? (
    <StatRow aria-label="Work summary">
      <Stat label="Running" value={board.summary?.running ?? columns.running?.length ?? null} />
      <Stat
        label="Blocked"
        value={blockedCount}
        state={blockedCount ? 'warning' : undefined}
      />
      <Stat
        label="Ready"
        value={readyCount}
        hint={oldestReady ? `Oldest waiting ${oldestReady}` : undefined}
      />
      <Stat label="Done" value={board.summary?.done ?? columns.done?.length ?? null} />
    </StatRow>
  ) : null

  return (
    <Page
      title="Work"
      description={
        <>
          What is running, what is stuck.{' '}
          <Link to="/workshop" className={styles.legacyLink}>Open legacy board</Link>
        </>
      }
      actions={
        <>
          <Button icon={<Play size={14} aria-hidden="true" />} onClick={() => setConfirm('dispatch')} disabled={!board || boardFailed}>
            Dispatch ready work
          </Button>
          <Button variant="primary" icon={<Plus size={14} aria-hidden="true" />} onClick={() => setShowCreate(true)}>
            New task
          </Button>
        </>
      }
    >
      {boardLoading ? (
        <div className={styles.loading}>
          <Skeleton variant="block" size="md" label="Reading the work board" />
          <Skeleton variant="block" size="lg" label="Reading the work board" />
          {slowRead ? <p className={styles.slowHint}>The Hermes board is slow to answer. Still reading.</p> : null}
        </div>
      ) : boardFailed ? (
        <ErrorState
          title="The Hermes work board could not be read"
          message={board?.error || boardQuery.error?.message || 'No reason was given.'}
          onRetry={() => void boardQuery.refetch()}
        />
      ) : (
        <>
          {stats}

          {refreshFailed ? (
            <Notice tone="warning" title="The board could not be refreshed. Showing the last reading." action={<Button size="sm" onClick={() => void boardQuery.refetch()}>Retry</Button>}>
              {boardQuery.error?.message}
            </Notice>
          ) : null}

          <div className={styles.toolbar}>
            <SearchInput
              value={searchText}
              onChange={setSearchText}
              label="Search tasks"
              placeholder="Search title, assignee, workspace, skills"
              className={styles.search}
            />
            <Select
              aria-label="Assignee"
              value={assigneeFilter}
              onChange={(event) => setAssigneeFilter(event.target.value)}
              options={[{ value: 'all', label: 'All assignees' }, ...assigneeOptions.map((name) => ({ value: name, label: name }))]}
              className={styles.assignee}
            />
            <FilterChips
              ariaLabel="Columns shown"
              value={statusMode}
              onChange={(value) => setStatusMode(value === 'active' ? 'active' : 'all')}
              options={[{ value: 'active', label: 'Open' }, { value: 'all', label: 'All' }]}
            />
            <span className={styles.toolbarEnd}>
              {filtering ? (
                <>
                  <span className={styles.matchCount}>{filteredCount} matching</span>
                  <Button size="sm" variant="ghost" onClick={() => { setSearchText(''); setAssigneeFilter('all') }}>Clear filters</Button>
                </>
              ) : null}
              <Freshness
                observedAt={board?.refreshedAt ?? boardQuery.dataUpdatedAt}
                state={refreshFailed ? 'stale' : undefined}
                staleAfterMs={2 * 60_000}
              />
            </span>
          </div>

          <div className={styles.board}>
            {visibleStatuses.map((status) => {
              const copy = statusCopy(status)
              const tasks = filteredColumns[status] || []
              const alarm = status === 'blocked' && tasks.length > 0
              return (
                <section key={status} className={cx(styles.column, alarm && styles.columnAlarm, tasks.length === 0 && styles.columnIdle)} aria-label={copy.label}>
                  <header className={styles.columnHeader}>
                    <h2 className={styles.columnTitle}>{copy.label}</h2>
                    <Mono className={styles.columnCount}>{tasks.length}</Mono>
                  </header>
                  {tasks.length ? (
                    <div className={styles.columnCards}>
                      {tasks.map((item) => <TaskCard key={item.id} task={item} onSelect={setSelectedTask} />)}
                    </div>
                  ) : (
                    <p className={styles.columnEmpty}>{filtering ? 'No matches.' : copy.empty}</p>
                  )}
                </section>
              )
            })}
          </div>
        </>
      )}

      <Drawer
        open={Boolean(task) && confirm !== 'archive'}
        onClose={closeTask}
        title={task?.title ?? ''}
        description={task ? <Mono muted>{task.id}</Mono> : undefined}
        size="md"
      >
        {task ? (
          <div className={styles.detail}>
            <dl className={styles.facts}>
              <div className={styles.fact}>
                <dt>Status</dt>
                <dd><StatePill state={statusState(task.status)} label={statusCopy(task.status).label} /></dd>
              </div>
              <div className={styles.fact}>
                <dt>Assignee</dt>
                <dd>{task.assignee || 'Unassigned'}</dd>
              </div>
              <div className={styles.fact}>
                <dt>Priority</dt>
                <dd>{priorityText(task.priority) ?? '—'}</dd>
              </div>
              <div className={styles.fact}>
                <dt>Created</dt>
                <dd><TimeAgo value={task.createdAt} /></dd>
              </div>
              <div className={styles.fact}>
                <dt>Last heartbeat</dt>
                <dd><TimeAgo value={task.lastHeartbeatAt} fallback="none" /></dd>
              </div>
              <div className={styles.fact}>
                <dt>Workspace</dt>
                <dd>{task.workspace_path ? <Mono className={styles.path}>{task.workspace_path}</Mono> : '—'}</dd>
              </div>
              {task.worker_pid ? (
                <div className={styles.fact}>
                  <dt>Worker</dt>
                  <dd><Mono>pid {task.worker_pid}</Mono></dd>
                </div>
              ) : null}
            </dl>

            {task.body ? <p className={styles.body}>{task.body}</p> : null}

            <section className={styles.section} aria-labelledby="work-actions">
              <h3 id="work-actions" className={styles.sectionTitle}>Actions</h3>

              <div className={styles.inline}>
                <Field label="Assign to" className={styles.grow}>
                  {(control) => (
                    <TextInput {...control} value={assigneeText} onChange={(event) => setAssigneeText(event.target.value)} placeholder="Profile name" />
                  )}
                </Field>
                <Button
                  disabled={!assigneeText.trim()}
                  loading={pendingKind === 'assign'}
                  onClick={async () => { if (await runAction({ action: 'assign', taskId: task.id, assignee: assigneeText.trim() })) setAssigneeText('') }}
                >
                  Assign
                </Button>
              </div>

              <Field label="Comment" hint="Added to the task's audit trail.">
                {(control) => (
                  <textarea {...control} className={styles.textarea} rows={3} value={commentText} onChange={(event) => setCommentText(event.target.value)} />
                )}
              </Field>
              <div>
                <Button
                  disabled={!commentText.trim()}
                  loading={pendingKind === 'comment'}
                  onClick={async () => { if (await runAction({ action: 'comment', taskId: task.id, text: commentText.trim() })) setCommentText('') }}
                >
                  Add comment
                </Button>
              </div>

              {isBlocked ? (
                <div>
                  <Button loading={pendingKind === 'unblock'} onClick={() => void runAction({ action: 'unblock', taskId: task.id })}>
                    Unblock
                  </Button>
                </div>
              ) : (
                <div className={styles.inline}>
                  <Field label="Block reason" className={styles.grow}>
                    {(control) => (
                      <TextInput {...control} value={blockReason} onChange={(event) => setBlockReason(event.target.value)} placeholder="Why is this stuck?" />
                    )}
                  </Field>
                  <Button
                    loading={pendingKind === 'block'}
                    onClick={async () => { if (await runAction({ action: 'block', taskId: task.id, reason: blockReason.trim() || 'Blocked from Mission Control' })) setBlockReason('') }}
                  >
                    Block
                  </Button>
                </div>
              )}

              <div className={styles.archiveRow}>
                <Button variant="danger" icon={<Archive size={14} aria-hidden="true" />} onClick={() => setConfirm('archive')}>
                  Archive task
                </Button>
              </div>
            </section>

            {detailQuery.isLoading ? (
              <Skeleton variant="line" lines={4} label="Reading task detail" />
            ) : detailQuery.isError || detail?.ok === false ? (
              <Notice tone="warning" title="Runs and events could not be read.">
                {detail?.error || detailQuery.error?.message}
              </Notice>
            ) : (
              <>
                <section className={styles.section} aria-labelledby="work-runs">
                  <h3 id="work-runs" className={styles.sectionTitle}>Runs</h3>
                  {detail?.runs?.length ? (
                    <ul className={styles.list}>
                      {detail.runs.map((run) => (
                        <li key={run.id} className={styles.listItem}>
                          <div className={styles.listRow}>
                            <span>{run.profile || 'Worker'} · {run.status || '—'}</span>
                            <TimeAgo value={run.startedAt} fallback="" className={styles.muted} />
                          </div>
                          {run.error ? <p className={styles.runError}>{run.error}</p> : run.summary ? <p className={styles.runSummary}>{run.summary}</p> : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className={styles.muted}>No runs recorded.</p>
                  )}
                </section>

                <section className={styles.section} aria-labelledby="work-events">
                  <h3 id="work-events" className={styles.sectionTitle}>Recent events</h3>
                  {detail?.events?.length ? (
                    <ul className={styles.list}>
                      {detail.events.slice().reverse().slice(0, 8).map((event, index) => (
                        <li key={`${event.kind}-${index}`} className={cx(styles.listItem, styles.listRow)}>
                          <Mono>{event.kind}</Mono>
                          <TimeAgo value={event.createdAt} fallback="" className={styles.muted} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className={styles.muted}>No events recorded.</p>
                  )}
                </section>
              </>
            )}
          </div>
        ) : null}
      </Drawer>

      <Dialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New task"
        size="md"
        actions={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button variant="primary" disabled={!createForm.title.trim()} loading={pendingKind === 'create'} onClick={() => void createTask()}>
              Create task
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <Field label="Title">
            {(control) => (
              <TextInput {...control} data-autofocus value={createForm.title} onChange={(event) => setCreateForm((prev) => ({ ...prev, title: event.target.value }))} />
            )}
          </Field>
          <Field label="Details and acceptance criteria">
            {(control) => (
              <textarea {...control} className={styles.textarea} rows={5} value={createForm.body} onChange={(event) => setCreateForm((prev) => ({ ...prev, body: event.target.value }))} />
            )}
          </Field>
          <div className={styles.formGrid}>
            <Field label="Assignee">
              {(control) => (
                <TextInput {...control} value={createForm.assignee} onChange={(event) => setCreateForm((prev) => ({ ...prev, assignee: event.target.value }))} />
              )}
            </Field>
            <Field label="Priority">
              {(control) => (
                <TextInput {...control} type="number" value={createForm.priority} onChange={(event) => setCreateForm((prev) => ({ ...prev, priority: event.target.value }))} />
              )}
            </Field>
            <Field label="Workspace" hint="For example dir:/path/to/project">
              {(control) => (
                <TextInput {...control} value={createForm.workspace} onChange={(event) => setCreateForm((prev) => ({ ...prev, workspace: event.target.value }))} />
              )}
            </Field>
            <Field label="Skills" hint="Comma separated">
              {(control) => (
                <TextInput {...control} value={createForm.skills} onChange={(event) => setCreateForm((prev) => ({ ...prev, skills: event.target.value }))} />
              )}
            </Field>
          </div>
          <Switch
            checked={createForm.triage}
            onChange={(checked) => setCreateForm((prev) => ({ ...prev, triage: checked }))}
            label="Start in triage"
          />
        </div>
      </Dialog>

      <Dialog
        open={confirm === 'dispatch'}
        onClose={() => setConfirm(null)}
        role="alertdialog"
        title="Dispatch ready work?"
        description="Starts one Hermes worker on a ready task."
        actions={
          <>
            <Button variant="ghost" data-autofocus onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="primary"
              loading={pendingKind === 'dispatch'}
              onClick={async () => { await runAction({ action: 'dispatch', taskId: 'board' }); setConfirm(null) }}
            >
              Dispatch
            </Button>
          </>
        }
      />

      <Dialog
        open={confirm === 'archive' && Boolean(task)}
        onClose={() => setConfirm(null)}
        role="alertdialog"
        title={task ? `Archive ${task.id}?` : 'Archive task?'}
        description={task?.title}
        actions={
          <>
            <Button variant="ghost" data-autofocus onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              loading={pendingKind === 'archive'}
              onClick={async () => { if (task) await runAction({ action: 'archive', taskId: task.id }); setConfirm(null) }}
            >
              Archive
            </Button>
          </>
        }
      />

    </Page>
  )
}
