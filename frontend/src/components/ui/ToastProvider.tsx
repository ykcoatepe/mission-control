import { X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IconButton } from './IconButton'
import { ToastContext } from './toastContext'
import type { ToastApi, ToastTone } from './toastContext'
import styles from './Toast.module.css'

interface ToastItem {
  id: number
  tone: ToastTone
  message: string
  duration: number
}

const TONE_LABEL: Record<ToastTone, string> = {
  success: 'Done',
  error: 'Failed',
  warning: 'Warning',
  info: 'Note',
}

function ToastView({ item, onDismiss }: { item: ToastItem; onDismiss: (id: number) => void }) {
  const { id, duration } = item
  useEffect(() => {
    if (duration <= 0) return
    const timer = setTimeout(() => onDismiss(id), duration)
    return () => clearTimeout(timer)
  }, [id, duration, onDismiss])

  return (
    <div className={styles.toast} data-tone={item.tone} role={item.tone === 'error' ? 'alert' : 'status'}>
      <span className={styles.tone}>{TONE_LABEL[item.tone]}</span>
      <span className={styles.message}>{item.message}</span>
      <IconButton label="Dismiss notification" size="sm" icon={<X size={14} />} onClick={() => onDismiss(id)} />
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }, [])

  const show = useCallback<ToastApi['show']>((tone, message, options) => {
    const id = nextId.current++
    const duration = options?.duration ?? (tone === 'error' ? 8000 : 4000)
    setItems((prev) => [...prev.slice(-3), { id, tone, message, duration }])
    return id
  }, [])

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss])

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className={styles.region} aria-live="polite" aria-label="Notifications">
        {items.map((item) => (
          <ToastView key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}
