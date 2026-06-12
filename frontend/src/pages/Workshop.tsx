import React, { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Clock, Zap, CheckCircle, Play, X, AlertCircle, Loader2, ArrowLeft, MessageSquare } from 'lucide-react'
import PageTransition from '../components/PageTransition'
import { apiQueryOptions, timeAgo } from '../lib/hooks'
import { useIsMobile } from '../lib/useIsMobile'
import styles from './Workshop.module.css'

const priorityConfig: Record<string, { color: string; label: string }> = {
  high: { color: '#FF453A', label: 'High' },
  medium: { color: '#FF9500', label: 'Medium' },
  low: { color: '#007AFF', label: 'Low' },
}

const columnConfig: Record<string, { title: string; color: string; icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }> }> = {
  queue: { title: 'Queue', color: '#8E8E93', icon: Clock },
  inProgress: { title: 'In Progress', color: '#007AFF', icon: Zap },
  blocked: { title: 'Blocked', color: '#FF453A', icon: AlertCircle },
  done: { title: 'Done', color: '#32D74B', icon: CheckCircle },
}

interface Task {
  id: string
  title: string
  description: string
  priority: string
  created?: string
  completed?: string
  startedAt?: string
  status?: string
  result?: string
  error?: string
  tags: string[]
  source?: string
  childSessionKey?: string
  executionPath?: 'direct' | 'task-path' | 'automation'
  routingReason?: string
  structuredTaskRequired?: boolean
  deliveryMode?: string
  managerDecision?: string
}

interface TasksPayload {
  columns: {
    queue: Task[]
    inProgress: Task[]
    blocked: Task[]
    done: Task[]
  }
}

const executionPathConfig: Record<string, { label: string; color: string; bg: string; border: string }> = {
  direct: { label: 'Direct', color: '#64D2FF', bg: 'rgba(100,210,255,0.12)', border: '1px solid rgba(100,210,255,0.25)' },
  'task-path': { label: 'Task Path', color: '#32D74B', bg: 'rgba(50,215,75,0.12)', border: '1px solid rgba(50,215,75,0.25)' },
  automation: { label: 'Automation', color: '#BF5AF2', bg: 'rgba(191,90,242,0.12)', border: '1px solid rgba(191,90,242,0.25)' },
}

function renderPathBadge(path?: string) {
  const config = executionPathConfig[String(path || 'task-path')] || executionPathConfig['task-path']
  return (
    <span className={styles.pathBadge} style={{ color: config.color, background: config.bg, border: config.border }}>
      {config.label}
    </span>
  )
}

function blockedExplanation(task: Task) {
  const text = `${task.error || ''}\n${task.result || ''}`.trim()
  const lower = text.toLowerCase()
  const reasons: string[] = []
  const nextSteps: string[] = []

  if (lower.includes('no usable result')) {
    reasons.push('The agent process returned success, but the task did not produce a usable final result.')
    nextSteps.push('Re-run only after the gateway/config issue below is fixed; otherwise it will likely false-complete again.')
  }
  if (lower.includes('gateway token mismatch') || lower.includes('unauthorized')) {
    reasons.push('The local gateway rejected the request because the configured remote token does not match.')
    nextSteps.push('Align gateway.remote.token with the running gateway, then retry this task.')
  }
  if (lower.includes('missing env var')) {
    const matches = [...text.matchAll(/missing env var "([^"]+)"/g)].map(match => match[1])
    const unique = Array.from(new Set(matches)).slice(0, 4)
    reasons.push(unique.length ? `Missing environment variables: ${unique.join(', ')}.` : 'One or more configured environment variables are missing.')
    nextSteps.push('Set the required env vars only if that integration is needed; optional providers can stay disabled.')
  }
  if (!reasons.length && text) {
    reasons.push(text.split('\n').find(Boolean)?.slice(0, 180) || 'The task reported an execution error.')
  }
  if (!nextSteps.length) {
    nextSteps.push('Open the task report, fix the first concrete failure, then retry.')
  }

  return { reasons, nextSteps }
}

function BlockedExplanation({ task, compact = false }: { task: Task; compact?: boolean }) {
  const explanation = blockedExplanation(task)
  return (
    <div className={`${styles.blockedExplanation} ${compact ? styles.blockedExplanationCompact : styles.blockedExplanationFull}`}>
      <div className={styles.blockedWhy}>Why blocked</div>
      {explanation.reasons.slice(0, compact ? 1 : 3).map((reason) => (
        <p key={reason} className={`${styles.blockedReason} ${compact ? styles.blockedReasonCompact : styles.blockedReasonFull}`}>{reason}</p>
      ))}
      {!compact && (
        <div className={styles.blockedNextStepsWrap}>
          <div className={styles.blockedNextLabel}>Next useful action</div>
          {explanation.nextSteps.slice(0, 2).map((step) => (
            <p key={step} className={styles.blockedNextStep}>{step}</p>
          ))}
        </div>
      )}
    </div>
  )
}

export default function Workshop() {
  const m = useIsMobile()
  const queryClient = useQueryClient()
  const { data, isLoading: loading } = useQuery(apiQueryOptions<TasksPayload>('/api/tasks', 5000))
  const donePageSize = m ? 6 : 10
  const [showAddModal, setShowAddModal] = useState(false)
  const [viewTask, setViewTask] = useState<Task | null>(null)
  const [addForm, setAddForm] = useState({ title: '', description: '', priority: 'medium', tags: '' })
  const [executing, setExecuting] = useState<Record<string, boolean>>({})
  const [doneVisibleCount, setDoneVisibleCount] = useState(donePageSize)
  const [searchParams, setSearchParams] = useSearchParams()
  const invalidateTasks = () => queryClient.invalidateQueries({ queryKey: ['api', '/api/tasks'] })

  const addTaskMutation = useMutation({
    mutationFn: async (payload: { title: string; description: string; priority: string; tags: string[] }) => {
      await fetch('/api/tasks/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    },
    onSuccess: invalidateTasks,
  })

  const executeTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      await fetch(`/api/tasks/${taskId}/execute`, { method: 'POST' })
    },
    onSettled: invalidateTasks,
  })

  const deleteTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' })
    },
    onSettled: invalidateTasks,
  })

  // Auto-open task from URL param (?task=xxx). This synchronizes external state
  // (the URL) into component state and must also clear the param via
  // setSearchParams, which cannot run during render — so the effect is the
  // right home for it despite the lint rule.
  useEffect(() => {
    if (!data || viewTask) return
    const taskId = searchParams.get('task')
    if (!taskId) return
    const columns = data.columns
    for (const col of Object.values(columns) as Task[][]) {
      const found = col.find(t => t.id === taskId)
      if (found) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setViewTask(found)
        setSearchParams({}, { replace: true })
        break
      }
    }
  }, [data, searchParams, viewTask, setSearchParams])

  // Clamp doneVisibleCount to totalDone during render (avoids setState-in-effect).
  const totalDone = data?.columns?.done?.length ?? 0
  const clampedDoneCount = totalDone === 0 ? donePageSize : Math.max(donePageSize, Math.min(doneVisibleCount, totalDone))
  if (clampedDoneCount !== doneVisibleCount) {
    setDoneVisibleCount(clampedDoneCount)
  }

  if (loading || !data) {
    return (
      <PageTransition>
        <div className={styles.loadingWrap}>
          <div className={styles.spinner} />
        </div>
      </PageTransition>
    )
  }

  const columns = data.columns

  const handleAddTask = async () => {
    if (!addForm.title.trim()) return
    try {
      await addTaskMutation.mutateAsync({
        title: addForm.title.trim(),
        description: addForm.description.trim(),
        priority: addForm.priority,
        tags: addForm.tags.split(',').map(t => t.trim()).filter(Boolean),
      })
      setShowAddModal(false)
      setAddForm({ title: '', description: '', priority: 'medium', tags: '' })
    } catch { /* mutation failed; modal stays open so user can retry */ }
  }

  const handleExecute = async (taskId: string) => {
    setExecuting(prev => ({ ...prev, [taskId]: true }))
    try {
      await executeTaskMutation.mutateAsync(taskId)
    } catch { /* execution request failed; task remains in current column */ }
  }

  const discussWithMudur = (task: Task) => {
    const reportSnippet = task.result ? task.result.substring(0, 500) : task.description
    const message = `Regarding the task "${task.title}":\n\n${reportSnippet}\n\nWhat should we do with this?`
    window.dispatchEvent(new CustomEvent('open-chat', { detail: { message } }))
  }

  // === TASK REPORT VIEW ===
  if (viewTask) {
    const isExecuting = viewTask.status === 'executing'
    return (
      <PageTransition>
        <div className={styles.reportPage} style={{ maxWidth: m ? '100%' : 800, gap: m ? 14 : 20 }}>
          {/* Header */}
          <div className={styles.reportHeader}>
            <button onClick={() => setViewTask(null)} className={styles.backBtn}>
              <ArrowLeft size={18} />
            </button>
            <div className={styles.reportTitleWrap}>
              <h2 className={styles.reportTitle} style={{ fontSize: m ? 15 : 17 }}>
                {viewTask.title}
              </h2>
              <div className={styles.reportStatusRow}>
                <span className={styles.priorityIndicator} style={{ background: priorityConfig[viewTask.priority]?.color || '#8E8E93' }} />
                <span className={styles.reportStatusText}>
                  {isExecuting ? 'Sub-agent working...' : viewTask.status === 'done' ? `Completed ${viewTask.completed ? timeAgo(viewTask.completed) : ''}` : 'Queued'}
                </span>
                {renderPathBadge(viewTask.executionPath)}
                {viewTask.structuredTaskRequired ? (
                  <span className={styles.reportDecisionFirst}>
                    decision-first
                  </span>
                ) : null}
                {viewTask.tags?.map(tag => (
                  <span key={tag} className={styles.reportTagChip}>{tag}</span>
                ))}
              </div>
            </div>
          </div>

          {/* Description */}
          {viewTask.description && (
            <div className="macos-panel" style={{ padding: m ? 14 : 20 }}>
              <p className={styles.reportDescLabel}>Task Description</p>
              <p className={styles.reportDescBody}>{viewTask.description}</p>
              {viewTask.routingReason ? (
                <p className={styles.reportRoute}>
                  Route: {viewTask.routingReason}
                </p>
              ) : null}
            </div>
          )}

          {/* Executing state */}
          {isExecuting && (
            <div className="macos-panel" style={{ padding: m ? 14 : 20 }}>
              <div className={styles.executingRow}>
                <Loader2 size={18} style={{ color: '#007AFF', animation: 'spin 1s linear infinite' }} />
                <div>
                  <p className={styles.executingTitle}>Sub-agent is working...</p>
                  <p className={styles.executingSubtitle}>Results will appear here when done. This page auto-refreshes.</p>
                </div>
              </div>
            </div>
          )}

          {/* Report */}
          {viewTask.result && (
            <div className="macos-panel" style={{ padding: m ? 14 : 24 }}>
              <div className={styles.reportResultHeader}>
                <p className={styles.reportResultLabel}>📋 Agent Report</p>
              </div>
              <div className={styles.reportResultBody}>
                {viewTask.result}
              </div>
            </div>
          )}

          {/* Error */}
          {viewTask.error && (
            <div className="macos-panel" style={{ padding: m ? 14 : 20, borderLeft: '3px solid #FF453A' }}>
              <div className={styles.errorRow}>
                <AlertCircle size={16} style={{ color: '#FF453A' }} />
                <p className={styles.errorText}>{viewTask.error}</p>
              </div>
              <BlockedExplanation task={viewTask} />
            </div>
          )}

          {/* Action buttons */}
          <div className={styles.reportActions} style={{ flexDirection: m ? 'column' : 'row' }}>
            {/* Discuss with Müdür — the primary action */}
            {viewTask.result && (
              <button onClick={() => discussWithMudur(viewTask)} className={styles.primaryActionBtn}>
                <MessageSquare size={15} /> Discuss with Müdür
              </button>
            )}

            {/* Execute for queue tasks */}
            {!viewTask.result && !isExecuting && (
              <button
                onClick={() => { handleExecute(viewTask.id); setViewTask({ ...viewTask, status: 'executing' }); }}
                disabled={executing[viewTask.id]}
                className={styles.primaryActionBtn}
              >
                <Play size={15} /> Execute Task
              </button>
            )}

            {/* Re-execute */}
            {viewTask.result && (
              <button
                onClick={() => { handleExecute(viewTask.id); setViewTask({ ...viewTask, status: 'executing', result: undefined }); }}
                className={styles.rerunBtn}
              >
                <Play size={14} /> Re-run
              </button>
            )}
          </div>

          {/* Delete button */}
          <button
            onClick={async () => {
              if (!confirm(`Delete "${viewTask.title}"?`)) return
              await deleteTaskMutation.mutateAsync(viewTask.id)
              setViewTask(null)
            }}
            className={`${styles.deleteBtn} ${m ? styles.deleteBtnMobile : ''}`}
          >
            🗑 Delete Task
          </button>
        </div>
      </PageTransition>
    )
  }

  // === KANBAN VIEW ===
  return (
    <PageTransition>
      <div className={`${styles.page} ${m ? styles.pageMobile : styles.pageDesktop}`}>
        {/* Header */}
        <div className={`${styles.headerRow} ${m ? styles.headerRowMobile : styles.headerRowDesktop}`}>
          <div>
            <h1 className="text-title">Workshop</h1>
            <p className={`text-body ${styles.headerSubtitle}`}>Create tasks, let your agent research & execute them</p>
          </div>
          <button
            onClick={() => setShowAddModal(true)}
            className={`${styles.addBtn} ${m ? styles.addBtnMobile : styles.addBtnDesktop}`}
          >
            <Plus size={15} /> Add Task
          </button>
        </div>

        {/* Kanban Columns */}
        <div className={`${styles.kanban} ${m ? styles.kanbanMobile : styles.kanbanDesktop}`}>
          {(['queue', 'inProgress', 'blocked', 'done'] as const).map((col) => {
            const tasks: Task[] = columns[col] || []
            const visibleTasks = col === 'done' ? tasks.slice(0, doneVisibleCount) : tasks
            const hiddenDoneCount = col === 'done' ? Math.max(0, tasks.length - visibleTasks.length) : 0
            const config = columnConfig[col]
            const Icon = config.icon
            return (
              <div key={col} className={styles.kanbanCol} style={{ flex: m ? undefined : 1 }}>
                {/* Column Header */}
                <div className={styles.colHeader}>
                  <Icon size={15} style={{ color: config.color }} />
                  <h3 className={styles.colTitle}>{config.title}</h3>
                  <span className={styles.colCount}>{tasks.length}</span>
                </div>

                {col === 'done' && tasks.length > donePageSize && (
                  <div className={styles.donePager}>
                    <p className={styles.donePagerLabel}>
                      Showing latest {visibleTasks.length} of {tasks.length}
                    </p>
                    <div className={styles.donePagerBtns}>
                      {hiddenDoneCount > 0 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setDoneVisibleCount((current) => Math.min(tasks.length, current + donePageSize))
                          }}
                          className={styles.donePagerBtnGreen}
                        >
                          Show {Math.min(donePageSize, hiddenDoneCount)} more
                        </button>
                      )}
                      {hiddenDoneCount > donePageSize && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setDoneVisibleCount(tasks.length)
                          }}
                          className={styles.donePagerBtnWhite}
                        >
                          Show all
                        </button>
                      )}
                      {doneVisibleCount > donePageSize && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            setDoneVisibleCount(donePageSize)
                          }}
                          className={styles.donePagerBtnGhost}
                        >
                          Recent only
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Cards */}
                <div className={`${styles.cardList} ${col === 'done' && !m ? styles.cardListDoneDesktop : ''}`}>
                  {tasks.length === 0 && (
                    <div className={styles.emptyCol}>
                      {col === 'queue' ? 'Add tasks or deploy from Scout' : col === 'inProgress' ? 'Execute a task to start' : 'Completed tasks show here'}
                    </div>
                  )}
                  {visibleTasks.map((task, i) => (
                    <motion.div
                      key={task.id}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.05 + i * 0.03 }}
                      className="macos-panel"
                      style={{ padding: m ? 14 : 16, cursor: 'pointer' }}
                      onClick={() => setViewTask(task)}
                    >
                      {/* Priority dot + title */}
                      <div className={styles.cardPriorityRow}>
                        <span
                          className={styles.priorityDot}
                          style={{ background: task.priority === 'high' ? '#FF453A' : task.priority === 'medium' ? '#FF9500' : '#8E8E93' }}
                        />
                        <h4 className={styles.cardTitle}>{task.title}</h4>
                        <span
                          className={styles.priorityBadge}
                          style={{
                            background: `rgba(${task.priority === 'high' ? '255,69,58' : task.priority === 'medium' ? '255,149,0' : '142,142,147'}, 0.15)`,
                            color: task.priority === 'high' ? '#FF453A' : task.priority === 'medium' ? '#FF9500' : '#8E8E93',
                          }}
                        >
                          {task.priority}
                        </span>
                        {renderPathBadge(task.executionPath)}
                      </div>

                      {/* Description */}
                      {task.description && (
                        <p className={styles.cardDescription}>{task.description}</p>
                      )}

                      {/* Status for in-progress */}
                      {col === 'inProgress' && task.status === 'executing' && (
                        <div className={styles.executingBanner}>
                          <Loader2 size={12} style={{ color: '#007AFF', animation: 'spin 1s linear infinite' }} />
                          <span className={styles.executingText}>Sub-agent working...</span>
                        </div>
                      )}

                      {col === 'blocked' && (
                        <div className={styles.blockedBanner}>
                          <AlertCircle size={12} style={{ color: '#FF453A' }} />
                          <span className={styles.blockedText}>{task.error ? 'Needs attention' : 'Execution blocked'}</span>
                        </div>
                      )}

                      {/* Result preview for done tasks */}
                      {col === 'done' && task.result && (
                        <div className={styles.doneResult}>
                          <p className={styles.doneResultText}>✅ {task.result}</p>
                        </div>
                      )}

                      {col === 'blocked' && (task.error || task.result) && (
                        <div className={styles.blockedExplanationCardWrap}>
                          <BlockedExplanation task={task} compact />
                        </div>
                      )}

                      {/* Footer: tags + actions */}
                      <div className={styles.cardFooter}>
                        <div className={styles.cardTagsWrap}>
                          {task.tags?.map(tag => {
                            const tagColors = ['#007AFF', '#32D74B', '#FF9500', '#FF453A', '#BF5AF2', '#64D2FF'];
                            const colorIndex = tag.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % tagColors.length;
                            const tagColor = tagColors[colorIndex];
                            return (
                              <span key={tag} style={{
                                fontSize: 10,
                                padding: '2px 7px',
                                borderRadius: 5,
                                background: `rgba(${parseInt(tagColor.slice(1,3), 16)}, ${parseInt(tagColor.slice(3,5), 16)}, ${parseInt(tagColor.slice(5,7), 16)}, 0.15)`,
                                color: tagColor,
                                border: `1px solid rgba(${parseInt(tagColor.slice(1,3), 16)}, ${parseInt(tagColor.slice(3,5), 16)}, ${parseInt(tagColor.slice(5,7), 16)}, 0.3)`
                              }}>{tag}</span>
                            );
                          })}
                          {task.source && (
                            <span className={task.source === 'scout' ? styles.sourceChipScout : styles.sourceChipOther}>
                              {task.source}
                            </span>
                          )}
                          {task.structuredTaskRequired ? (
                            <span className={styles.reportTagChip}>
                              decision-first
                            </span>
                          ) : null}
                        </div>

                        <div className={styles.cardActions}>
                          {/* Execute button for queue tasks */}
                          {col === 'queue' && (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleExecute(task.id); }}
                              disabled={executing[task.id]}
                              className={styles.executeBtn}
                              style={{
                                background: executing[task.id] ? 'rgba(0,122,255,0.3)' : '#007AFF',
                                cursor: executing[task.id] ? 'wait' : 'pointer',
                              }}
                            >
                              {executing[task.id] ? <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={12} />}
                              Execute
                            </button>
                          )}

                          {/* Discuss for done tasks */}
                          {col === 'done' && task.result && (
                            <button
                              onClick={(e) => { e.stopPropagation(); discussWithMudur(task); }}
                              className={styles.discussBtn}
                            >
                              <MessageSquare size={11} /> Discuss
                            </button>
                          )}

                          {col === 'blocked' && (
                            <button
                              onClick={(e) => { e.stopPropagation(); handleExecute(task.id); }}
                              disabled={executing[task.id]}
                              className={styles.retryBtn}
                            >
                              {executing[task.id] ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Play size={11} />}
                              Retry
                            </button>
                          )}

                          <span className={styles.cardTimeAgo}>
                            {task.completed ? timeAgo(task.completed) : task.created ? timeAgo(task.created) : ''}
                          </span>
                        </div>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Add Task Modal */}
      <AnimatePresence>
        {showAddModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={styles.modalOverlay}
            onClick={() => setShowAddModal(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              onClick={(e) => e.stopPropagation()}
              className={`${styles.modalBox} ${m ? styles.modalBoxMobile : styles.modalBoxDesktop}`}
            >
              <div className={styles.modalHeader}>
                <h2 className={styles.modalTitle}>Add Task</h2>
                <button onClick={() => setShowAddModal(false)} className={styles.modalCloseBtn}>
                  <X size={16} className={styles.modalCloseIcon} />
                </button>
              </div>

              <div className={styles.formFields}>
                <div>
                  <label className={styles.formLabel}>Title *</label>
                  <input
                    value={addForm.title}
                    onChange={(e) => setAddForm(prev => ({ ...prev, title: e.target.value }))}
                    placeholder="e.g. Research competitors, Write blog post..."
                    autoFocus
                    className={styles.formInput}
                  />
                </div>
                <div>
                  <label className={styles.formLabel}>Description</label>
                  <textarea
                    value={addForm.description}
                    onChange={(e) => setAddForm(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="What should be done? Any specific instructions..."
                    rows={3}
                    className={styles.formTextarea}
                  />
                </div>
                <div>
                  <label className={styles.formLabel}>Priority</label>
                  <div className={styles.priorityBtns}>
                    {(['low', 'medium', 'high'] as const).map(p => (
                      <button
                        key={p}
                        onClick={() => setAddForm(prev => ({ ...prev, priority: p }))}
                        className={styles.priorityBtn}
                        style={{
                          border: addForm.priority === p ? `1px solid ${priorityConfig[p].color}40` : '1px solid rgba(255,255,255,0.08)',
                          background: addForm.priority === p ? `${priorityConfig[p].color}15` : 'rgba(255,255,255,0.04)',
                          color: addForm.priority === p ? priorityConfig[p].color : 'rgba(255,255,255,0.5)',
                        }}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className={styles.formLabel}>Tags (comma separated)</label>
                  <input
                    value={addForm.tags}
                    onChange={(e) => setAddForm(prev => ({ ...prev, tags: e.target.value }))}
                    placeholder="research, email, dev..."
                    className={styles.formInput}
                  />
                </div>
              </div>

              <button
                onClick={handleAddTask}
                disabled={!addForm.title.trim()}
                className={styles.submitBtn}
                style={{
                  background: addForm.title.trim() ? '#007AFF' : 'rgba(255,255,255,0.08)',
                  cursor: addForm.title.trim() ? 'pointer' : 'not-allowed',
                  opacity: addForm.title.trim() ? 1 : 0.5,
                }}
              >
                Add to Queue
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </PageTransition>
  )
}
