import { useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Bot, X, MessageSquare, Activity, BarChart3, Plus } from 'lucide-react'
import PageTransition from '../components/PageTransition'
import { useIsMobile } from '../lib/useIsMobile'
import GlassCard from '../components/GlassCard'
import StatusBadge from '../components/StatusBadge'
import AnimatedCounter from '../components/AnimatedCounter'
import { useApi, timeAgo } from '../lib/hooks'
import styles from './Agents.module.css'

interface AgentInfo {
  id: string
  name?: string
  description?: string
  role?: string
  status?: string
  model?: string
  avatar?: string
  lastActive?: string
  sessionCount?: number
  totalTokens?: number
}

interface ModelInfo {
  id: string
  name: string
}

export default function Agents() {
  const m = useIsMobile()
  const { data, loading } = useApi<{ agents?: AgentInfo[] }>('/api/agents', 30000)
  const { data: sessionsData } = useApi<{ sessions?: unknown[] }>('/api/sessions', 15000) // Add real sessions data
  const { data: modelsData } = useApi<ModelInfo[]>('/api/models', 0)
  const { data: skillsData } = useApi<{ installed?: { name: string }[] }>('/api/skills', 0)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [createForm, setCreateForm] = useState({
    name: '',
    description: '',
    model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
    systemPrompt: '',
    skills: [] as string[]
  })

  const templates = [
    {
      name: 'Research Bot',
      description: 'You research topics thoroughly and provide summaries with sources',
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      systemPrompt: 'You research topics thoroughly and provide comprehensive summaries with sources. Focus on accuracy, credibility, and providing multiple perspectives on complex topics.',
      skills: ['web_search', 'web_fetch']
    },
    {
      name: 'Code Reviewer',
      description: 'You review code for bugs, security issues, and best practices',
      model: 'us.anthropic.claude-opus-4-6-v1',
      systemPrompt: 'You review code for bugs, security vulnerabilities, and adherence to best practices. Provide detailed feedback on code quality, performance, and maintainability.',
      skills: ['exec', 'read', 'write', 'edit']
    },
    {
      name: 'Content Writer',
      description: 'You write engaging content for blogs, social media, and marketing',
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      systemPrompt: 'You write engaging, high-quality content for blogs, social media, and marketing materials. Focus on clear communication, compelling narratives, and audience engagement.',
      skills: ['web_search', 'image']
    }
  ]

  const applyTemplate = (template: typeof templates[0]) => {
    setCreateForm({
      name: template.name,
      description: template.description,
      model: template.model,
      systemPrompt: template.systemPrompt,
      skills: template.skills
    })
  }

  const handleCreateAgent = async () => {
    try {
      const response = await fetch('/api/agents/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createForm)
      })
      
      if (response.ok) {
        setShowCreateModal(false)
        setCreateForm({
          name: '',
          description: '',
          model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
          systemPrompt: '',
          skills: []
        })
        // Refresh the agents list
        window.location.reload()
      }
    } catch (error) {
      console.error('Failed to create agent:', error)
    }
  }

  const handleSkillToggle = (skill: string) => {
    setCreateForm(prev => ({
      ...prev,
      skills: prev.skills.includes(skill)
        ? prev.skills.filter(s => s !== skill)
        : [...prev.skills, skill]
    }))
  }

  const agents = useMemo<AgentInfo[]>(() => (Array.isArray(data?.agents) ? data.agents : []), [data])
  const selected = agents.find((a) => a.id === selectedAgent)
  const liveSessions = Array.isArray(sessionsData?.sessions) ? sessionsData.sessions : []
  const agentMetrics = useMemo(() => {
    const sortedAgents = [...agents].sort((a, b) => {
      const scoreA = Number(a.sessionCount || 0) * 1_000_000 + Number(a.totalTokens || 0)
      const scoreB = Number(b.sessionCount || 0) * 1_000_000 + Number(b.totalTokens || 0)
      return scoreB - scoreA
    })
    const activeAgents = sortedAgents.filter((agent) => agent.status === 'active' || Number(agent.sessionCount || 0) > 0)
    const idleAgents = sortedAgents.filter((agent) => !activeAgents.includes(agent))
    return {
      totalAgents: sortedAgents.length,
      activeAgents,
      idleAgents,
      totalTokens: sortedAgents.reduce((sum, agent) => sum + Number(agent.totalTokens || 0), 0),
    }
  }, [agents])

  if (loading || !data) {
    return (
      <PageTransition>
        <div className={styles.loadingWrap}>
          <div className={styles.spinner} />
        </div>
      </PageTransition>
    )
  }

  return (
    <>
    <PageTransition>
      <div className={`${styles.page} ${m ? styles.pageMobile : styles.pageDesktop}`}>
        {/* Header */}
        <div className={`${styles.headerRow} ${m ? styles.headerRowMobile : styles.headerRowDesktop}`}>
          <div>
            <h1 className={`text-title ${styles.pageHeading}`}>
              <Bot size={m ? 18 : 22} style={{ color: '#BF5AF2' }} /> Agent Hub
            </h1>
            <p className={`text-body ${styles.pageSubtitle}`}>Your AI agents — active sessions, sub-agents & more</p>
          </div>
          <motion.button
            whileHover={m ? undefined : { scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => setShowCreateModal(true)}
            className={`${styles.createBtn} ${m ? styles.createBtnMobile : styles.createBtnDesktop}`}
          >
            <Plus size={16} />
            Create Agent
          </motion.button>
        </div>

        <div>
          {/* Agent Grid */}
          <div className={styles.agentGrid}>

            <div style={{ display: 'grid', gridTemplateColumns: m ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: m ? 12 : 16 }}>
              {[
                { label: 'Registered', value: agentMetrics.totalAgents, accent: '#BF5AF2' },
                { label: 'Live Agents', value: agentMetrics.activeAgents.length, accent: '#32D74B' },
                { label: 'Open Sessions', value: liveSessions.length, accent: '#007AFF' },
                { label: 'Tracked Tokens', value: `${Math.round(agentMetrics.totalTokens / 1000)}k`, accent: '#FF9F0A' },
              ].map((item, index) => (
                <GlassCard key={item.label} delay={0.02 + index * 0.03} noPad>
                  <div style={{ padding: m ? '14px 16px' : '16px 18px' }}>
                    <p className={`text-label ${styles.kpiLabel}`}>{item.label}</p>
                    <p className={styles.kpiValue} style={{ fontSize: m ? 22 : 26, color: item.accent }}>
                      {item.value}
                    </p>
                  </div>
                </GlassCard>
              ))}
            </div>

            {/* Real OpenClaw Agents Section */}
            <div>
              <h3 className={styles.sectionHeading}>
                <Activity size={18} className={styles.iconBlue} />
                Live Agents
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : 'repeat(auto-fill, minmax(280px, 1fr))', gap: m ? 12 : 16 }}>
                {agentMetrics.activeAgents.map((agent, i) => (
                  <motion.div
                    key={agent.id}
                    initial={{ opacity: 0, y: 12, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ delay: i * 0.06 }}
                    whileHover={{ y: -2, scale: 1.01 }}
                    onClick={() => setSelectedAgent(selectedAgent === agent.id ? null : agent.id)}
                    className="macos-panel"
                    style={{
                      borderRadius: m ? 12 : 16,
                      padding: m ? 14 : 20,
                      cursor: 'pointer',
                      borderColor: selectedAgent === agent.id ? 'rgba(0,122,255,0.35)' : undefined,
                      background: selectedAgent === agent.id ? 'rgba(0,122,255,0.08)' : undefined,
                    }}
                  >
                    <div className={styles.agentCardBody}>
                      <div className={styles.agentAvatar}>{agent.avatar || '🤖'}</div>
                      <div className={styles.agentMeta}>
                        <div className={styles.agentNameRow}>
                          <h3 className={styles.agentName}>{agent.name}</h3>
                          <StatusBadge status={agent.status ?? 'off'} pulse={agent.status === 'active'} />
                        </div>
                        <p className={styles.agentRole}>{agent.role}</p>
                        <p className={styles.agentModel}>{agent.model || 'Unknown model'}</p>
                      </div>
                    </div>

                    <p className={styles.agentDescription}>{agent.description}</p>

                    <div className={styles.agentStats}>
                      <span className={styles.agentStatItem}>
                        <BarChart3 size={11} className={styles.agentStatIcon} />
                        {((agent.totalTokens || 0) / 1000).toFixed(0)}k tokens
                      </span>
                      <span className={styles.agentStatItem}>
                        <MessageSquare size={11} className={styles.agentStatIcon} />
                        {agent.sessionCount || 0} sessions
                      </span>
                      <span className={styles.agentStatItem}>
                        <Activity size={11} className={styles.agentStatIcon} />
                        {agent.lastActive ? timeAgo(agent.lastActive) : 'no signal'}
                      </span>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>

            {/* Registry Section */}
            {agentMetrics.idleAgents.length > 0 && (
              <div>
                <h3 className={styles.sectionHeading}>
                  <Bot size={18} className={styles.iconPurple} />
                  Agent Registry
                </h3>
                <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : 'repeat(auto-fill, minmax(320px, 1fr))', gap: m ? 12 : 16 }}>
                  {agentMetrics.idleAgents.map((agent, i) => (
                    <motion.div
                      key={agent.id}
                      initial={{ opacity: 0, y: 12, scale: 0.98 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ delay: 0.3 + i * 0.06 }}
                      whileHover={{ y: -3, scale: 1.01 }}
                      onClick={() => setSelectedAgent(selectedAgent === agent.id ? null : agent.id)}
                      className="macos-panel"
                      style={{
                        borderRadius: m ? 12 : 16, padding: m ? 14 : 20, cursor: 'pointer',
                        borderColor: selectedAgent === agent.id ? 'rgba(191,90,242,0.4)' : undefined,
                        background: selectedAgent === agent.id ? 'rgba(191,90,242,0.08)' : undefined,
                      }}
                    >
                      <div className={styles.agentCardBody}>
                        <div className={styles.agentAvatar}>{agent.avatar || '🤖'}</div>
                        <div className={styles.agentMeta}>
                          <div className={styles.agentNameRow}>
                            <h3 className={styles.agentName}>{agent.name}</h3>
                            <StatusBadge status={agent.status ?? 'off'} pulse={agent.status === 'active'} />
                          </div>
                          <p className={styles.agentRole}>{agent.role}</p>
                          <p className={styles.agentModel}>{agent.model || 'Unknown Model'}</p>
                        </div>
                      </div>
                      <p className={styles.agentDescription}>{agent.description}</p>
                      <div className={styles.agentStats}>
                        <span className={styles.agentStatItem}>
                          <BarChart3 size={11} className={styles.agentStatIcon} /> {((agent.totalTokens || 0) / 1000).toFixed(0)}k tokens
                        </span>
                        <span className={styles.agentStatItem}>
                          <Activity size={11} className={styles.agentStatIcon} /> {agent.lastActive ? timeAgo(agent.lastActive) : 'n/a'}
                        </span>
                        <span className={styles.agentStatRole}>
                          {agent.role}
                        </span>
                      </div>
                    </motion.div>
                  ))}
                </div>
              </div>
            )}

            {/* Detail Panel */}
            <AnimatePresence>
              {selected && (
                <motion.div
                  initial={{ opacity: 0, height: 0, scale: 0.98 }}
                  animate={{ opacity: 1, height: 'auto', scale: 1 }}
                  exit={{ opacity: 0, height: 0, scale: 0.98 }}
                  transition={{ duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
                  style={{ overflow: 'hidden' }}
                >
                  <GlassCard hover={false} noPad>
                    <div style={{ padding: m ? 16 : 24 }}>
                      <div className={styles.detailHeader}>
                        <div className={styles.detailHeaderLeft}>
                          <div className={styles.detailAvatar}>{selected.avatar}</div>
                          <div style={{ minWidth: 0 }}>
                            <h3 className={styles.detailAgentName}>{selected.name}</h3>
                            <p className={styles.detailAgentDesc}>{selected.description}</p>
                          </div>
                        </div>
                        <motion.button
                          whileHover={{ scale: 1.1 }}
                          whileTap={{ scale: 0.9 }}
                          className="macos-button"
                          style={{ padding: 8 }}
                          onClick={() => setSelectedAgent(null)}
                        >
                          <X size={16} style={{ color: 'rgba(255,255,255,0.6)' }} />
                        </motion.button>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: m ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 16 }}>
                        {[
                          { label: 'Tokens', value: <><AnimatedCounter end={Math.round((selected.totalTokens || 0) / 1000)} /><span style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>k</span></> },
                          { label: 'Last Active', value: selected.lastActive ? timeAgo(selected.lastActive) : '—' },
                          { label: 'Model', value: selected.model?.replace('us.anthropic.', '').replace(/claude-opus-(\d+).*/, 'Claude Opus $1').replace(/claude-sonnet-(\d+).*/, 'Claude Sonnet $1').replace(/claude-haiku-(\d+).*/, 'Claude Haiku $1').replace(/-/g, ' ') || 'Unknown' },
                          { label: 'Status', value: <StatusBadge status={selected.status ?? 'off'} size="md" /> },
                        ].map((item, idx) => (
                          <div key={idx} className={styles.detailMetaItem}>
                            <p className={styles.detailMetaValue}>{item.value}</p>
                            <p className={styles.detailMetaLabel}>{item.label}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  </GlassCard>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Recommended Agents Section */}
          <div className={styles.recommendedSection}>
            <h2 className={styles.recommendedHeading}>
              Recommended Agents
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : 'repeat(2, 1fr)', gap: m ? 12 : 16 }}>
              {[
                {
                  name: 'Research Assistant',
                  description: 'Searches the web, summarizes findings, writes reports',
                  model: 'Claude Sonnet 4',
                  modelId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
                  systemPrompt: 'You are a thorough research assistant. Search the web comprehensively, analyze findings from multiple sources, and create detailed reports with citations. Focus on accuracy, credibility, and providing balanced perspectives.',
                  skills: ['web_search', 'web_fetch', 'write']
                },
                {
                  name: 'Code Reviewer',
                  description: 'Reviews PRs, finds bugs, suggests improvements',
                  model: 'Claude Opus 4',
                  modelId: 'us.anthropic.claude-opus-4-6-v1',
                  systemPrompt: 'You are an expert code reviewer. Analyze code for bugs, security vulnerabilities, performance issues, and adherence to best practices. Provide detailed, actionable feedback with specific suggestions for improvement.',
                  skills: ['read', 'write', 'edit', 'exec']
                },
                {
                  name: 'Content Writer',
                  description: 'Drafts blog posts, social media, marketing copy',
                  model: 'Claude Sonnet 4',
                  modelId: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
                  systemPrompt: 'You are a skilled content writer specializing in engaging copy for blogs, social media, and marketing. Create compelling narratives that resonate with target audiences while maintaining brand voice and achieving clear objectives.',
                  skills: ['web_search', 'image', 'write']
                },
                {
                  name: 'Security Scanner',
                  description: 'Monitors bug bounties, scans for vulnerabilities',
                  model: 'Claude Haiku 4',
                  modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
                  systemPrompt: 'You are a security researcher focused on finding vulnerabilities and monitoring bug bounty programs. Analyze targets methodically, identify potential security weaknesses, and track new opportunities efficiently.',
                  skills: ['web_search', 'exec', 'read']
                }
              ].map((template, i) => (
                <motion.div
                  key={template.name}
                  initial={{ opacity: 0, y: 12, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ delay: 0.6 + i * 0.08 }}
                  whileHover={{ y: -2, scale: 1.01 }}
                  className={`${styles.templateCard} ${m ? styles.templateCardMobile : styles.templateCardDesktop}`}
                  onClick={() => {
                    setCreateForm({
                      name: template.name,
                      description: template.description,
                      model: template.modelId,
                      systemPrompt: template.systemPrompt,
                      skills: template.skills
                    })
                    setShowCreateModal(true)
                  }}
                >
                  <div className={styles.templateCardBody}>
                    <div className={styles.templateAvatar}>⚙️</div>
                    <div className={styles.templateMeta}>
                      <div className={styles.templateNameRow}>
                        <h3 className={styles.templateName}>{template.name}</h3>
                        <span className={styles.templateBadge}>Template</span>
                      </div>
                      <p className={styles.templateModel}>{template.model}</p>
                    </div>
                  </div>
                  <p className={styles.templateDescription}>{template.description}</p>
                  <div className={styles.templateFooter}>
                    <div className={styles.templateSkills}>
                      {template.skills.slice(0, 3).map(skill => (
                        <span key={skill} className={styles.skillChip}>{skill}</span>
                      ))}
                      {template.skills.length > 3 && (
                        <span className={styles.skillChipMore}>+{template.skills.length - 3}</span>
                      )}
                    </div>
                    <button
                      className={styles.addBtn}
                      onClick={(e) => {
                        e.stopPropagation()
                        setCreateForm({
                          name: template.name,
                          description: template.description,
                          model: template.modelId,
                          systemPrompt: template.systemPrompt,
                          skills: template.skills
                        })
                        setShowCreateModal(true)
                      }}
                    >
                      Add
                    </button>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </div>

      </div>
      </PageTransition>
      {/* Create Agent Modal — OUTSIDE PageTransition (position:fixed breaks inside transform) */}
      <AnimatePresence>
          {showCreateModal && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className={styles.modalOverlay}
              onClick={() => setShowCreateModal(false)}
            >
              <motion.div
                initial={{ opacity: 0, scale: 0.9, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 20 }}
                onClick={(e) => e.stopPropagation()}
                className={`${styles.modalBox} ${m ? styles.modalBoxMobile : styles.modalBoxDesktop}`}
              >
                {/* Modal Header */}
                <div className={styles.modalHeader}>
                  <h2 className={styles.modalTitle}>Create Agent</h2>
                  <motion.button
                    whileHover={{ scale: 1.1 }}
                    whileTap={{ scale: 0.9 }}
                    onClick={() => setShowCreateModal(false)}
                    className={styles.modalCloseBtn}
                  >
                    <X size={16} className={styles.modalCloseIcon} />
                  </motion.button>
                </div>

                {/* Agent Templates */}
                <div className={styles.quickStartSection}>
                  <h3 className={styles.quickStartHeading}>Quick Start Templates</h3>
                  <div style={{ display: 'grid', gridTemplateColumns: m ? '1fr' : 'repeat(3, 1fr)', gap: 12 }}>
                    {templates.map((template) => (
                      <motion.div
                        key={template.name}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        onClick={() => applyTemplate(template)}
                        className={styles.quickStartCard}
                      >
                        <div className={styles.quickStartName}>{template.name}</div>
                        <div className={styles.quickStartModel}>
                          {template.model.includes('opus') ? 'Opus' : template.model.includes('sonnet') ? 'Sonnet' : 'Haiku'}
                        </div>
                      </motion.div>
                    ))}
                  </div>
                </div>

                {/* Form Fields */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: m ? 16 : 20 }}>
                  {/* Name */}
                  <div>
                    <label className={styles.formLabel}>Name *</label>
                    <input
                      type="text"
                      value={createForm.name}
                      onChange={(e) => setCreateForm(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="e.g. Research Bot, Code Reviewer"
                      className={styles.formInput}
                    />
                  </div>

                  {/* Description */}
                  <div>
                    <label className={styles.formLabel}>Description</label>
                    <textarea
                      value={createForm.description}
                      onChange={(e) => setCreateForm(prev => ({ ...prev, description: e.target.value }))}
                      placeholder="Brief description of what this agent does..."
                      rows={3}
                      className={`${styles.formTextarea} ${styles.formTextareaDescription}`}
                    />
                  </div>

                  {/* Model */}
                  <div>
                    <label className={styles.formLabel}>Model *</label>
                    <select
                      value={createForm.model}
                      onChange={(e) => setCreateForm(prev => ({ ...prev, model: e.target.value }))}
                      className={styles.formSelect}
                    >
                      {(modelsData || []).map((model) => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </select>
                  </div>

                  {/* System Prompt */}
                  <div>
                    <label className={styles.formLabel}>System Prompt</label>
                    <textarea
                      value={createForm.systemPrompt}
                      onChange={(e) => setCreateForm(prev => ({ ...prev, systemPrompt: e.target.value }))}
                      placeholder="You are a helpful assistant..."
                      rows={4}
                      className={`${styles.formTextarea} ${styles.formTextareaSystemPrompt}`}
                    />
                  </div>

                  {/* Skills */}
                  <div>
                    <label className={styles.formLabel}>Skills</label>
                    <div className={styles.skillsBox}>
                      {skillsData?.installed?.length ? (
                        <div className={styles.skillsGrid}>
                          {skillsData.installed.map((skill) => (
                            <label key={skill.name} className={styles.skillLabel}>
                              <input
                                type="checkbox"
                                checked={createForm.skills.includes(skill.name)}
                                onChange={() => handleSkillToggle(skill.name)}
                                className={styles.skillCheckbox}
                              />
                              {skill.name}
                            </label>
                          ))}
                        </div>
                      ) : (
                        <div className={styles.skillsEmpty}>No skills available</div>
                      )}
                    </div>
                  </div>
                </div>

                {/* Modal Actions */}
                <div className={styles.modalActions}>
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => setShowCreateModal(false)}
                    className={styles.cancelBtn}
                  >
                    Cancel
                  </motion.button>
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={handleCreateAgent}
                    disabled={!createForm.name.trim()}
                    className={styles.createAgentBtn}
                    style={{
                      background: createForm.name.trim() ? 'linear-gradient(135deg, #BF5AF2 0%, #9C3AE8 100%)' : 'rgba(255,255,255,0.12)',
                      cursor: createForm.name.trim() ? 'pointer' : 'not-allowed',
                      opacity: createForm.name.trim() ? 1 : 0.5,
                    }}
                  >
                    Create Agent
                  </motion.button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
    </>
  )
}
