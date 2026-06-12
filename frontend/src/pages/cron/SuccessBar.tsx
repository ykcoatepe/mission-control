import { successRateColor } from './lib'
import type { SuccessRate } from './types'
import styles from './SuccessBar.module.css'

export default function SuccessBar({ rate }: { rate: SuccessRate }) {
  const barColor = successRateColor(rate.pct)
  return (
    <div className={styles.outer}>
      <div className={styles.top}>
        <span className={styles.pct} style={{ color: barColor }}>{rate.rate}</span>
        <span className={styles.total}>{rate.total}x</span>
      </div>
      <div className={styles.track}>
        <div className={styles.fill} style={{ width: `${rate.pct}%`, background: barColor }} />
      </div>
      {rate.failed > 0 && (
        <span className={styles.failed}>{rate.failed} failed</span>
      )}
    </div>
  )
}
