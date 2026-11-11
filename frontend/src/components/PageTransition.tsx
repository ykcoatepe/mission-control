import type { ReactNode } from 'react'

interface Props {
  children: ReactNode
  className?: string
}

/** Legacy adapter: renders its children directly. There is no page animation. */
export default function PageTransition({ children, className }: Props) {
  return <div className={className}>{children}</div>
}
