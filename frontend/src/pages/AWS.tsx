import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Cloud, Play, CheckCircle, AlertCircle, X, MessageSquare, Image, Music, Video, Box, Brain, Search, type LucideIcon } from 'lucide-react'
import PageTransition from '../components/PageTransition'
import { useIsMobile } from '../lib/useIsMobile'
import GlassCard from '../components/GlassCard'
import { useApi } from '../lib/hooks'
import styles from './AWS.module.css'

interface AWSService {
  name: string
  status: 'active' | 'available'
  description: string
  detail: string
}

interface BedrockModel {
  modelId: string
  modelName: string
  provider: string
  inputModalities?: string[]
  outputModalities?: string[]
  status: string
}

interface AWSData {
  account: { id: string; region: string; user?: string }
  services: AWSService[]
  credits: { total: number; note: string }
}

type ModelCategory = 'all' | 'text' | 'image-gen' | 'vision' | 'video' | 'embedding' | 'speech'

interface ConfigData {
  modules?: Record<string, boolean>
  aws?: { enabled?: boolean; region?: string }
}

interface AWSCostData {
  total?: number
  remaining?: number
  services?: { name: string; cost: number }[]
  daily?: { date: string; cost: number }[]
}

const CATEGORY_FILTERS: { id: ModelCategory; label: string; icon: LucideIcon; match: (m: BedrockModel) => boolean }[] = [
  { id: 'all', label: 'All', icon: Box, match: () => true },
  { id: 'text', label: 'Text / Chat', icon: MessageSquare, match: (m) => {
    const out = m.outputModalities || []
    return out.includes('TEXT') && !out.includes('IMAGE') && !out.includes('VIDEO') && !out.includes('EMBEDDING')
  }},
  { id: 'vision', label: 'Vision', icon: Brain, match: (m) => {
    const inp = m.inputModalities || []; const out = m.outputModalities || []
    return inp.includes('IMAGE') && out.includes('TEXT') && !out.includes('IMAGE')
  }},
  { id: 'image-gen', label: 'Image Gen', icon: Image, match: (m) => (m.outputModalities || []).includes('IMAGE') },
  { id: 'video', label: 'Video', icon: Video, match: (m) => (m.outputModalities || []).includes('VIDEO') },
  { id: 'embedding', label: 'Embedding', icon: Box, match: (m) => (m.outputModalities || []).includes('EMBEDDING') },
  { id: 'speech', label: 'Speech', icon: Music, match: (m) => {
    const out = m.outputModalities || []
    return out.includes('SPEECH') || (m.inputModalities || []).includes('SPEECH')
  }},
]

function getModelAction(m: BedrockModel): { label: string; type: 'agent' | 'image' | 'tts' | 'none'; color: string } {
  const out = m.outputModalities || []
  const inp = m.inputModalities || []
  // Only Amazon models (Nova Canvas, Titan Image Gen) support text-to-image via our API
  if (out.includes('IMAGE') && (m.modelId.startsWith('amazon.nova-canvas') || m.modelId.startsWith('amazon.titan-image'))) {
    return { label: 'Generate Image', type: 'image', color: '#BF5AF2' }
  }
  if (out.includes('IMAGE')) return { label: 'Image Tool', type: 'none', color: '#BF5AF2' } // Stability needs input image
  if (out.includes('VIDEO')) return { label: 'Video Gen', type: 'none', color: '#FF9500' }
  if (out.includes('SPEECH')) return { label: 'Text to Speech', type: 'tts', color: '#32D74B' }
  if (out.includes('EMBEDDING')) return { label: 'Embedding', type: 'none', color: '#8E8E93' }
  if (out.includes('TEXT') && inp.includes('TEXT')) return { label: 'Use as Agent', type: 'agent', color: '#007AFF' }
  return { label: 'View', type: 'none', color: '#8E8E93' }
}

export default function AWS() {
  const isMobile = useIsMobile()
  const { data: configData } = useApi<ConfigData>('/api/config', 0)
  const { data: awsData, loading: awsLoading } = useApi<AWSData>('/api/aws/services', 60000)
  const { data: modelsData, loading: modelsLoading } = useApi<BedrockModel[]>('/api/aws/bedrock-models', 120000)
  const { data: costData } = useApi<AWSCostData>('/api/aws/costs', 60000)
  const [category, setCategory] = useState<ModelCategory>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedModel, setSelectedModel] = useState<BedrockModel | null>(null)
  const [actionStatus, setActionStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle')
  const [actionMessage, setActionMessage] = useState('')
  const [imagePrompt, setImagePrompt] = useState('')
  const [generatedImageUrl, setGeneratedImageUrl] = useState('')
  const [ttsText, setTtsText] = useState('')
  const [testingService, setTestingService] = useState<string | null>(null)
  const { data: galleryData } = useApi<{ images: { id: string; url: string; created: string; size: number }[] }>('/api/aws/gallery', 10000)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, string>>({})
  const awsEnabled = configData?.modules?.aws === true && configData?.aws?.enabled === true

  if (awsLoading) {
    return (
      <PageTransition>
        <div className={styles.loadingWrap}>
          <div className={styles.spinner} />
        </div>
      </PageTransition>
    )
  }

  if (!awsEnabled) {
    return (
      <PageTransition>
        <div className={`${styles.disabledPage} ${isMobile ? styles.disabledPageMobile : styles.disabledPageDesktop}`}>
          <div>
            <h1 className="text-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Cloud size={22} className={styles.disabledIconColor} /> AWS Dashboard
            </h1>
            <p className="text-body" style={{ marginTop: 4 }}>
              AWS module is currently disabled in Mission Control configuration.
            </p>
          </div>

          <GlassCard delay={0.05} noPad>
            <div className={`${styles.disabledCardPad} ${isMobile ? styles.disabledCardPadMobile : styles.disabledCardPadDesktop}`}>
              <div className={styles.disabledIconRow}>
                <div className={styles.disabledIcon}>
                  <Cloud size={20} className={styles.disabledIconColor} />
                </div>
                <div>
                  <div className={styles.disabledTitle}>Module disabled</div>
                  <div className={styles.disabledDesc}>No AWS calls are being made. Enable the module from settings/config before using Bedrock, billing, or gallery tools.</div>
                </div>
              </div>

              <div className={`${styles.configGrid} ${isMobile ? styles.configGridMobile : styles.configGridDesktop}`}>
                {[
                  { label: 'Module flag', value: String(configData?.modules?.aws ?? false) },
                  { label: 'AWS enabled', value: String(configData?.aws?.enabled ?? false) },
                  { label: 'Region', value: configData?.aws?.region || 'us-east-1' },
                ].map((item) => (
                  <div key={item.label} className={styles.configItem}>
                    <div className={styles.configItemLabel}>{item.label}</div>
                    <div className={styles.configItemValue}>{item.value}</div>
                  </div>
                ))}
              </div>
            </div>
          </GlassCard>
        </div>
      </PageTransition>
    )
  }

  const account = awsData?.account || { id: '...', region: '...' }
  const dailyCosts = costData?.daily ?? []
  const services = awsData?.services || []
  const credits = awsData?.credits || { total: 0, note: '' }
  const allModels = modelsData || []

  const activeFilter = CATEGORY_FILTERS.find(f => f.id === category)!
  let models = category === 'all' ? allModels : allModels.filter(activeFilter.match)
  if (searchQuery.trim()) {
    const q = searchQuery.toLowerCase()
    models = models.filter(m => m.modelName.toLowerCase().includes(q) || m.modelId.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q))
  }

  // Counts per category
  const counts: Record<string, number> = {}
  for (const f of CATEGORY_FILTERS) counts[f.id] = f.id === 'all' ? allModels.length : allModels.filter(f.match).length

  // Group by provider
  const providerGroups: Record<string, BedrockModel[]> = {}
  for (const m of models) { const p = m.provider || 'Unknown'; if (!providerGroups[p]) providerGroups[p] = []; providerGroups[p].push(m) }
  const sortedProviders = Object.entries(providerGroups).sort((a, b) => b[1].length - a[1].length)

  const handleSetAgentModel = async (modelId: string) => {
    setActionStatus('loading')
    try {
      const res = await fetch('/api/model', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: `amazon-bedrock/${modelId}` }),
      })
      if (res.ok) {
        setActionStatus('success')
        setActionMessage(`Agent model switched to ${modelId}`)
      } else {
        const data = await res.json().catch(() => ({}))
        setActionStatus('error')
        setActionMessage(data.error || 'Failed to switch model')
      }
    } catch (e) {
      setActionStatus('error')
      setActionMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const handleGenerateImage = async (modelId: string, prompt: string) => {
    if (!prompt.trim()) return
    setActionStatus('loading')
    setGeneratedImageUrl('')
    setActionMessage('Generating... this takes 10-30 seconds')
    try {
      const res = await fetch('/api/aws/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId, prompt }),
      })
      const data = await res.json()
      if (res.ok && data.imageUrl) {
        setActionStatus('success')
        setActionMessage(data.message)
        setGeneratedImageUrl(data.imageUrl)
      } else {
        setActionStatus('error')
        setActionMessage(data.error || 'Image generation failed')
      }
    } catch (e) {
      setActionStatus('error')
      setActionMessage(e instanceof Error ? e.message : String(e))
    }
  }

  const handleTestService = async (name: string) => {
    setTestingService(name)
    try {
      const res = await fetch('/api/aws/services')
      setTestResults(prev => ({ ...prev, [name]: res.ok ? 'success' : 'error' }))
    } catch { setTestResults(prev => ({ ...prev, [name]: 'error' })) }
    setTestingService(null)
    setTimeout(() => setTestResults(prev => { const rest = { ...prev }; delete rest[name]; return rest }), 3000)
  }

  return (
    <>
    <PageTransition>
      <div className={`${styles.page} ${isMobile ? styles.pageMobile : styles.pageDesktop}`}>
        {/* Header */}
        <div>
          <h1 className="text-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Cloud size={22} style={{ color: '#FF9500' }} /> AWS Dashboard
          </h1>
          <p className="text-body" style={{ marginTop: 4 }}>
            Account {account.id} · {account.region}{account.user ? ` · ${account.user}` : ''}
          </p>
        </div>

        {/* Stats Row */}
        <div className={`${styles.statsGrid} ${isMobile ? styles.statsGridMobile : styles.statsGridDesktop}`}>
          {[
            { label: 'Account ID', value: account.id, color: '#fff' },
            { label: 'Region', value: account.region, color: '#007AFF' },
            { label: 'Credits', value: `$${credits.total.toLocaleString()}`, color: '#32D74B' },
            { label: 'Bedrock Models', value: allModels.length, color: '#BF5AF2' },
          ].map((s, i) => (
            <GlassCard key={s.label} delay={0.05 + i * 0.03} noPad>
              <div className={styles.statPad}>
                <p className={`text-label ${styles.statLabel}`}>{s.label}</p>
                <p className={styles.statValue} style={{ color: s.color }}>{s.value}</p>
                {s.label === 'Credits' && <p className={styles.statNote}>{credits.note}</p>}
              </div>
            </GlassCard>
          ))}
        </div>

        <div className={`${styles.splitGrid} ${isMobile ? styles.splitGridMobile : styles.splitGridDesktop}`}>
          {/* Services */}
          <GlassCard delay={0.15} noPad>
            <div className={styles.sectionPad}>
              <h2 className={styles.sectionTitle}>Services</h2>
              <div className={styles.serviceList}>
                {services.map((svc) => (
                  <motion.div key={svc.name} whileHover={{ scale: 1.01 }} className={styles.serviceRow}>
                    <div className={styles.serviceInfo}>
                      <div className={styles.serviceName}>{svc.name}</div>
                      <div className={styles.serviceDesc}>{svc.description}</div>
                    </div>
                    <div className={styles.serviceActions}>
                      <span className={styles.serviceDetail}>{svc.detail}</span>
                      <span className={svc.status === 'active' ? styles.serviceBadgeActive : styles.serviceBadgeAvailable}>
                        {svc.status}
                      </span>
                      <button onClick={() => handleTestService(svc.name)} disabled={testingService === svc.name}
                        className={styles.serviceTestBtn}>
                        {testResults[svc.name] === 'success' ? <CheckCircle size={12} color="#32D74B" /> :
                         testResults[svc.name] === 'error' ? <AlertCircle size={12} color="#FF453A" /> : <Play size={12} />}
                      </button>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          </GlassCard>

          {/* Billing — REAL from Cost Explorer */}
          <GlassCard delay={0.2} noPad>
            <div className={styles.sectionPad}>
              <h2 className={styles.sectionTitle}>Billing &amp; Credits</h2>
              <div className={styles.billingGrid}>
                {/* Credits + Spending */}
                <div className={`${styles.billingMiniGrid} ${isMobile ? styles.billingMiniGridMobile : styles.billingMiniGridDesktop}`}>
                  <div className={styles.creditsBox}>
                    <p className={styles.billingBoxLabel}>Credits Left</p>
                    <p className={`${styles.creditsValue} ${isMobile ? styles.billingValueMobile : styles.billingValueDesktop}`}>
                      ${costData ? costData.remaining?.toLocaleString() : '25,000'}
                    </p>
                  </div>
                  <div className={styles.spendBox}>
                    <p className={styles.billingBoxLabel}>This Month</p>
                    <p className={`${styles.spendValue} ${isMobile ? styles.billingValueMobile : styles.billingValueDesktop}`}>
                      ${costData ? costData.total?.toFixed(2) : '0.00'}
                    </p>
                  </div>
                </div>

                {/* Service Breakdown */}
                <div className={styles.serviceBreakdown}>
                  <p className={styles.serviceBreakdownLabel}>By Service</p>
                  {(costData?.services || []).map((svc) => (
                    <div key={svc.name} className={styles.serviceBreakdownRow}>
                      <span className={styles.serviceBreakdownName}>{svc.name}</span>
                      <span style={{
                        fontSize: 12,
                        color: svc.cost > 10 ? '#FF9500' : 'rgba(255,255,255,0.7)',
                        fontWeight: svc.cost > 10 ? 600 : 400,
                        fontVariantNumeric: 'tabular-nums',
                        flexShrink: 0,
                      }}>${svc.cost.toFixed(2)}</span>
                    </div>
                  ))}
                  {(!costData?.services || costData.services.length === 0) && (
                    <p className={styles.serviceBreakdownEmpty}>No cost data yet</p>
                  )}
                </div>

                {/* Daily Spend Mini Chart */}
                {dailyCosts.length > 1 && (
                  <div className={styles.dailyChart}>
                    <p className={styles.dailyChartLabel}>Daily Spend</p>
                    <div className={styles.dailyBars}>
                      {dailyCosts.map((d, i) => {
                        const maxCost = Math.max(...dailyCosts.map((x) => x.cost), 1)
                        const height = Math.max((d.cost / maxCost) * 100, 2)
                        const isToday = i === dailyCosts.length - 1
                        return (
                          <div key={d.date} title={`${d.date}: $${d.cost}`} style={{
                            flex: 1, height: `${height}%`, borderRadius: 3,
                            background: d.cost > 50 ? '#FF453A' : d.cost > 10 ? '#FF9500' : '#007AFF',
                            opacity: isToday ? 1 : 0.7,
                            minHeight: 2,
                          }} />
                        )
                      })}
                    </div>
                    <div className={styles.dailyDateRow}>
                      <span className={styles.dailyDateLabel}>{dailyCosts[0]?.date?.slice(5)}</span>
                      <span className={styles.dailyDateLabel}>{dailyCosts[dailyCosts.length-1]?.date?.slice(5)}</span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </GlassCard>
        </div>

        {/* Image Gallery */}
        {galleryData && galleryData.images.length > 0 && (
          <GlassCard delay={0.22} noPad>
            <div className={styles.sectionPad}>
              <div className={styles.galleryHeader}>
                <h2 className={styles.sectionTitleWithIcon}>
                  <Image size={16} className={styles.galleryIcon} /> Generated Images ({galleryData.images.length})
                </h2>
              </div>
              <div className={styles.galleryGrid}>
                {galleryData.images.map((img) => (
                  <motion.div
                    key={img.id}
                    whileHover={{ scale: 1.03 }}
                    className={styles.galleryThumb}
                    onClick={() => setLightboxUrl(img.url)}
                  >
                    <img src={img.url} alt="" className={styles.galleryThumbImg} />
                    <div className={styles.galleryThumbCaption}>
                      <p className={styles.galleryThumbDate}>
                        {new Date(img.created).toLocaleString()}
                      </p>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          </GlassCard>
        )}

        {/* Bedrock Models Section */}
        <GlassCard delay={0.25} noPad>
          <div className={styles.sectionPad}>
            {/* Models Header + Search */}
            <div className={styles.modelsHeader}>
              <h2 className={styles.modelsTitle}>
                Bedrock Models ({models.length}{category !== 'all' ? ` / ${allModels.length}` : ''})
              </h2>
              <div className={styles.searchWrap}>
                <Search size={13} className={styles.searchIcon} />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search models..."
                  aria-label="Search Bedrock models"
                  className={styles.searchInput}
                />
              </div>
            </div>

            {/* Category Filter Tabs */}
            <div className={styles.filterRow}>
              {CATEGORY_FILTERS.filter(f => counts[f.id] > 0 || f.id === 'all').map(f => (
                <button key={f.id} onClick={() => setCategory(f.id)}
                  className={category === f.id ? styles.filterBtnActive : styles.filterBtnInactive}
                >
                  <f.icon size={13} />
                  {f.label}
                  <span className={category === f.id ? styles.filterBadgeActive : styles.filterBadgeInactive}>
                    {counts[f.id]}
                  </span>
                </button>
              ))}
            </div>

            {/* Model Grid */}
            {modelsLoading ? (
              <p className={styles.modelsLoading}>Loading models from Bedrock...</p>
            ) : models.length === 0 ? (
              <p className={styles.modelsEmpty}>No models match your search.</p>
            ) : (
              <div className={styles.modelsList}>
                {sortedProviders.map(([provider, provModels]) => (
                  <div key={provider}>
                    <div className={styles.providerHeader}>
                      <span className={styles.providerName}>{provider}</span>
                      <span className={styles.providerCount}>{provModels.length}</span>
                    </div>
                    <div className={styles.modelGrid}>
                      {provModels.map((m) => {
                        const action = getModelAction(m)
                        return (
                          <motion.div key={m.modelId} whileHover={{ scale: 1.02 }}
                            onClick={() => { setSelectedModel(m); setActionStatus('idle'); setActionMessage(''); setImagePrompt(''); setGeneratedImageUrl(''); setTtsText('') }}
                            className={styles.modelCard}
                            onMouseEnter={(e) => (e.currentTarget.style.borderColor = `${action.color}40`)}
                            onMouseLeave={(e) => (e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)')}
                          >
                            <div className={styles.modelCardInner}>
                              <div className={styles.modelCardInfo}>
                                <div className={styles.modelCardName}>
                                  {m.modelName}
                                </div>
                                <div className={styles.modelCardId}>
                                  {m.modelId}
                                </div>
                              </div>
                              <span className={styles.modelActionBadge} style={{
                                background: `${action.color}15`,
                                color: action.color,
                                border: `1px solid ${action.color}30`,
                              }}>{action.label}</span>
                            </div>
                          </motion.div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </GlassCard>

        {/* Model Action Modal */}
        <AnimatePresence>
          {selectedModel && (() => {
            const action = getModelAction(selectedModel)
            return (
              <motion.div
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                onClick={() => setSelectedModel(null)}
                className={styles.modalOverlay}
              >
                <motion.div
                  initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.95, opacity: 0 }}
                  onClick={(e) => e.stopPropagation()}
                  className={styles.modalBox}
                >
                  {/* Modal Header */}
                  <div className={styles.modalHeader}>
                    <div>
                      <h3 className={styles.modalModelName}>{selectedModel.modelName}</h3>
                      <p className={styles.modalModelMeta}>{selectedModel.provider} · {selectedModel.modelId}</p>
                    </div>
                    <button onClick={() => setSelectedModel(null)} className={styles.modalCloseBtn}>
                      <X size={18} />
                    </button>
                  </div>

                  {/* Modalities */}
                  <div className={styles.modalModalities}>
                    <div>
                      <p className={styles.modalModalityLabel}>Input</p>
                      <div className={styles.modalModalityBadges}>
                        {(selectedModel.inputModalities || []).map(m => (
                          <span key={m} className={styles.modalInputBadge}>{m}</span>
                        ))}
                      </div>
                    </div>
                    <div>
                      <p className={styles.modalModalityLabel}>Output</p>
                      <div className={styles.modalModalityBadges}>
                        {(selectedModel.outputModalities || []).map(m => (
                          <span key={m} className={styles.modalOutputBadge}>{m}</span>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Action Area */}
                  <div className={styles.modalActionArea}>
                    {action.type === 'agent' && (
                      <div>
                        <p className={styles.modalActionDesc}>
                          Switch active model to this. Takes effect on next message.
                        </p>
                        <button
                          onClick={() => handleSetAgentModel(selectedModel.modelId)}
                          disabled={actionStatus === 'loading'}
                          style={{
                            width: '100%', padding: '12px 16px', borderRadius: 10, border: 'none', cursor: 'pointer',
                            background: actionStatus === 'success' ? 'rgba(50,215,75,0.2)' : 'rgba(0,122,255,0.8)',
                            color: '#fff', fontSize: 13, fontWeight: 500,
                            opacity: actionStatus === 'loading' ? 0.6 : 1,
                          }}
                        >
                          {actionStatus === 'loading' ? 'Switching...' : actionStatus === 'success' ? '✓ Model Switched!' : `Set as Agent Model`}
                        </button>
                      </div>
                    )}

                    {action.type === 'image' && (
                      <div>
                        <p className={styles.modalActionDesc}>
                          Generate an image using {selectedModel.modelName}.
                        </p>
                        <input
                          value={imagePrompt}
                          onChange={(e) => setImagePrompt(e.target.value)}
                          placeholder="Describe the image you want..."
                          className={styles.modalActionInput}
                          onKeyDown={(e) => e.key === 'Enter' && handleGenerateImage(selectedModel.modelId, imagePrompt)}
                        />
                        <button
                          onClick={() => handleGenerateImage(selectedModel.modelId, imagePrompt)}
                          disabled={actionStatus === 'loading' || !imagePrompt.trim()}
                          style={{
                            width: '100%', padding: '12px 16px', borderRadius: 10, border: 'none', cursor: 'pointer',
                            background: !imagePrompt.trim() ? 'rgba(255,255,255,0.1)' : actionStatus === 'loading' ? 'rgba(191,90,242,0.4)' : 'rgba(191,90,242,0.8)',
                            color: '#fff', fontSize: 13, fontWeight: 500,
                            opacity: actionStatus === 'loading' ? 0.7 : 1,
                          }}
                        >
                          {actionStatus === 'loading' ? '⏳ Generating...' : 'Generate Image'}
                        </button>
                        {generatedImageUrl && (
                          <div className={styles.modalGeneratedImg}>
                            <img src={generatedImageUrl} alt="Generated" className={styles.modalGeneratedImgEl} />
                          </div>
                        )}
                      </div>
                    )}

                    {action.type === 'tts' && (
                      <div>
                        <p className={styles.modalActionDesc}>
                          Convert text to speech using {selectedModel.modelName}.
                        </p>
                        <textarea
                          value={ttsText}
                          onChange={(e) => setTtsText(e.target.value)}
                          placeholder="Enter text to speak..."
                          rows={3}
                          className={styles.modalActionTextarea}
                        />
                        <button disabled className={styles.modalTtsBtnDisabled}>
                          Coming Soon — Use Polly via Services
                        </button>
                      </div>
                    )}

                    {action.type === 'none' && (
                      <p className={styles.modalNoneText}>
                        This model type isn't directly actionable from the dashboard yet.
                      </p>
                    )}

                    {/* Status message */}
                    {actionMessage && (
                      <p style={{
                        fontSize: 12, marginTop: 12, textAlign: 'center',
                        color: actionStatus === 'success' ? '#32D74B' : actionStatus === 'error' ? '#FF453A' : 'rgba(255,255,255,0.5)',
                      }}>
                        {actionMessage}
                      </p>
                    )}
                  </div>
                </motion.div>
              </motion.div>
            )
          })()}
        </AnimatePresence>
      </div>
    </PageTransition>

    {/* Lightbox — outside PageTransition to avoid transform context breaking fixed positioning */}
    {lightboxUrl && (
      <div
        onClick={() => setLightboxUrl(null)}
        className={styles.lightbox}
      >
        <img
          src={lightboxUrl} alt="Generated"
          className={styles.lightboxImg}
          onClick={(e) => e.stopPropagation()}
        />
        <button onClick={() => setLightboxUrl(null)} className={styles.lightboxClose}>
          <X size={14} /> Close
        </button>
      </div>
    )}
    </>
  )
}
