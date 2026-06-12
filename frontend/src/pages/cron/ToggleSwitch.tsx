import styles from './ToggleSwitch.module.css'

interface ToggleSwitchProps {
  enabled: boolean
  onChange: (enabled: boolean) => void
  disabled?: boolean
}

export default function ToggleSwitch({ enabled, onChange, disabled = false }: ToggleSwitchProps) {
  return (
    <div
      role="switch"
      aria-checked={enabled}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onClick={() => { if (!disabled) onChange(!enabled) }}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onChange(!enabled)
        }
      }}
      className={[
        styles.track,
        enabled ? styles.trackOn : styles.trackOff,
        disabled ? styles.trackDisabled : '',
      ].join(' ')}
    >
      <div className={enabled ? `${styles.thumb} ${styles.thumbOn}` : styles.thumb} />
    </div>
  )
}
