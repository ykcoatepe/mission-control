import { motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'
import { useIsMobile } from '../lib/useIsMobile'

interface Props {
  children: ReactNode
  className?: string
  hover?: boolean
  delay?: number
  noPad?: boolean
  overflowVisible?: boolean
}

export default function GlassCard({ children, className = '', hover = true, delay = 0, noPad = false, overflowVisible = false }: Props) {
  const isMobile = useIsMobile()
  const reduceMotion = useReducedMotion()
  
  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.4, delay, ease: [0.4, 0, 0.2, 1] }}
      whileHover={hover && !isMobile && !reduceMotion ? {
        y: -2,
        transition: { duration: 0.15, ease: [0.4, 0, 0.2, 1] }
      } : undefined}
      className={`macos-panel ${className}`}
      style={{ overflow: overflowVisible ? 'visible' : 'hidden' }}
    >
      <div style={noPad ? undefined : { padding: isMobile ? 16 : 24 }}>
        {children}
      </div>
    </motion.div>
  )
}
