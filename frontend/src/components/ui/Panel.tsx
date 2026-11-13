import { Block } from './Block'
import type { BlockProps } from './Block'

export type PanelProps = Omit<BlockProps, 'tone' | 'meta'> & Partial<Pick<BlockProps, 'meta'>>

/** The same block as `Block` (HMI rule 6), kept under its old name and API so existing pages compile. */
export function Panel(props: PanelProps) {
  return <Block {...props} />
}
