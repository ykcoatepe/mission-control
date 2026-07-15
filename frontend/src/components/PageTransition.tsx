import { motion, useReducedMotion } from 'framer-motion'
import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
  className?: string
}

export default function PageTransition({ children, className = '' }: Props) {
  const reduceMotion = useReducedMotion()

  return (
    <motion.div
      initial={reduceMotion ? false : { opacity: 0, y: 16, filter: 'blur(8px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      exit={reduceMotion ? undefined : { opacity: 0, y: -16, filter: 'blur(8px)' }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.4, ease: [0.4, 0, 0.2, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  )
}
