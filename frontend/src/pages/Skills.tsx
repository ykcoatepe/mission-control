import { useState } from 'react'
import { motion } from 'framer-motion'
import { Puzzle, Download, Trash2, ToggleLeft, ToggleRight, Package, FolderOpen, Code } from 'lucide-react'
import PageTransition from '../components/PageTransition'
import { useIsMobile } from '../lib/useIsMobile'
import GlassCard from '../components/GlassCard'
import StatusBadge from '../components/StatusBadge'
import { useApi } from '../lib/hooks'
import styles from './Skills.module.css'

interface Skill {
  name: string
  description: string
  version?: string
  author?: string
  status: 'active' | 'inactive' | 'available'
  installed: boolean
  path?: string
  type?: 'workspace' | 'system' | 'custom'
}

export default function Skills() {
  const isMobile = useIsMobile()
  const { data: skillsData, loading, error, refetch } = useApi<{ installed: Skill[], available: Skill[] }>('/api/skills')
  const [filter, setFilter] = useState<'all' | 'installed' | 'available'>('all')
  const [toggling, setToggling] = useState<string | null>(null)

  const handleToggleSkill = async (skillName: string) => {
    setToggling(skillName)
    try {
      const skill = [...(skillsData?.installed || []), ...(skillsData?.available || [])].find(s => s.name === skillName)
      const newEnabled = skill?.status !== 'active'

      const response = await fetch(`/api/skills/${skillName}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: newEnabled })
      })
      if (response.ok) refetch()
    } catch (error) {
      console.error('Failed to toggle skill:', error)
    } finally {
      setToggling(null)
    }
  }

  const handleInstallSkill = async (skillName: string) => {
    setToggling(skillName)
    try {
      const response = await fetch(`/api/skills/${skillName}/install`, { method: 'POST' })
      if (response.ok) refetch()
    } catch (error) {
      console.error('Failed to install skill:', error)
    } finally {
      setToggling(null)
    }
  }

  const handleUninstallSkill = async (skillName: string) => {
    if (!confirm(`Are you sure you want to uninstall ${skillName}?`)) return
    setToggling(skillName)
    try {
      const response = await fetch(`/api/skills/${skillName}/uninstall`, { method: 'POST' })
      if (response.ok) refetch()
    } catch (error) {
      console.error('Failed to uninstall skill:', error)
    } finally {
      setToggling(null)
    }
  }

  const getFilteredSkills = () => {
    if (!skillsData) return []
    if (filter === 'installed') return skillsData.installed || []
    if (filter === 'available') return skillsData.available || []
    return [...(skillsData.installed || []), ...(skillsData.available || [])]
  }

  const getTypeIcon = (type?: string) => {
    switch (type) {
      case 'system': return <Package size={16} style={{ color: '#007AFF' }} />
      case 'workspace': return <FolderOpen size={16} style={{ color: '#32D74B' }} />
      default: return <Code size={16} style={{ color: '#BF5AF2' }} />
    }
  }

  const filteredSkills = getFilteredSkills()

  return (
    <PageTransition>
      <div className={`${styles.page} ${isMobile ? styles.pageMobile : styles.pageDesktop}`}>
        {/* Header */}
        <div>
          <h1 className="text-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Puzzle size={22} className={styles.headerIcon} /> Skills Manager
          </h1>
          <p className="text-body" style={{ marginTop: 4 }}>Installed skills that extend your agent's capabilities</p>
        </div>

        {/* Stats Cards */}
        <div className={`${styles.statsGrid} ${isMobile ? styles.statsGridMobile : styles.statsGridDesktop}`}>
          {[
            { label: 'Installed', value: skillsData?.installed?.length || 0, color: '#007AFF' },
            { label: 'Active', value: skillsData?.installed?.filter(s => s.status === 'active').length || 0, color: '#32D74B' },
            { label: 'Available', value: skillsData?.available?.length || 0, color: '#BF5AF2' },
            { label: 'System', value: skillsData?.installed?.filter(s => s.type === 'system').length || 0, color: '#FF9500' },
          ].map((s, i) => (
            <GlassCard key={s.label} delay={0.05 + i * 0.03} noPad>
              <div className={styles.statPad}>
                <p className={`text-label ${styles.statLabel}`}>{s.label}</p>
                <p className={styles.statValue} style={{ color: s.color }}>{s.value}</p>
              </div>
            </GlassCard>
          ))}
        </div>

        {/* Filter Tabs */}
        <div className={styles.filterRow}>
          {(['all', 'installed', 'available'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              className={filter === tab ? styles.filterBtnActive : styles.filterBtnInactive}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>

        {/* Skills Grid */}
        <div className={styles.skillsGrid}>
          {loading ? (
            <GlassCard noPad>
              <div className={`${styles.statePad} ${isMobile ? styles.statePadMobile : styles.statePadDesktop}`}>
                Loading skills...
              </div>
            </GlassCard>
          ) : error ? (
            <GlassCard noPad>
              <div className={`${styles.errorPad} ${isMobile ? styles.errorPadMobile : styles.errorPadDesktop}`}>
                Skills API error: {error}
                <br />
                <button onClick={() => refetch()} className={styles.retryBtn}>
                  Retry
                </button>
              </div>
            </GlassCard>
          ) : filteredSkills.length === 0 ? (
            <GlassCard noPad>
              <div className={`${styles.statePad} ${isMobile ? styles.statePadMobile : styles.statePadDesktop}`}>
                No skills found
              </div>
            </GlassCard>
          ) : (
            filteredSkills.map((skill) => (
              <motion.div
                key={skill.name}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                whileHover={{ scale: 1.01, translateY: -2 }}
                transition={{ duration: 0.2 }}
              >
                <GlassCard noPad>
                  <div className={`${styles.skillCardPad} ${isMobile ? styles.skillCardPadMobile : styles.skillCardPadDesktop}`}>
                    <div className={styles.skillCardHeader}>
                      <div className={styles.skillCardTitleGroup}>
                        <div className={styles.skillCardIconWrap}>{getTypeIcon(skill.type)}</div>
                        <div className={styles.skillCardInfo}>
                          <h3 className={styles.skillCardName}>{skill.name}</h3>
                          <p className={styles.skillCardDesc}>
                            {skill.description || 'No description available'}
                          </p>
                          {skill.version && (
                            <div className={styles.skillCardVersion}>
                              v{skill.version} {skill.author && `• by ${skill.author}`}
                            </div>
                          )}
                        </div>
                      </div>
                      <StatusBadge
                        status={skill.status === 'active' ? 'active' : skill.status === 'inactive' ? 'idle' : 'off'}
                        label={skill.status}
                      />
                    </div>

                    <div className={styles.skillActions}>
                      {skill.installed ? (
                        <>
                          <button
                            onClick={() => handleToggleSkill(skill.name)}
                            disabled={toggling === skill.name}
                            className={`${skill.status === 'active' ? styles.toggleBtnActive : styles.toggleBtnInactive} ${toggling === skill.name ? styles.toggleBtnDisabled : ''}`}
                          >
                            {skill.status === 'active' ? (
                              <><ToggleRight size={16} style={{ color: '#32D74B' }} /><span>Enabled</span></>
                            ) : (
                              <><ToggleLeft size={16} style={{ color: '#8E8E93' }} /><span>Disabled</span></>
                            )}
                          </button>
                          <button
                            onClick={() => handleUninstallSkill(skill.name)}
                            disabled={toggling === skill.name}
                            className={`${styles.uninstallBtn} ${toggling === skill.name ? styles.toggleBtnDisabled : ''}`}
                            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,69,58,0.15)' }}
                            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)' }}
                          >
                            <Trash2 size={16} style={{ color: '#FF453A' }} />
                            <span>Uninstall</span>
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => handleInstallSkill(skill.name)}
                          disabled={toggling === skill.name}
                          className={styles.installBtn}
                          style={{ opacity: toggling === skill.name ? 0.5 : 1 }}
                        >
                          <Download size={16} />
                          <span>Install</span>
                        </button>
                      )}
                    </div>

                    {skill.path && (
                      <div className={styles.skillPath}>
                        <div className={styles.skillPathText}>
                          {skill.path}
                        </div>
                      </div>
                    )}
                  </div>
                </GlassCard>
              </motion.div>
            ))
          )}
        </div>
      </div>
    </PageTransition>
  )
}
