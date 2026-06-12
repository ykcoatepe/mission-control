import type { CSSProperties } from 'react'
import { Clock, Cpu, Pause, Play, AlertTriangle } from 'lucide-react'
import GlassCard from '../../components/GlassCard'
import type { CronStatusFilter } from './types'
import styles from './SummaryCards.module.css'

const SUMMARY_ITEMS = [
  { key: 'all', label: 'All', icon: Cpu, color: 'rgba(255,255,255,0.5)' },
  { key: 'active', label: 'Active', icon: Play, color: '#32D74B' },
  { key: 'disabled', label: 'Disabled', icon: Pause, color: '#FF9500' },
  { key: 'failed', label: 'Failed', icon: AlertTriangle, color: '#FF453A' },
  { key: 'overlap', label: 'Overlap', icon: Clock, color: '#BF5AF2' },
] as const

interface SummaryCardsProps {
  m: boolean
  counts: Record<CronStatusFilter, number>
  statusFilter: CronStatusFilter
  onSelect: (filter: CronStatusFilter) => void
}

export default function SummaryCards({ m, counts, statusFilter, onSelect }: SummaryCardsProps) {
  return (
    <div className={m ? `${styles.grid} ${styles.gridMobile}` : styles.grid}>
      {SUMMARY_ITEMS.map((item, i) => (
        <GlassCard key={item.label} delay={0.05 + i * 0.05} noPad>
          <div
            onClick={() => onSelect(item.key)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelect(item.key)
              }
            }}
            aria-pressed={statusFilter === item.key}
            className={[
              m ? `${styles.inner} ${styles.innerMobile}` : styles.inner,
              statusFilter === item.key ? styles.innerActive : '',
            ].join(' ')}
            style={{ '--stat-color': item.color } as CSSProperties}
          >
            <div className={m ? `${styles.top} ${styles.topMobile}` : styles.top}>
              <div
                className={m ? `${styles.iconWrap} ${styles.iconWrapMobile}` : styles.iconWrap}
                style={{ '--stat-color': item.color } as CSSProperties}
              >
                <item.icon size={m ? 12 : 14} style={{ color: item.color }} />
              </div>
              <span className={m ? `${styles.label} ${styles.labelMobile}` : styles.label}>{item.label}</span>
            </div>
            <p className={m ? `${styles.value} ${styles.valueMobile}` : styles.value}>{counts[item.key]}</p>
          </div>
        </GlassCard>
      ))}
    </div>
  )
}
