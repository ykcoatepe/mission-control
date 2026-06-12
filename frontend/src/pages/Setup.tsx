import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { CheckCircle, ArrowRight, ArrowLeft, Settings, Zap, Search } from 'lucide-react'
import PageTransition from '../components/PageTransition'
import { useIsMobile } from '../lib/useIsMobile'
import styles from './Setup.module.css'

interface SetupData {
  dashboardName: string
  gateway: {
    port: number
    token: string
  }
  modules: Record<string, boolean>
  scout: {
    enabled: boolean
    queries: Array<{ q: string; category: string; source: string; weight: number }>
    schedule: string
  }
}

interface SetupStatus {
  needsSetup: boolean
  gatewayRunning: boolean
  gatewayPort: number
  gatewayVersion: string
  detectedConfig: {
    model: string
    channels: string[]
    agentName: string
    workspacePath: string
    gatewayTokenConfigured?: boolean
  }
}

const scoutTemplates = {
  freelance: [
    { q: '"looking for" "web developer" OR "website developer" remote 2026', category: 'freelance', source: 'web', weight: 1.0 },
    { q: 'site:x.com "hiring" OR "looking for" "react developer" OR "frontend developer" remote', category: 'twitter-jobs', source: 'twitter', weight: 0.9 },
    { q: 'site:reddit.com/r/forhire "looking for" react developer', category: 'reddit-gigs', source: 'reddit', weight: 0.8 }
  ],
  skills: [
    { q: 'site:github.com openclaw skill OR plugin', category: 'openclaw-github', source: 'github', weight: 1.0 },
    { q: 'clawhub.com skill OR "new skill" OR automation', category: 'openclaw-skills', source: 'web', weight: 1.0 },
    { q: 'site:x.com openclaw "new feature" OR "just shipped" OR "tip"', category: 'openclaw', source: 'twitter', weight: 1.0 }
  ],
  bounties: [
    { q: '"bug bounty" OR "vulnerability disclosure" program 2026', category: 'security', source: 'web', weight: 0.9 },
    { q: 'site:hackerone.com new program OR "just launched"', category: 'hackerone', source: 'web', weight: 0.8 },
    { q: '"responsible disclosure" reward program', category: 'disclosure', source: 'web', weight: 0.7 }
  ],
  grants: [
    { q: '"startup grant" OR "startup competition" 2026 application deadline', category: 'funding', source: 'web', weight: 0.95 },
    { q: '"innovation grant" OR "tech grant" europe 2026 open', category: 'eu-grants', source: 'web', weight: 0.9 },
    { q: 'edtech funding OR "education startup grant" 2026', category: 'edtech-funding', source: 'web', weight: 0.85 }
  ]
}

export default function Setup() {
  const navigate = useNavigate()
  const isMobile = useIsMobile()
  const [step, setStep] = useState(1)
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [setupData, setSetupData] = useState<SetupData>({
    dashboardName: 'Mission Control',
    gateway: { port: 18789, token: '' },
    modules: {
      dashboard: true,
      chat: true,
      workshop: true,
      costs: true,
      cron: true,
      scout: false,
      docs: true,
      agents: true,
      settings: true,
      skills: true,
      aws: false
    },
    scout: {
      enabled: false,
      queries: [],
      schedule: 'daily'
    }
  })

  const [customQueries, setCustomQueries] = useState<string[]>([''])

  async function fetchSetupStatus() {
    try {
      const response = await fetch('/api/setup')
      const data = await response.json()
      setStatus(data)

      // Pre-populate form with detected values
      if (data.detectedConfig?.agentName) {
        setSetupData(prev => ({ ...prev, dashboardName: data.detectedConfig.agentName + ' Control' }))
      }
    } catch (error) {
      console.error('Failed to fetch setup status:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetchSetupStatus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const handleSaveSetup = async () => {
    try {
      setLoading(true)

      // Combine template queries with custom queries
      const allQueries = [...setupData.scout.queries]
      customQueries.forEach(q => {
        if (q.trim()) {
          allQueries.push({ q: q.trim(), category: 'custom', source: 'web', weight: 0.8 })
        }
      })

      const payload = {
        ...setupData,
        scout: {
          ...setupData.scout,
          queries: allQueries
        }
      }

      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (response.ok) {
        navigate('/')
      } else {
        console.error('Setup failed')
      }
    } catch (error) {
      console.error('Failed to save setup:', error)
    } finally {
      setLoading(false)
    }
  }

  const addScoutTemplate = (templateKey: keyof typeof scoutTemplates) => {
    const template = scoutTemplates[templateKey]
    setSetupData(prev => ({
      ...prev,
      scout: {
        ...prev.scout,
        enabled: true,
        queries: [...prev.scout.queries, ...template]
      }
    }))
  }

  const removeScoutTemplate = (templateKey: keyof typeof scoutTemplates) => {
    const template = scoutTemplates[templateKey]
    const templateCategories = template.map(t => t.category)
    setSetupData(prev => ({
      ...prev,
      scout: {
        ...prev.scout,
        queries: prev.scout.queries.filter(q => !templateCategories.includes(q.category))
      }
    }))
  }

  const isTemplateSelected = (templateKey: keyof typeof scoutTemplates) => {
    const template = scoutTemplates[templateKey]
    return template.every(t => setupData.scout.queries.some(q => q.category === t.category))
  }

  if (loading && !status) {
    return (
      <PageTransition>
        <div className={styles.loadingWrap}>
          Loading setup...
        </div>
      </PageTransition>
    )
  }

  return (
    <PageTransition>
      <div className={styles.page}>

        {/* Step 1: Welcome */}
        {step === 1 && (
          <div className={`${styles.card} ${isMobile ? styles.cardMobile : styles.cardDesktop}`}>
            <div className={styles.welcomeHeader}>
              <h1 className={`${styles.welcomeTitle} ${isMobile ? styles.welcomeTitleMobile : styles.welcomeTitleDesktop}`}>
                Welcome to Mission Control
              </h1>
              <p className={styles.welcomeSubtitle}>
                Your command center for OpenClaw AI agents. Let's get you set up in just a few steps.
              </p>
            </div>

            {/* Gateway Status */}
            <div className={styles.gatewayBox}>
              <div className={styles.gatewayRow}>
                {status?.gatewayRunning ? (
                  <CheckCircle size={24} style={{ color: '#32D74B' }} />
                ) : (
                  <div className={styles.gatewayOffIndicator}>
                    <div className={styles.gatewayOffDot} />
                  </div>
                )}
                <span className={styles.gatewayLabel}>
                  OpenClaw Gateway
                </span>
              </div>

              <div className={styles.gatewayStatus}>
                Status: {status?.gatewayRunning ? 'Running' : 'Not detected'}<br />
                {status?.gatewayVersion && `Version: ${status.gatewayVersion}`}<br />
                Port: {status?.gatewayPort || 18789}
              </div>
            </div>

            {/* Detected Config */}
            {status?.detectedConfig && (
              <div className={styles.detectedConfigBox}>
                <h3 className={styles.detectedConfigTitle}>
                  Detected Configuration
                </h3>
                <div className={styles.detectedConfigBody}>
                  {status.detectedConfig.model && <div>Model: {status.detectedConfig.model.replace('amazon-bedrock/', '')}</div>}
                  {status.detectedConfig.channels.length > 0 && <div>Channels: {status.detectedConfig.channels.join(', ')}</div>}
                  {status.detectedConfig.workspacePath && <div>Workspace: {status.detectedConfig.workspacePath}</div>}
                  {status.detectedConfig.gatewayTokenConfigured && <div>Gateway token: configured locally</div>}
                </div>
              </div>
            )}

            <div className={styles.welcomeActions}>
              <button
                className={styles.primaryBtn}
                onClick={() => setStep(2)}
              >
                Let's Get Started
                <ArrowRight size={20} />
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Configure */}
        {step === 2 && (
          <div className={`${styles.card} ${isMobile ? styles.cardMobile : styles.cardDesktop}`}>
            <h2 className={styles.stepTitle}>
              <Settings size={32} style={{ color: '#007AFF' }} />
              Configure Dashboard
            </h2>

            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>
                Dashboard Name
              </label>
              <input
                className={styles.input}
                type="text"
                value={setupData.dashboardName}
                onChange={(e) => setSetupData(prev => ({ ...prev, dashboardName: e.target.value }))}
                placeholder="Mission Control"
              />
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>
                Gateway Token
              </label>
              <input
                className={styles.input}
                type="text"
                value={setupData.gateway.token}
                onChange={(e) => setSetupData(prev => ({
                  ...prev,
                  gateway: { ...prev.gateway, token: e.target.value }
                }))}
                placeholder="Enter your gateway authentication token"
              />
              <p className={styles.fieldHint}>
                This connects Mission Control to your OpenClaw gateway for secure communication.
              </p>
            </div>

            <div className={styles.fieldGroupLast}>
              <label className={styles.fieldLabel}>
                Enable Modules
              </label>
              <div className={`${styles.modulesGrid} ${isMobile ? styles.modulesGridMobile : styles.modulesGridDesktop}`}>
                {Object.entries(setupData.modules).map(([key, enabled]) => (
                  <label key={key} className={enabled ? styles.moduleToggleActive : styles.moduleToggleInactive}>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(e) => setSetupData(prev => ({
                        ...prev,
                        modules: { ...prev.modules, [key]: e.target.checked }
                      }))}
                      className={styles.moduleCheckbox}
                    />
                    <span className={enabled ? styles.moduleLabelActive : styles.moduleLabelInactive}>
                      {key}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className={styles.navRow}>
              <button className={styles.secondaryBtn} onClick={() => setStep(1)}>
                <ArrowLeft size={20} />
                Back
              </button>
              <button className={styles.primaryBtn} onClick={() => setStep(3)}>
                Continue
                <ArrowRight size={20} />
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Scout Setup */}
        {step === 3 && (
          <div className={`${styles.card} ${isMobile ? styles.cardMobile : styles.cardDesktop}`}>
            <h2 className={styles.stepTitle}>
              <Search size={32} style={{ color: '#007AFF' }} />
              Scout Setup
            </h2>
            <p className={styles.scoutSectionDesc}>
              What opportunities do you want to find? Scout will search for relevant leads automatically.
            </p>

            <div className={styles.fieldGroup}>
              <h3 className={styles.scoutSectionTitle}>
                Quick Templates
              </h3>

              <div className={styles.templateList}>
                {Object.entries(scoutTemplates).map(([key, template]) => {
                  const selected = isTemplateSelected(key as keyof typeof scoutTemplates)
                  return (
                    <div key={key} className={selected ? styles.templateActive : styles.templateInactive}>
                      <div className={styles.templateRow}>
                        <div>
                          <h4 className={styles.templateTitle}>
                            {key} Opportunities
                          </h4>
                          <p className={styles.templateDesc}>
                            {template.length} search queries • {key === 'freelance' ? 'Find web development jobs' :
                             key === 'skills' ? 'Track OpenClaw ecosystem' :
                             key === 'bounties' ? 'Security bug bounty programs' :
                             'Startup grants and competitions'}
                          </p>
                        </div>
                        <button
                          className={selected ? styles.templateBtnActive : styles.templateBtnInactive}
                          onClick={() => {
                            if (selected) {
                              removeScoutTemplate(key as keyof typeof scoutTemplates)
                            } else {
                              addScoutTemplate(key as keyof typeof scoutTemplates)
                            }
                          }}
                        >
                          {selected ? 'Remove' : 'Add'}
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            <div className={styles.fieldGroupLast}>
              <h3 className={styles.scoutSectionTitle}>
                Custom Searches
              </h3>

              {customQueries.map((query, index) => (
                <div key={index} className={styles.customQueryRow}>
                  <input
                    className={`${styles.input} ${styles.customQueryInput}`}
                    type="text"
                    value={query}
                    onChange={(e) => {
                      const newQueries = [...customQueries]
                      newQueries[index] = e.target.value
                      setCustomQueries(newQueries)
                    }}
                    placeholder="Enter custom search query..."
                  />
                  {customQueries.length > 1 && (
                    <button
                      className={styles.removeQueryBtn}
                      onClick={() => {
                        const newQueries = customQueries.filter((_, i) => i !== index)
                        setCustomQueries(newQueries)
                      }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              ))}

              <button
                className={`${styles.secondaryBtn} ${styles.addQueryBtn}`}
                onClick={() => setCustomQueries([...customQueries, ''])}
              >
                Add Another Query
              </button>
            </div>

            <div className={styles.navRow}>
              <button className={styles.secondaryBtn} onClick={() => setStep(2)}>
                <ArrowLeft size={20} />
                Back
              </button>
              <button className={styles.primaryBtn} onClick={() => setStep(4)}>
                Continue
                <ArrowRight size={20} />
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Done */}
        {step === 4 && (
          <div className={`${styles.card} ${isMobile ? styles.cardMobile : styles.cardDesktop}`}>
            <div className={styles.doneHeader}>
              <CheckCircle size={64} style={{ color: '#32D74B', marginBottom: 16 }} />
              <h2 className={`${styles.stepTitle} ${styles.stepTitleCentered}`}>
                Setup Complete!
              </h2>
              <p className={styles.welcomeSubtitle}>
                Your Mission Control dashboard is ready to go.
              </p>
            </div>

            <div className={styles.doneSummaryBox}>
              <h3 className={styles.doneSummaryTitle}>
                Configuration Summary
              </h3>
              <div className={styles.doneSummaryBody}>
                <div>Dashboard Name: {setupData.dashboardName}</div>
                <div>Gateway Token: {setupData.gateway.token ? '●●●●●●●●' : 'Not set'}</div>
                <div>Modules Enabled: {Object.values(setupData.modules).filter(Boolean).length}</div>
                <div>Scout Queries: {setupData.scout.queries.length + customQueries.filter(q => q.trim()).length}</div>
              </div>
            </div>

            <div className={styles.doneActions}>
              <button
                className={styles.primaryBtn}
                onClick={handleSaveSetup}
                disabled={loading}
              >
                {loading ? 'Saving...' : 'Launch Dashboard'}
                {!loading && <Zap size={20} />}
              </button>
            </div>
          </div>
        )}

      </div>
    </PageTransition>
  )
}
