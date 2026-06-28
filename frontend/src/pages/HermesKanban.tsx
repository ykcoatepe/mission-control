import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Archive,
  CheckCircle,
  Clock,
  Loader2,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  SlidersHorizontal,
  UserRound,
  UsersRound,
  X,
  Zap,
} from 'lucide-react'
import PageTransition from '../components/PageTransition'
import { apiQueryOptions, fetchJson, timeAgo } from '../lib/hooks'
import { useIsMobile } from '../lib/useIsMobile'
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

const statusConfig: Record<string, { label: string; color: string; icon: typeof Clock; empty: string }> = {
  triage: { label: 'Triage', color: '#64D2FF', icon: ShieldAlert, empty: 'No specs waiting.' },
  todo: { label: 'Todo', color: '#8E8E93', icon: Clock, empty: 'No parked work.' },
  ready: { label: 'Ready', color: '#007AFF', icon: Play, empty: 'No ready cards.' },
  running: { label: 'Running', color: '#BF5AF2', icon: Zap, empty: 'No live workers.' },
  blocked: { label: 'Blocked', color: '#FF453A', icon: AlertCircle, empty: 'No blockers.' },
  done: { label: 'Done', color: '#32D74B', icon: CheckCircle, empty: 'No completed cards yet.' },
}

const defaultStatuses = ['triage', 'todo', 'ready', 'running', 'blocked', 'done']
const emptyColumns: Record<string, HermesTask[]> = {}

function priorityLabel(priority?: number) {
  const value = Number(priority || 0)
  if (value >= 50) return { label: 'High', color: '#FF453A' }
  if (value >= 10) return { label: 'Medium', color: '#FF9500' }
  return { label: 'Low', color: '#8E8E93' }
}

function compactAge(seconds?: number | null) {
  const value = Number(seconds || 0)
  if (!Number.isFinite(value) || value <= 0) return 'none'
  const mins = Math.floor(value / 60)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 48) return `${hrs}h`
  return `${Math.floor(hrs / 24)}d`
}

function getNextAction(board?: HermesBoardPayload) {
  if (!board?.ok) return 'Reconnect Hermes Kanban'
  if ((board.summary?.blocked || 0) > 0) return 'Clear blockers first'
  if ((board.summary?.running || 0) > 0) return 'Watch live workers'
  if ((board.columns?.ready?.length || 0) > 0) return 'Dispatch ready work'
  if ((board.columns?.triage?.length || 0) > 0) return 'Promote triage cards'
  return 'Create the next card'
}

function actionPost(payload: Record<string, unknown>) {
  return fetchJson<{ ok: boolean; error?: string }>('/api/hermes-kanban/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  } as RequestInit)
}

function TaskCard({ task, onSelect }: { task: HermesTask; onSelect: (task: HermesTask) => void }) {
  const priority = priorityLabel(task.priority)
  return (
    <button
      onClick={() => onSelect(task)}
      className={`macos-panel ${styles.taskCard}`}
    >
      <div className={styles.taskCardTop}>
        <h3 className={styles.taskCardTitle}>
          {task.title}
        </h3>
        <span className={styles.taskCardPriorityBadge} style={{ color: priority.color }}>
          {priority.label}
        </span>
      </div>

      {task.body ? (
        <p className={styles.taskCardBody}>
          {task.body}
        </p>
      ) : null}

      <div className={styles.taskCardTags}>
        <span className={styles.taskCardAssignee}>
          <UserRound size={10} /> {task.assignee || 'unassigned'}
        </span>
        {task.workspace_path ? (
          <span className={styles.taskCardWorkspace}>
            {task.workspace_kind || 'dir'}
          </span>
        ) : null}
        {task.worker_pid ? (
          <span className={styles.taskCardPid}>
            pid {task.worker_pid}
          </span>
        ) : null}
      </div>

      <div className={styles.taskCardMeta}>
        <span>{task.createdAt ? timeAgo(task.createdAt) : 'no timestamp'}</span>
        {task.tenant ? <span>{task.tenant}</span> : null}
      </div>
    </button>
  )
}

export default function HermesKanban() {
  const m = useIsMobile()
  const queryClient = useQueryClient()
  const [selectedTask, setSelectedTask] = useState<HermesTask | null>(null)
  const [commentText, setCommentText] = useState('')
  const [assigneeText, setAssigneeText] = useState('')
  const [blockReason, setBlockReason] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [assigneeFilter, setAssigneeFilter] = useState('all')
  const [statusMode, setStatusMode] = useState<'active' | 'all'>('all')
  const [createForm, setCreateForm] = useState({ title: '', body: '', assignee: 'hmudur', workspace: '', priority: '10', triage: true, skills: '' })

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
  const statuses = useMemo(() => board?.statuses?.length ? board.statuses : defaultStatuses, [board?.statuses])
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
  const filteredCount = Object.values(filteredColumns).flat().length

  const runAction = async (payload: Record<string, unknown>) => {
    await actionMutation.mutateAsync(payload)
  }

  const createTask = async () => {
    if (!createForm.title.trim()) return
    await runAction({
      action: 'create',
      title: createForm.title.trim(),
      body: createForm.body.trim(),
      assignee: createForm.assignee.trim(),
      workspace: createForm.workspace.trim(),
      priority: Number(createForm.priority || 0),
      triage: createForm.triage,
      skills: createForm.skills.split(',').map((item) => item.trim()).filter(Boolean),
    })
    setCreateForm({ title: '', body: '', assignee: 'hmudur', workspace: '', priority: '10', triage: true, skills: '' })
    setShowCreate(false)
  }

  return (
    <PageTransition>
      <div className={`${styles.page} ${m ? styles.pageMobile : styles.pageDesktop}`}>
        <div className={`${styles.headerRow} ${m ? styles.headerRowMobile : styles.headerRowDesktop}`}>
          <div>
            <h1 className="text-title">Hermes Kanban</h1>
            <p className={`text-body ${styles.headerSubtitle}`}>hmudur board, worker state, blockers, and handoffs</p>
          </div>
          <div className={styles.headerBtnGroup}>
            <button
              onClick={() => boardQuery.refetch()}
              className={styles.refreshBtn}
            >
              <RefreshCw size={14} /> Refresh
            </button>
            <button
              onClick={() => {
                if (confirm('Dispatch one ready Hermes Kanban worker?')) void runAction({ action: 'dispatch', taskId: 'board' })
              }}
              className={styles.dispatchBtn}
            >
              <Play size={14} /> Dispatch
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className={styles.newCardBtn}
            >
              <Plus size={14} /> New Card
            </button>
          </div>
        </div>

        {boardQuery.isLoading ? (
          <div className={`macos-panel ${styles.loadingWrap}`}>
            <Loader2 size={16} className={styles.spinnerIcon} /> Loading Hermes board
          </div>
        ) : board?.ok === false || boardQuery.error ? (
          <div className={`macos-panel ${styles.errorPanel}`}>
            <div className={styles.errorTitle}>
              <AlertCircle size={16} /> Hermes Kanban unavailable
            </div>
            <p className={styles.errorDesc}>{board?.error || boardQuery.error?.message || 'Unknown error'}</p>
            <p className={styles.errorHint}>
              Check that Mission Control is running the latest server and can reach the hmudur profile database.
            </p>
          </div>
        ) : (
          <>
            <div className={`macos-panel ${styles.statsPanel} ${m ? styles.statsPanelMobile : styles.statsPanelDesktop}`}>
              <div className={styles.nextActionCol}>
                <div className={styles.nextActionLabel}>
                  <Zap size={13} /> Next action
                </div>
                <div className={styles.nextActionValue}>{getNextAction(board)}</div>
                <div className={styles.nextActionRefreshed}>
                  Refreshed {board?.refreshedAt ? timeAgo(board.refreshedAt) : 'just now'}
                </div>
              </div>
              {[
                { label: 'Active', value: board?.summary?.active || 0, color: '#64D2FF' },
                { label: 'Running', value: board?.summary?.running || 0, color: '#BF5AF2' },
                { label: 'Blocked', value: board?.summary?.blocked || 0, color: '#FF453A' },
                { label: 'Done', value: board?.summary?.done || 0, color: '#32D74B' },
                { label: 'Oldest ready', value: compactAge(board?.stats?.oldest_ready_age_seconds), color: '#FF9500' },
              ].map((item) => (
                <div key={item.label} className={styles.statItem}>
                  <div className={styles.statItemLabel}>{item.label}</div>
                  <div
                    className={typeof item.value === 'number' ? styles.statItemValueLarge : styles.statItemValueSmall}
                    style={{ color: item.color }}
                  >{item.value}</div>
                </div>
              ))}
            </div>

            <div className={`macos-panel ${styles.filterBar} ${m ? styles.filterBarMobile : styles.filterBarDesktop}`}>
              <label className={styles.searchLabel}>
                <Search size={14} className={styles.searchIcon} />
                <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search cards, workspace, tenant, skills" aria-label="Search cards, workspace, tenant, or skills" className={styles.searchInput} />
              </label>
              <label className={styles.assigneeLabel}>
                <UsersRound size={14} className={styles.assigneeIcon} />
                <select value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)}
                  className={`${styles.assigneeSelect} ${m ? styles.assigneeSelectMobile : styles.assigneeSelectDesktop}`}>
                  <option value="all">All assignees</option>
                  {assigneeOptions.map((assignee) => <option key={assignee} value={assignee}>{assignee}</option>)}
                </select>
              </label>
              <div className={`${styles.modeRow} ${m ? styles.modeRowMobile : styles.modeRowDesktop}`}>
                <SlidersHorizontal size={14} className={styles.modeIcon} />
                {(['active', 'all'] as const).map((mode) => (
                  <button key={mode} onClick={() => setStatusMode(mode)}
                    className={`${statusMode === mode ? styles.modeBtnActive : styles.modeBtnInactive} ${m ? styles.modeBtnMobile : ''}`}>
                    {mode}
                  </button>
                ))}
              </div>
              {(searchText || assigneeFilter !== 'all') ? (
                <div className={styles.filterResults}>
                  <span>{filteredCount} matching cards</span>
                  <button onClick={() => { setSearchText(''); setAssigneeFilter('all') }} className={styles.clearFiltersBtn}>Clear filters</button>
                </div>
              ) : null}
            </div>

            <div className={`${styles.boardGrid} ${m ? styles.boardGridMobile : styles.boardGridDesktop}`}>
              {visibleStatuses.map((status) => {
                const config = statusConfig[status] || statusConfig.todo
                const Icon = config.icon
                const tasks = filteredColumns[status] || []
                return (
                  <section key={status} className={styles.column}>
                    <div className={styles.columnHeader}>
                      <Icon size={15} style={{ color: config.color }} />
                      <h2 className={styles.columnTitle}>{config.label}</h2>
                      <span className={styles.columnCount} style={{ color: config.color }}>{tasks.length}</span>
                    </div>
                    <div className={styles.columnCards}>
                      {tasks.length ? tasks.map((task) => <TaskCard key={task.id} task={task} onSelect={setSelectedTask} />) : (
                        <div className={styles.columnEmpty}>
                          {config.empty}
                        </div>
                      )}
                    </div>
                  </section>
                )
              })}
            </div>
          </>
        )}
      </div>

      {selectedTask ? (
        <div className={styles.drawerOverlay} onClick={() => setSelectedTask(null)}>
          <aside onClick={(event) => event.stopPropagation()}
            className={`${styles.drawer} ${m ? styles.drawerMobile : styles.drawerDesktop}`}>
            <div className={styles.drawerHeader}>
              <div>
                <p className={styles.drawerTaskId}>{selectedTask.id}</p>
                <h2 className={styles.drawerTaskTitle}>{detail?.task?.title || selectedTask.title}</h2>
              </div>
              <button onClick={() => setSelectedTask(null)} className={styles.drawerCloseBtn}>
                <X size={16} />
              </button>
            </div>

            {detailQuery.isLoading ? (
              <div className={`macos-panel ${styles.detailLoadingWrap}`}>
                <Loader2 size={15} className={styles.detailLoadingIcon} /> Loading detail
              </div>
            ) : null}

            <div className={`macos-panel ${styles.detailPanel}`}>
              <div className={styles.detailBadgeRow}>
                {[
                  { label: detail?.task?.status || selectedTask.status, color: statusConfig[selectedTask.status]?.color || '#8E8E93' },
                  { label: detail?.task?.assignee || selectedTask.assignee || 'unassigned', color: '#64D2FF' },
                  { label: `priority ${detail?.task?.priority ?? selectedTask.priority ?? 0}`, color: priorityLabel(detail?.task?.priority ?? selectedTask.priority).color },
                ].map((item) => (
                  <span key={item.label} className={styles.detailBadge} style={{ color: item.color }}>{item.label}</span>
                ))}
              </div>
              {(detail?.task?.body || selectedTask.body) ? (
                <p className={styles.detailBody}>{detail?.task?.body || selectedTask.body}</p>
              ) : null}
              <div className={styles.detailMeta}>
                <span>Created {selectedTask.createdAt ? timeAgo(selectedTask.createdAt) : 'unknown'}</span>
                <span>Heartbeat {selectedTask.lastHeartbeatAt ? timeAgo(selectedTask.lastHeartbeatAt) : 'none'}</span>
                <span className={styles.detailMetaWorkspace}>Workspace {selectedTask.workspace_path || 'scratch'}</span>
              </div>
            </div>

            <div className={`macos-panel ${styles.actionsPanel}`}>
              <h3 className={styles.actionsPanelTitle}>Operator Actions</h3>
              <div className={styles.assignRow}>
                <input value={assigneeText} onChange={(event) => setAssigneeText(event.target.value)} placeholder="assignee profile" className={styles.assignInput} />
                <button disabled={!assigneeText.trim()} onClick={() => runAction({ action: 'assign', taskId: selectedTask.id, assignee: assigneeText.trim() })}
                  className={assigneeText.trim() ? styles.assignBtnActive : styles.assignBtnDisabled}>Assign</button>
              </div>
              <textarea value={commentText} onChange={(event) => setCommentText(event.target.value)} placeholder="Add an audit comment" rows={3} className={styles.commentTextarea} />
              <button disabled={!commentText.trim()} onClick={async () => { await runAction({ action: 'comment', taskId: selectedTask.id, text: commentText.trim() }); setCommentText('') }}
                className={commentText.trim() ? styles.commentBtnActive : styles.commentBtnDisabled}>
                <MessageSquare size={14} /> Comment
              </button>
              <div className={styles.blockRow}>
                <input value={blockReason} onChange={(event) => setBlockReason(event.target.value)} placeholder="block reason" className={styles.blockInput} />
                <button onClick={() => runAction({ action: 'block', taskId: selectedTask.id, reason: blockReason.trim() || 'Blocked from Mission Control' })} className={styles.blockBtn}>Block</button>
              </div>
              <div className={styles.actionBtnRow}>
                <button onClick={() => runAction({ action: 'unblock', taskId: selectedTask.id })} className={styles.unblockBtn}>Unblock</button>
                <button onClick={() => { if (confirm(`Archive ${selectedTask.id}?`)) void runAction({ action: 'archive', taskId: selectedTask.id }) }} className={styles.archiveBtn}>
                  <Archive size={14} /> Archive
                </button>
              </div>
              {actionMutation.isPending ? <p className={styles.actionPending}>Applying action...</p> : null}
            </div>

            <div className={`macos-panel ${styles.runsPanel}`}>
              <h3 className={styles.runsPanelTitle}>Runs</h3>
              <div className={styles.runsList}>
                {detail?.runs?.length ? detail.runs.map((run) => (
                  <div key={run.id} className={styles.runItem}>
                    <div className={styles.runItemHeader}>
                      <span>{run.profile || 'worker'} · {run.status || 'unknown'}</span>
                      <span>{run.startedAt ? timeAgo(run.startedAt) : ''}</span>
                    </div>
                    {run.summary || run.error ? <p className={`${styles.runItemSummary} ${run.error ? styles.runItemSummaryErr : styles.runItemSummaryOk}`}>{run.error || run.summary}</p> : null}
                  </div>
                )) : <p className={styles.runsEmpty}>No runs recorded.</p>}
              </div>
            </div>

            <div className={`macos-panel ${styles.eventsPanel}`}>
              <h3 className={styles.eventsPanelTitle}>Recent Events</h3>
              <div className={styles.eventsList}>
                {detail?.events?.length ? detail.events.slice().reverse().slice(0, 8).map((event, index) => (
                  <div key={`${event.kind}-${index}`} className={styles.eventRow}>
                    <span>{event.kind}</span>
                    <span className={styles.eventTimestamp}>{event.createdAt ? timeAgo(event.createdAt) : ''}</span>
                  </div>
                )) : <p className={styles.eventsEmpty}>No events recorded.</p>}
              </div>
            </div>
          </aside>
        </div>
      ) : null}

      {showCreate ? (
        <div className={styles.createOverlay} onClick={() => setShowCreate(false)}>
          <div onClick={(event) => event.stopPropagation()} className={styles.createModal}>
            <div className={styles.createModalHeader}>
              <h2 className={styles.createModalTitle}>New Hermes Card</h2>
              <button onClick={() => setShowCreate(false)} className={styles.createModalCloseBtn}><X size={15} /></button>
            </div>
            <input value={createForm.title} onChange={(event) => setCreateForm((prev) => ({ ...prev, title: event.target.value }))} placeholder="Title" autoFocus className={styles.createInput} />
            <textarea value={createForm.body} onChange={(event) => setCreateForm((prev) => ({ ...prev, body: event.target.value }))} placeholder="Body and acceptance criteria" rows={5} className={styles.createTextarea} />
            <div className={`${styles.createFieldGrid} ${m ? styles.createFieldGridMobile : styles.createFieldGridDesktop}`}>
              <input value={createForm.assignee} onChange={(event) => setCreateForm((prev) => ({ ...prev, assignee: event.target.value }))} placeholder="Assignee" className={styles.createInput} />
              <input value={createForm.priority} onChange={(event) => setCreateForm((prev) => ({ ...prev, priority: event.target.value }))} placeholder="Priority" type="number" className={styles.createInput} />
              <input value={createForm.workspace} onChange={(event) => setCreateForm((prev) => ({ ...prev, workspace: event.target.value }))} placeholder="workspace, e.g. dir:/Users/..." className={styles.createInput} />
              <input value={createForm.skills} onChange={(event) => setCreateForm((prev) => ({ ...prev, skills: event.target.value }))} placeholder="skills, comma separated" className={styles.createInput} />
            </div>
            <label className={styles.createTriageLabel}>
              <input type="checkbox" checked={createForm.triage} onChange={(event) => setCreateForm((prev) => ({ ...prev, triage: event.target.checked }))} />
              Start in triage
            </label>
            <button disabled={!createForm.title.trim() || actionMutation.isPending} onClick={createTask}
              className={createForm.title.trim() ? styles.createBtnActive : styles.createBtnDisabled}>
              Create Card
            </button>
          </div>
        </div>
      ) : null}
    </PageTransition>
  )
}
