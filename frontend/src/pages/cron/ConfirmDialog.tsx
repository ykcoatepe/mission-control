import { AlertTriangle } from 'lucide-react'
import { motion } from 'framer-motion'
import { useIsMobile } from '../../lib/useIsMobile'
import styles from './ConfirmDialog.module.css'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}

export default function ConfirmDialog({ title, message, confirmLabel, busy = false, onCancel, onConfirm }: ConfirmDialogProps) {
  const m = useIsMobile()
  return (
    <div className={m ? `${styles.overlay} ${styles.overlayMobile}` : styles.overlay}>
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.92 }}
        className={styles.panel}
        role="alertdialog"
        aria-label={title}
      >
        <div className={styles.titleRow}>
          <AlertTriangle size={18} className={styles.titleIcon} />
          <h2 className={styles.title}>{title}</h2>
        </div>
        <p className={styles.message}>{message}</p>
        <div className={styles.actions}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className={styles.cancelBtn}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={styles.confirmBtn}
          >
            {confirmLabel}
          </button>
        </div>
      </motion.div>
    </div>
  )
}
