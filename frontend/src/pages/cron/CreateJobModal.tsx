import { useState } from 'react'
import { Plus } from 'lucide-react'
import { motion } from 'framer-motion'
import { useIsMobile } from '../../lib/useIsMobile'
import { CRON_PRESETS } from './lib'
import type { CreateCronJobPayload, ModelOption } from './types'
import styles from './CreateJobModal.module.css'

interface CreateJobModalProps {
  onClose: () => void
  onSubmit: (job: CreateCronJobPayload) => Promise<void>
  modelOptions: ModelOption[]
}

export default function CreateJobModal({ onClose, onSubmit, modelOptions }: CreateJobModalProps) {
  const m = useIsMobile()
  const [formError, setFormError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formData, setFormData] = useState({
    name: '',
    schedule: '',
    sessionTarget: 'isolated',
    payloadType: 'agentTurn',
    message: '',
    model: ''
  })

  const handlePresetClick = (expr: string) => {
    setFormData(prev => ({ ...prev, schedule: expr }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isSubmitting) return
    setFormError(null)

    if (!formData.name || !formData.schedule || !formData.message) {
      setFormError('Name, schedule, and message are required')
      return
    }

    const job: CreateCronJobPayload = {
      name: formData.name,
      schedule: {
        kind: 'cron',
        expr: formData.schedule
      },
      sessionTarget: formData.sessionTarget,
      payload: {
        kind: formData.payloadType,
        message: formData.message,
        ...(formData.payloadType === 'agentTurn' && formData.model ? { model: formData.model } : {})
      },
      enabled: true
    }

    setIsSubmitting(true)
    try {
      await onSubmit(job)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className={m ? `${styles.modalOverlay} ${styles.modalOverlayMobile}` : styles.modalOverlay}>
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.9 }}
        className={m ? `${styles.modalPanel} ${styles.modalPanelMobile}` : styles.modalPanel}
      >
        <div className={m ? `${styles.modalHeader} ${styles.modalHeaderMobile}` : styles.modalHeader}>
          <h2 className={m ? `${styles.modalTitle} ${styles.modalTitleMobile}` : styles.modalTitle}>
            <Plus size={m ? 16 : 18} className={styles.iconBlue} />
            Create Cron Job
          </h2>
          <button
            onClick={onClose}
            disabled={isSubmitting}
            className={styles.modalClose}
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className={m ? `${styles.modalForm} ${styles.modalFormMobile}` : styles.modalForm}>
          {/* Name */}
          <div>
            <label className={styles.fieldLabel}>
              Name
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
              placeholder="e.g. Check emails"
              className={m ? `${styles.fieldInput} ${styles.fieldInputMobile}` : styles.fieldInput}
            />
          </div>

          {/* Schedule */}
          <div>
            <label className={styles.fieldLabel}>
              Schedule
            </label>
            <input
              type="text"
              value={formData.schedule}
              onChange={(e) => setFormData(prev => ({ ...prev, schedule: e.target.value }))}
              placeholder="0 8 * * * (daily at 8am)"
              className={m
                ? `${styles.fieldInput} ${styles.fieldInputMobile} ${styles.fieldInputMono}`
                : `${styles.fieldInput} ${styles.fieldInputMono}`}
            />
            <div className={styles.presetRow}>
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => handlePresetClick(preset.expr)}
                  className={styles.presetBtn}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <p className={styles.fieldHint}>
              Format: minute hour day month weekday (* = any)
            </p>
          </div>

          {/* Session Target */}
          <div>
            <label className={styles.fieldLabel}>
              Session Target
            </label>
            <select
              value={formData.sessionTarget}
              onChange={(e) => setFormData(prev => ({ ...prev, sessionTarget: e.target.value }))}
              className={m ? `${styles.fieldSelect} ${styles.fieldSelectMobile}` : styles.fieldSelect}
            >
              <option value="main">main</option>
              <option value="isolated">isolated</option>
            </select>
          </div>

          {/* Payload Type */}
          <div>
            <label className={styles.fieldLabel}>
              Payload Type
            </label>
            <select
              value={formData.payloadType}
              onChange={(e) => setFormData(prev => ({ ...prev, payloadType: e.target.value }))}
              className={m ? `${styles.fieldSelect} ${styles.fieldSelectMobile}` : styles.fieldSelect}
            >
              <option value="systemEvent">systemEvent</option>
              <option value="agentTurn">agentTurn</option>
            </select>
          </div>

          {/* Message */}
          <div>
            <label className={styles.fieldLabel}>
              Message
            </label>
            <textarea
              value={formData.message}
              onChange={(e) => setFormData(prev => ({ ...prev, message: e.target.value }))}
              placeholder="Task description or prompt..."
              rows={3}
              className={m ? `${styles.fieldTextarea} ${styles.fieldTextareaMobile}` : styles.fieldTextarea}
            />
          </div>

          {/* Model (optional, only if agentTurn) */}
          {formData.payloadType === 'agentTurn' && (
            <div>
              <label className={styles.fieldLabel}>
                Model (Optional)
              </label>
              <select
                value={formData.model}
                onChange={(e) => setFormData(prev => ({ ...prev, model: e.target.value }))}
                className={m ? `${styles.fieldSelect} ${styles.fieldSelectMobile}` : styles.fieldSelect}
              >
                {modelOptions.map((option) => (
                  <option key={option.value || 'default'} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {formError && (
            <p className={styles.formError} role="alert">{formError}</p>
          )}

          {/* Actions */}
          <div className={m ? `${styles.modalActions} ${styles.modalActionsMobile}` : styles.modalActions}>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className={m ? `${styles.cancelBtn} ${styles.cancelBtnMobile}` : styles.cancelBtn}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className={m ? `${styles.submitBtn} ${styles.submitBtnMobile}` : styles.submitBtn}
            >
              {isSubmitting ? 'Creating...' : 'Create Job'}
            </button>
          </div>
        </form>
      </motion.div>
    </div>
  )
}
