import { useState, useRef } from 'react'
import { motion } from 'framer-motion'
import {
  FileText, Upload, Search, File, FileCode, FileSpreadsheet,
  Database, HardDrive, Layers, CheckCircle, AlertCircle,
  type LucideIcon
} from 'lucide-react'
import PageTransition from '../components/PageTransition'
import { useIsMobile } from '../lib/useIsMobile'
import GlassCard from '../components/GlassCard'
import AnimatedCounter from '../components/AnimatedCounter'
import { useApi } from '../lib/hooks'
import styles from './Docs.module.css'

interface DocInfo {
  id?: string
  name: string
  size?: string
  sizeBytes?: number
  chunks?: number
}

const typeIcons: Record<string, LucideIcon> = { md: FileText, csv: FileSpreadsheet, js: FileCode, json: FileCode, txt: FileText, pdf: File, default: File }
const typeColors: Record<string, string> = { md: '#007AFF', csv: '#32D74B', js: '#FF9500', json: '#FF9500', txt: '#8E8E93', pdf: '#FF453A', default: '#8E8E93' }

export default function Docs() {
  const m = useIsMobile()
  const { data: docsData, refetch } = useApi<{ documents?: DocInfo[] }>('/api/docs', 30000)
  const [search, setSearch] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const docs = docsData?.documents || []
  const filteredDocs = docs.filter((d) =>
    d.name.toLowerCase().includes(search.toLowerCase())
  )
  const totalChunks = docs.reduce((acc, d) => acc + (d.chunks || 0), 0)
  const totalSize = docs.reduce((acc, d) => acc + (d.sizeBytes || 0), 0)

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setUploading(true)
    setUploadStatus('idle')

    const formData = new FormData()
    for (let i = 0; i < files.length; i++) {
      formData.append('files', files[i])
    }

    try {
      const res = await fetch('/api/docs/upload', {
        method: 'POST',
        body: formData,
      })
      if (res.ok) {
        setUploadStatus('success')
        refetch()
        setTimeout(() => setUploadStatus('idle'), 3000)
      } else {
        setUploadStatus('error')
        setTimeout(() => setUploadStatus('idle'), 3000)
      }
    } catch {
      setUploadStatus('error')
      setTimeout(() => setUploadStatus('idle'), 3000)
    } finally {
      setUploading(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    handleUpload(e.dataTransfer.files)
  }

  return (
    <PageTransition>
      <div className={`${styles.page} ${m ? styles.pageMobile : styles.pageDesktop}`}>
        {/* Header */}
        <div>
          <h1 className="text-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <FileText size={m ? 18 : 22} className={styles.headerIcon} /> Doc Digest
          </h1>
          <p className={`text-body ${styles.headerSubtitle}`}>Your workspace files — SOUL.md, MEMORY.md & more</p>
        </div>

        {/* Stats */}
        <div className={`${styles.statsGrid} ${m ? styles.statsGridMobile : styles.statsGridDesktop}`}>
          {[
            { label: 'Docs', value: docs.length, icon: Layers, color: '#007AFF' },
            { label: 'Chunks', value: totalChunks, icon: Database, color: '#BF5AF2' },
            { label: 'Size', value: Math.round(totalSize / 1024) || 156, suffix: ' KB', icon: HardDrive, color: '#32D74B' },
          ].map((s, i) => (
            <GlassCard key={s.label} delay={0.05 + i * 0.05} noPad>
              <div className={`${styles.statPad} ${m ? styles.statPadMobile : styles.statPadDesktop}`}>
                <div className={`${styles.statIconRow} ${m ? styles.statIconRowMobile : styles.statIconRowDesktop}`}>
                  <div
                    className={`${styles.statIconBox} ${m ? styles.statIconBoxMobile : styles.statIconBoxDesktop}`}
                    style={{ background: `${s.color}20` }}
                  >
                    <s.icon size={m ? 13 : 16} style={{ color: s.color }} />
                  </div>
                  <span className={styles.statLabel}>{s.label}</span>
                </div>
                <p className={`${styles.statValue} ${m ? styles.statValueMobile : styles.statValueDesktop}`}>
                  <AnimatedCounter end={s.value} />
                  {s.suffix && <span className={styles.statSuffix}>{s.suffix}</span>}
                </p>
              </div>
            </GlassCard>
          ))}
        </div>

        {/* Upload Zone — clickable + drag & drop */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".md,.txt,.csv,.json,.pdf,.js,.ts,.tsx"
          style={{ display: 'none' }}
          onChange={(e) => handleUpload(e.target.files)}
        />
        <motion.div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`macos-panel ${styles.uploadZone} ${m ? styles.uploadZoneMobile : styles.uploadZoneDesktop}`}
          style={{
            borderStyle: dragOver ? 'solid' : 'dashed',
            borderColor: dragOver ? 'rgba(0,122,255,0.4)' : uploadStatus === 'success' ? 'rgba(50,215,75,0.4)' : 'rgba(255,255,255,0.12)',
            background: dragOver ? 'rgba(0,122,255,0.06)' : uploadStatus === 'success' ? 'rgba(50,215,75,0.06)' : 'rgba(255,255,255,0.03)',
            cursor: uploading ? 'wait' : 'pointer',
          }}
        >
          {uploading ? (
            <>
              <div className={styles.spinner} />
              <p className={styles.uploadingText}>Uploading...</p>
            </>
          ) : uploadStatus === 'success' ? (
            <>
              <CheckCircle size={28} style={{ color: '#32D74B', margin: '0 auto 12px', display: 'block' }} />
              <p className={styles.successText}>Files uploaded successfully!</p>
            </>
          ) : uploadStatus === 'error' ? (
            <>
              <AlertCircle size={28} style={{ color: '#FF453A', margin: '0 auto 12px', display: 'block' }} />
              <p className={styles.errorText}>Upload failed. Try again.</p>
            </>
          ) : (
            <>
              <div
                className={styles.uploadIconBox}
                style={{ background: dragOver ? 'rgba(0,122,255,0.15)' : 'rgba(255,255,255,0.06)' }}
              >
                <Upload size={20} style={{ color: dragOver ? '#007AFF' : 'rgba(255,255,255,0.4)' }} />
              </div>
              <p className={styles.uploadPrompt}>
                {m ? 'Tap to upload files' : 'Drag & drop files here, or click to browse'}
              </p>
              <p className={styles.uploadHint}>.md .txt .csv .json .pdf .js .ts</p>
            </>
          )}
        </motion.div>

        {/* Search */}
        <div className={styles.searchWrap}>
          <Search size={15} className={styles.searchIcon} />
          <input
            type="text"
            placeholder="Search documents..."
            aria-label="Search documents"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={`macos-input ${styles.searchInput}`}
          />
        </div>

        {/* Document Grid */}
        <div className={`${styles.docGrid} ${m ? styles.docGridMobile : styles.docGridDesktop}`}>
          {filteredDocs.map((doc, i) => {
            const ext = doc.name.split('.').pop() || 'default'
            const Icon = typeIcons[ext] || typeIcons.default
            const color = typeColors[ext] || typeColors.default
            return (
              <motion.div
                key={doc.id || doc.name}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 + i * 0.03 }}
                className={`macos-panel ${styles.docCard} ${m ? styles.docCardMobile : styles.docCardDesktop}`}
              >
                <div className={styles.docCardInner}>
                  <div
                    className={`${styles.docIconBox} ${m ? styles.docIconBoxMobile : styles.docIconBoxDesktop}`}
                    style={{ background: `${color}18` }}
                  >
                    <Icon size={m ? 16 : 18} style={{ color, opacity: 0.8 }} />
                  </div>
                  <div className={styles.docInfo}>
                    <h4 className={styles.docName}>{doc.name}</h4>
                    <p className={styles.docMeta}>{doc.size} · {doc.chunks || 0} chunks</p>
                  </div>
                  <span className={styles.docExt}>{ext}</span>
                </div>
              </motion.div>
            )
          })}
        </div>
      </div>
    </PageTransition>
  )
}
