import type { ReactNode } from 'react'
import { Stat } from './Stat'
import GlassCard from '../GlassCard'
import styles from './StatCard.module.css'

interface StatCardProps {
  label: string
  value: ReactNode
  /** @deprecated Icons are not shown in the flat design; accepted for compatibility. */
  icon?: ReactNode
  /** @deprecated Colour means state only; accepted for compatibility and ignored. */
  color?: string
  /** Small unit rendered after the value. */
  suffix?: string
  /** @deprecated No entrance animation; accepted for compatibility. */
  delay?: number
}

/** Legacy adapter: a `Stat` in a flat card. New pages use `StatRow` + `Stat`. */
export default function StatCard({ label, value, suffix }: StatCardProps) {
  return (
    <GlassCard noPad>
      <Stat className={styles.stat} label={label} value={value} unit={suffix} />
    </GlassCard>
  )
}
