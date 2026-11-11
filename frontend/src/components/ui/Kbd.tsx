import type { ReactNode } from 'react'
import { cx } from './cx'
import styles from './Kbd.module.css'

/** Keyboard hint: `<Kbd>⌘K</Kbd>`. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx(styles.kbd, className)}>{children}</kbd>
}
