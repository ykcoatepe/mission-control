import { useState } from 'react'
import { Settings2, Save, RefreshCw, Shield, Database, Globe, Download, Upload, Clock, Zap } from 'lucide-react'
import PageTransition from '../components/PageTransition'
import { useIsMobile } from '../lib/useIsMobile'
import GlassCard from '../components/GlassCard'
import StatusBadge from '../components/StatusBadge'
import { useApi } from '../lib/hooks'
import styles from './Settings.module.css'

interface OpenClawConfig {
  model?: string
  available_models?: string[]
  gateway_port?: number
  token?: string
  memory_path?: string
  skills_path?: string
  bedrock_region?: string
  system?: {
    mission_control_version?: string
    openclaw_version?: string | null
    node_version?: string
    platform?: string
    arch?: string
  }
}

export default function Settings() {
  const isMobile = useIsMobile()
  const { data: configData } = useApi<OpenClawConfig>('/api/settings')

  return (
    <PageTransition>
      <div className={`${styles.page} ${isMobile ? styles.pageMobile : ''}`} style={{ gap: isMobile ? 16 : 24 }}>
        {/* Header */}
        <div>
          <h1 className="text-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Settings2 size={22} style={{ color: '#007AFF' }} /> Settings
          </h1>
          <p className="text-body" style={{ marginTop: 4 }}>Gateway configuration, model routing & preferences</p>
        </div>

        <div className={`${styles.cardGrid} ${isMobile ? styles.cardGridMobile : styles.cardGridDesktop}`}>
          {/* Model Routing Card */}
          <ModelRoutingCard isMobile={isMobile} />

          {/* OpenClaw Configuration Card */}
          <GlassCard noPad>
            <div className={`${styles.cardPad} ${isMobile ? styles.cardPadMobile : styles.cardPadDesktop}`}>
              <div className={styles.cardHeader}>
                <div className={styles.cardIconPurple}>
                  <Shield size={18} style={{ color: '#BF5AF2' }} />
                </div>
                <h2 className={styles.cardTitle}>OpenClaw Configuration</h2>
              </div>

              <div className={styles.configRows}>
                {[
                  { label: 'Gateway Port', value: configData?.gateway_port || 18789 },
                  { label: 'Memory Path', value: configData?.memory_path || '/home/ubuntu/clawd/memory', mono: true },
                  { label: 'Skills Path', value: configData?.skills_path || '/home/ubuntu/clawd/skills', mono: true },
                  { label: 'AWS Region', value: configData?.bedrock_region || 'us-east-1', mono: true },
                ].map((item) => (
                  <div key={item.label} className={styles.configRow}>
                    <span className={styles.configRowLabel}>{item.label}</span>
                    <span className={item.mono ? styles.configRowValueMono : styles.configRowValue}>{String(item.value)}</span>
                  </div>
                ))}
                <div className={styles.configRowLast}>
                  <span className={styles.configRowLabel}>Status</span>
                  <StatusBadge status="active" label="Connected" />
                </div>
              </div>
            </div>
          </GlassCard>

          {/* Heartbeat Configuration Card */}
          <HeartbeatConfigCard isMobile={isMobile} />

          {/* System Information Card */}
          <GlassCard noPad>
            <div className={`${styles.cardPad} ${isMobile ? styles.cardPadMobile : styles.cardPadDesktop}`}>
              <div className={styles.cardHeader}>
                <div className={styles.cardIconOrange}>
                  <Database size={18} style={{ color: '#FF9500' }} />
                </div>
                <h2 className={styles.cardTitle}>System Information</h2>
              </div>

              <div className={styles.configRows}>
                {[
                  { label: 'Mission Control Version', value: configData?.system?.mission_control_version ? `v${configData.system.mission_control_version}` : '—' },
                  { label: 'OpenClaw Version', value: configData?.system?.openclaw_version || '—' },
                  { label: 'Node.js Version', value: configData?.system?.node_version || '—' },
                  { label: 'Platform', value: (configData?.system?.platform && configData?.system?.arch) ? `${configData.system.platform} ${configData.system.arch}` : '—' },
                ].map((item) => (
                  <div key={item.label} className={styles.configRow}>
                    <span className={styles.sysInfoLabel}>{item.label}</span>
                    <span className={styles.sysInfoValue}>{item.value}</span>
                  </div>
                ))}
              </div>
            </div>
          </GlassCard>

          {/* Export/Import Configuration Card */}
          <ExportImportCard isMobile={isMobile} />
        </div>
      </div>
    </PageTransition>
  )
}

interface ModelRoutingData {
  main?: string
  subagent?: string
  heartbeat?: string
}

function ModelRoutingCard({ isMobile }: { isMobile: boolean }) {
  const [routing, setRouting] = useState({ main: '', subagent: '', heartbeat: '' })
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')

  const { data: modelsData } = useApi<{ id: string; name: string; tags?: string[] }[]>('/api/models')
  const { data: routingData } = useApi<ModelRoutingData>('/api/settings/model-routing')

  // Sync routing form to server data using render-phase update (avoids setState-in-effect).
  const [lastRoutingData, setLastRoutingData] = useState<ModelRoutingData | null>(null)
  if (routingData && routingData !== lastRoutingData) {
    setLastRoutingData(routingData)
    setRouting({
      main: routingData.main || '',
      subagent: routingData.subagent || routingData.main || '',
      heartbeat: routingData.heartbeat || '',
    })
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveStatus('idle')

    try {
      const res = await fetch('/api/settings/model-routing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(routing)
      })

      if (res.ok) {
        setSaveStatus('success')
        setTimeout(() => setSaveStatus('idle'), 3000)
      } else {
        setSaveStatus('error')
        setTimeout(() => setSaveStatus('idle'), 3000)
      }
    } catch {
      setSaveStatus('error')
      setTimeout(() => setSaveStatus('idle'), 3000)
    } finally {
      setSaving(false)
    }
  }

  const MODEL_OPTIONS = [
    { value: '', label: 'Inherit from Main (no override)' },
    ...((modelsData || []).map((m) => ({
      value: m.id,
      label: m.name || m.id,
    }))),
  ]

  return (
    <GlassCard noPad>
      <div className={`${styles.cardPad} ${isMobile ? styles.cardPadMobile : styles.cardPadDesktop}`}>
        <div className={styles.cardHeader}>
          <div className={styles.cardIconOrange}>
            <Zap size={18} style={{ color: '#FF9500' }} />
          </div>
          <h2 className={styles.cardTitle}>Model Routing</h2>
        </div>

        <div className={styles.fieldGroup}>
          <div>
            <label className="text-label" style={{ display: 'block', marginBottom: 8 }}>Main Model</label>
            <select value={routing.main} onChange={(e) => setRouting({ ...routing, main: e.target.value })} className={styles.selectField}>
              {MODEL_OPTIONS.filter(m => m.value !== '').map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-label" style={{ display: 'block', marginBottom: 8 }}>Sub-agent Model</label>
            <select value={routing.subagent} onChange={(e) => setRouting({ ...routing, subagent: e.target.value })} className={styles.selectField}>
              {MODEL_OPTIONS.filter(m => m.value !== '').map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-label" style={{ display: 'block', marginBottom: 8 }}>Heartbeat Model</label>
            <select value={routing.heartbeat} onChange={(e) => setRouting({ ...routing, heartbeat: e.target.value })} className={styles.selectField}>
              {MODEL_OPTIONS.map(m => (
                <option key={m.value || 'inherit'} value={m.value}>{m.label}</option>
              ))}
            </select>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className={`${styles.saveBtn} ${saving ? styles.saveBtnOrangeSaving : styles.saveBtnOrange}`}
          >
            {saving ? (
              <>
                <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
                <span>Saving...</span>
              </>
            ) : (
              <>
                <Save size={16} />
                <span>Save Model Routing</span>
              </>
            )}
          </button>

          {saveStatus === 'success' && (
            <div className={styles.statusSuccess}>
              <span className="status-dot status-dot-green" />
              Model routing saved successfully
            </div>
          )}
          {saveStatus === 'error' && (
            <div className={styles.statusError}>
              <span className="status-dot status-dot-red" />
              Failed to save model routing
            </div>
          )}
        </div>
      </div>
    </GlassCard>
  )
}

function HeartbeatConfigCard({ isMobile }: { isMobile: boolean }) {
  const [interval, setInterval] = useState('1h')
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle')

  const intervalOptions = [
    { value: '30min', label: '30 minutes' },
    { value: '1h', label: '1 hour' },
    { value: '2h', label: '2 hours' },
    { value: '4h', label: '4 hours' },
    { value: 'off', label: 'Off' },
  ]

  const handleSave = async () => {
    setSaving(true)
    setSaveStatus('idle')

    try {
      const res = await fetch('/api/settings/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval })
      })

      if (res.ok) {
        setSaveStatus('success')
        setTimeout(() => setSaveStatus('idle'), 3000)
      } else {
        setSaveStatus('error')
        setTimeout(() => setSaveStatus('idle'), 3000)
      }
    } catch {
      setSaveStatus('error')
      setTimeout(() => setSaveStatus('idle'), 3000)
    } finally {
      setSaving(false)
    }
  }

  return (
    <GlassCard noPad>
      <div className={`${styles.cardPad} ${isMobile ? styles.cardPadMobile : styles.cardPadDesktop}`}>
        <div className={styles.cardHeader}>
          <div className={styles.cardIconRed}>
            <Clock size={18} style={{ color: '#FF453A' }} />
          </div>
          <h2 className={styles.cardTitle}>Heartbeat Interval</h2>
        </div>

        <div className={styles.fieldGroup}>
          <div>
            <label className="text-label" style={{ display: 'block', marginBottom: 8 }}>Check Interval</label>
            <select
              value={interval}
              onChange={(e) => setInterval(e.target.value)}
              className={styles.heartbeatSelect}
            >
              {intervalOptions.map(opt => (
                <option key={opt.value} value={opt.value} style={{ background: '#1a1a1a', color: '#fff' }}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <button
            onClick={handleSave}
            disabled={saving}
            className={`${styles.saveBtn} ${saving ? styles.saveBtnRedSaving : styles.saveBtnRed}`}
          >
            {saving ? (
              <>
                <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
                <span>Saving...</span>
              </>
            ) : (
              <>
                <Save size={16} />
                <span>Save Heartbeat Interval</span>
              </>
            )}
          </button>

          {saveStatus === 'success' && (
            <div className={styles.statusSuccess}>
              <span className="status-dot status-dot-green" />
              Heartbeat interval saved successfully
            </div>
          )}
          {saveStatus === 'error' && (
            <div className={styles.statusError}>
              <span className="status-dot status-dot-red" />
              Failed to save heartbeat interval
            </div>
          )}
        </div>
      </div>
    </GlassCard>
  )
}

function ExportImportCard({ isMobile }: { isMobile: boolean }) {
  const [importing, setImporting] = useState(false)
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle')

  const handleExport = () => {
    window.location.href = '/api/settings/export'
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    setImporting(true)
    setImportStatus('idle')

    try {
      const formData = new FormData()
      formData.append('config', file)

      const res = await fetch('/api/settings/import', {
        method: 'POST',
        body: formData
      })

      if (res.ok) {
        setImportStatus('success')
        setTimeout(() => setImportStatus('idle'), 3000)
      } else {
        setImportStatus('error')
        setTimeout(() => setImportStatus('idle'), 3000)
      }
    } catch {
      setImportStatus('error')
      setTimeout(() => setImportStatus('idle'), 3000)
    } finally {
      setImporting(false)
      e.target.value = ''
    }
  }

  return (
    <GlassCard noPad>
      <div className={`${styles.cardPad} ${isMobile ? styles.cardPadMobile : styles.cardPadDesktop}`}>
        <div className={styles.cardHeader}>
          <div className={styles.cardIconGreen}>
            <Globe size={18} style={{ color: '#32D74B' }} />
          </div>
          <h2 className={styles.cardTitle}>Export / Import</h2>
        </div>

        <div className={styles.exportImportGroup}>
          <button
            onClick={handleExport}
            className={styles.exportBtn}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(50,215,75,0.2)' }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(50,215,75,0.1)' }}
          >
            <Download size={16} />
            Export Configuration
          </button>

          <div className={styles.importWrap}>
            <input
              type="file"
              accept=".json"
              onChange={handleImport}
              disabled={importing}
              className={importing ? styles.importFileInputDisabled : styles.importFileInput}
            />
            <button
              disabled={importing}
              className={importing ? styles.importBtnDisabled : styles.importBtn}
              onMouseEnter={(e) => { if (!importing) e.currentTarget.style.background = 'rgba(0,122,255,0.2)' }}
              onMouseLeave={(e) => { if (!importing) e.currentTarget.style.background = 'rgba(0,122,255,0.1)' }}
            >
              {importing ? (
                <>
                  <RefreshCw size={16} style={{ animation: 'spin 1s linear infinite' }} />
                  <span>Importing...</span>
                </>
              ) : (
                <>
                  <Upload size={16} />
                  <span>Import Configuration</span>
                </>
              )}
            </button>
          </div>

          {importStatus === 'success' && (
            <div className={styles.statusSuccess}>
              <span className="status-dot status-dot-green" />
              Configuration imported successfully. Restart required.
            </div>
          )}
          {importStatus === 'error' && (
            <div className={styles.statusError}>
              <span className="status-dot status-dot-red" />
              Failed to import configuration
            </div>
          )}
        </div>
      </div>
    </GlassCard>
  )
}
