import { useEffect, useMemo, useState } from 'react'
import { Users, UserCog, Sparkles, RefreshCw, Hammer, ChevronDown, Check } from 'lucide-react'
import PageTransition from '../components/PageTransition'
import GlassCard from '../components/GlassCard'
import styles from './TeamStructure.module.css'

type Member = {
  id: string
  name: string
  emoji: string
  model: string
  modelKey?: string
  workspace?: string | null
  role: string
  capability?: string
  title?: string
  registryStatus?: string
  runtimeStatus?: string
  source?: string
  summary?: string
  responsibilities: string[]
}

type Group = { role: string; capability?: string; emoji?: string; members: Member[] }

type TeamPayload = {
  lead: { id: string; name: string; emoji: string; model: string; modelKey?: string } | null
  roleGroups: Group[]
  missingSuggested: { id: string; capability?: string; role: string; name: string; emoji: string; reason?: string; severity?: string }[]
  totalAgents: number
  mode?: string
  shadow?: { enabled?: boolean; canary?: boolean }
  dataSources?: { registry?: string; runtime?: string }
  updatedAt?: string
}


function modelOptionLabel(name: string, id: string) {
  const k = String(id || '').trim()
  if (!k) return String(name || '').trim() || 'Unknown model'
  if (k.includes('gpt-5.3-codex-spark')) return 'GPT-5.3 Codex Spark'
  if (k.includes('gpt-5.3-codex')) return 'GPT-5.3 Codex'
  if (k.includes('gpt-5.2-codex')) return 'GPT-5.2 Codex'
  if (k.includes('claude-sonnet-4-6')) return 'Claude Sonnet 4.6'
  if (k.includes('claude-opus-4-6')) return 'Claude Opus 4.6'
  if (k.includes('claude-opus-4-5')) return 'Claude Opus 4.5'
  const stripped = k
    .replace(/^openai-codex\//, '')
    .replace(/^openai\//, '')
    .replace(/^anthropic\//, '')
    .replace(/^ollama\//, '')
  return stripped.length > 28 ? `${stripped.slice(0, 28)}...` : stripped
}

export default function TeamStructure() {
  const [data, setData] = useState<TeamPayload | null>(null)
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [bootstrapping, setBootstrapping] = useState(false)
  const [savingModel, setSavingModel] = useState<Record<string, boolean>>({})
  const [pendingModel, setPendingModel] = useState<Record<string, string>>({})
  const [openModelPicker, setOpenModelPicker] = useState<string | null>(null)
  const [pickerDirection, setPickerDirection] = useState<Record<string, 'up' | 'down'>>({})
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const activeGroupRole = useMemo(() => {
    if (!openModelPicker || !data) return null
    for (const group of data.roleGroups || []) {
      if (group.members?.some((m) => m.id === openModelPicker)) return group.role
    }
    return null
  }, [openModelPicker, data])

  // `loading` starts true and the UI only gates on `loading && !data`, so the
  // initial fetch needs no setLoading(true); later refreshes keep stale data visible.
  const load = async () => {
    try {
      const r = await fetch('/api/team/structure')
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      setData(j)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to load')
    } finally {
      setLoading(false)
    }
  }

  // Initial fetch on mount; load() only calls setState after awaiting the
  // response, but the lint rule traces the shared function and flags it anyway.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [])
  useEffect(() => {
    let cancelled = false
    const loadModels = async () => {
      try {
        const r = await fetch('/api/models')
        const j = await r.json()
        if (!r.ok || !Array.isArray(j) || cancelled) return
        const next = (j as { id?: unknown; name?: unknown }[])
          .map((m) => ({
            id: String(m?.id || ''),
            name: String(m?.name || m?.id || ''),
          }))
          .filter((m) => m.id)
        setModels(next)
      } catch { /* request failed; models list stays empty */ }
    }
    void loadModels()
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    const onDocMouseDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('[data-model-picker-root="true"]')) {
        setOpenModelPicker(null)
      }
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [])

  const visibleRoleGroups = useMemo(() => {
    if (!data) return []
    const leadId = data.lead?.id || ''
    return (data.roleGroups || [])
      .map((group) => ({
        ...group,
        members: (group.members || []).filter((member) => member.id !== leadId),
      }))
      .filter((group) => group.members.length > 0)
  }, [data])
  const totalMembers = useMemo(() => visibleRoleGroups.reduce((a, g) => a + g.members.length, 0), [visibleRoleGroups])
  const resolveModelValue = (id: string, fallback?: string) => pendingModel[id] || fallback || ''
  const setModelValue = (id: string, value: string) => {
    setPendingModel((prev) => ({ ...prev, [id]: value }))
  }
  const resolveCurrentModelLabel = (agentId: string, fallback?: string) => {
    const key = resolveModelValue(agentId, fallback || '')
    const model = models.find((m) => m.id === key)
    return key ? modelOptionLabel(model?.name || key, key) : 'Select model...'
  }

  const saveAgentModel = async (agentId: string, modelKey: string) => {
    const nextModel = String(modelKey || '').trim()
    if (!agentId || !nextModel) {
      setToast({ type: 'error', text: 'Agent ve model zorunlu.' })
      setTimeout(() => setToast(null), 3500)
      return
    }
    setSavingModel((prev) => ({ ...prev, [agentId]: true }))
    try {
      const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/model`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: nextModel }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok || j?.ok === false) throw new Error(j?.error || `HTTP ${r.status}`)
      await load()
      setToast({ type: 'success', text: `${agentId} modeli güncellendi.` })
      setTimeout(() => setToast(null), 3500)
    } catch (e) {
      setToast({ type: 'error', text: `Model update failed: ${e instanceof Error ? e.message : String(e)}` })
      setTimeout(() => setToast(null), 5000)
    } finally {
      setSavingModel((prev) => ({ ...prev, [agentId]: false }))
    }
  }

  const handleModelChange = async (agentId: string, currentModel: string, nextModel: string) => {
    const next = String(nextModel || '').trim()
    const current = String(currentModel || '').trim()
    setModelValue(agentId, next)
    if (!next || next === current) return
    await saveAgentModel(agentId, next)
  }

  const bootstrap = async () => {
    setBootstrapping(true)
    try {
      const r = await fetch('/api/team/structure/bootstrap', { method: 'POST' })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`)
      await load()
      setToast({ type: 'success', text: j.message || 'Role suggestions generated. No agents were created.' })
      setTimeout(() => setToast(null), 3500)
    } catch (e) {
      setToast({ type: 'error', text: `Suggestion generation failed: ${e instanceof Error ? e.message : String(e)}` })
      setTimeout(() => setToast(null), 5000)
    } finally {
      setBootstrapping(false)
    }
  }

  const renderModelPicker = (agentId: string, fallbackModel?: string) => {
    const current = resolveModelValue(agentId, fallbackModel || '')
    const isOpen = openModelPicker === agentId
    const direction = pickerDirection[agentId] || 'down'
    return (
      <div data-model-picker-root="true" className={styles.modelPickerRoot}>
        <button
          type="button"
          onClick={(event) => {
            if (isOpen) {
              setOpenModelPicker(null)
              return
            }
            const rect = event.currentTarget.getBoundingClientRect()
            const estimatedMenuHeight = Math.min(220, Math.max(90, models.length * 34)) + 12
            const shouldOpenUp = rect.bottom + estimatedMenuHeight > window.innerHeight - 12
            setPickerDirection((prev) => ({ ...prev, [agentId]: shouldOpenUp ? 'up' : 'down' }))
            setOpenModelPicker(agentId)
          }}
          className={`${styles.modelPickerBtn} ${isOpen ? styles.modelPickerBtnOpen : ''}`}
          title={current || 'Select model'}
        >
          <span className={styles.modelPickerBtnInner}>
            <span className={styles.modelPickerBtnText}>{resolveCurrentModelLabel(agentId, fallbackModel)}</span>
            <ChevronDown size={12} style={{ marginLeft: 'auto', opacity: 0.8, flexShrink: 0 }} />
          </span>
        </button>
        {isOpen ? (
          <div className={styles.modelPickerDropdown} style={{ [direction === 'up' ? 'bottom' : 'top']: 34 }}>
            {models.map((opt) => {
              const selected = opt.id === current
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setOpenModelPicker(null)
                    void handleModelChange(agentId, fallbackModel || '', opt.id)
                  }}
                  className={`${styles.modelOption} ${selected ? styles.modelOptionSelected : styles.modelOptionDefault}`}
                  title={opt.id}
                >
                  {selected ? <Check size={12} /> : <span className={styles.modelOptionPlaceholder} />}
                  {modelOptionLabel(opt.name, opt.id)}
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <PageTransition>
      <div className={styles.page}>
        <div className={styles.headerRow}>
          <div>
            <h1 className={`text-title ${styles.pageTitle}`}>
              <Users size={22} className={styles.pageTitleIcon} /> Team Structure
            </h1>
            <p className="text-body" style={{ marginTop: 4 }}>Main agent + regularly used subagents grouped by roles and responsibilities.</p>
          </div>
          <div className={styles.headerActions}>
            <button onClick={load} className={styles.refreshBtn}><RefreshCw size={14} /> Refresh</button>
            {data?.missingSuggested?.length ? (
              <button onClick={bootstrap} disabled={bootstrapping} className={styles.bootstrapBtn} style={{ opacity: bootstrapping ? 0.6 : 1 }}>
                <Hammer size={14} /> {bootstrapping ? 'Generating...' : `Generate Role Suggestions (${data.missingSuggested.length})`}
              </button>
            ) : null}
          </div>
        </div>

        {error && <div className={`macos-panel ${styles.errorPanel}`}>{error}</div>}
        {toast && (
          <div className={`macos-panel ${styles.toastPanel}`} style={{ border: `1px solid ${toast.type === 'success' ? 'rgba(50,215,75,0.35)' : 'rgba(255,69,58,0.35)'}`, background: toast.type === 'success' ? 'rgba(50,215,75,0.12)' : 'rgba(255,69,58,0.12)', color: toast.type === 'success' ? '#32D74B' : '#FF453A' }}>
            {toast.text}
          </div>
        )}

        {loading && !data ? (
          <div className={`macos-panel ${styles.loadingPanel}`}>Loading team structure...</div>
        ) : null}

        {!!data && (
          <>
            <div className={styles.statGrid}>
              <div style={{ position: 'relative', zIndex: openModelPicker === data.lead?.id ? 40 : 1 }}>
                <GlassCard noPad overflowVisible>
                  <div className={styles.statPad}>
                    <div className={styles.statLabel}>Lead Agent</div>
                    <div className={styles.statAgentRow}>
                      <span className={styles.statEmoji}>{data.lead?.emoji || '🤖'}</span>
                      <div>
                        <div className={styles.statAgentName}>{data.lead?.name || 'main'}</div>
                        <div className={styles.statAgentModel}>{data.lead?.model || '—'}</div>
                      </div>
                    </div>
                    {data.lead ? (
                      <div className={styles.statModelRow}>
                        <span className={styles.statModelLabel}>Model</span>
                        {renderModelPicker(data.lead.id, data.lead.modelKey || '')}
                      </div>
                    ) : null}
                  </div>
                </GlassCard>
              </div>

              <GlassCard noPad>
                <div className={styles.statPad}>
                  <div className={styles.statLabel}>Subagents</div>
                  <div className={styles.statValueBlue}>{totalMembers}</div>
                </div>
              </GlassCard>

              <GlassCard noPad>
                <div className={styles.statPad}>
                  <div className={styles.statLabel}>Total Agents</div>
                  <div className={styles.statValueGreen}>{data.totalAgents}</div>
                  {data.mode ? (
                    <div className={styles.statMode}>
                      Mode: {data.mode}{data.shadow?.enabled ? data.shadow?.canary ? ' · shadow+canary' : ' · shadow' : ''}
                    </div>
                  ) : null}
                </div>
              </GlassCard>
            </div>

            {data.missingSuggested?.length ? (
              <GlassCard noPad>
                <div className={styles.suggestionsPad}>
                  <div className={styles.suggestionsHeader}>
                    <Sparkles size={14} /> Suggested Missing Roles
                  </div>
                  <div className={styles.suggestionsList}>
                    {data.missingSuggested.map((m) => (
                      <div key={m.id} className={styles.suggestionItem}>
                        <div className={styles.suggestionTitle}>{m.emoji} {m.name} · {m.role}</div>
                        {m.reason ? <div className={styles.suggestionReason}>{m.reason}</div> : null}
                      </div>
                    ))}
                  </div>
                </div>
              </GlassCard>
            ) : null}

            <div className={styles.roleGrid}>
              {visibleRoleGroups.map((group) => (
                <div key={group.role} style={{ position: 'relative', zIndex: activeGroupRole === group.role ? 30 : 1 }}>
                  <GlassCard noPad overflowVisible>
                    <div className={styles.groupCardHeader}>
                      <div className={styles.groupCardHeaderRow}>
                        <div className={styles.groupCardTitle}>
                          <UserCog size={14} /> {group.emoji ? `${group.emoji} ` : ''}{group.role}
                        </div>
                        <span className={styles.groupCardCount}>{group.members.length}</span>
                      </div>
                    </div>
                    <div className={styles.groupCardBody}>
                      {group.members.length === 0 ? (
                        <div className={styles.groupEmpty}>No members</div>
                      ) : group.members.map((m) => (
                        <div key={m.id} className={styles.memberItem}>
                          <div className={styles.memberTop}>
                            <span className={styles.memberEmoji}>{m.emoji || '🤖'}</span>
                            <div>
                              <div className={styles.memberName}>{m.name}</div>
                              <div className={styles.memberId}>{m.id}</div>
                            </div>
                          </div>
                          {m.title || m.summary ? (
                            <div className={styles.memberSummary}>
                              {m.title ? <div className={styles.memberSummaryTitle}>{m.title}</div> : null}
                              {m.summary ? <div style={{ marginTop: m.title ? 2 : 0 }}>{m.summary}</div> : null}
                            </div>
                          ) : null}
                          <div className={styles.memberModelRow}>
                            <span className={styles.memberModelLabel}>Model</span>
                            {renderModelPicker(m.id, m.modelKey || '')}
                          </div>
                          {savingModel[m.id] ? <div className={styles.memberSaving}>Saving model...</div> : null}
                          <div className={styles.memberBadges}>
                            <span className={styles.memberBadge}>
                              {m.registryStatus === 'registered' ? 'Registry' : 'Unregistered'}
                            </span>
                            <span className={styles.memberBadge}>
                              {m.runtimeStatus === 'active' ? 'Runtime active' : 'Runtime inactive'}
                            </span>
                            {m.source ? (
                              <span className={styles.memberBadge}>{m.source}</span>
                            ) : null}
                          </div>
                          <ul className={styles.memberResponsibilities}>
                            {m.responsibilities?.slice(0, 2).map((r, i) => <li key={i}>{r}</li>)}
                          </ul>
                          {m.workspace ? <div className={styles.memberWorkspace}>{m.workspace}</div> : null}
                        </div>
                      ))}
                    </div>
                  </GlassCard>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </PageTransition>
  )
}
