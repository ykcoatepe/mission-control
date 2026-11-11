import { toUiState } from '../lib/state'
import { StatePill } from './ui/StatePill'

interface Props {
  status: 'active' | 'idle' | 'paused' | 'failed' | 'ok' | 'error' | 'off' | string
  /** @deprecated Size is fixed in the flat design. */
  size?: 'sm' | 'md'
  /** @deprecated No pulsing in the flat design. */
  pulse?: boolean
  label?: string
}

/**
 * Legacy adapter over `StatePill`. Unknown status words render as "unavailable",
 * never as a neutral "off" look. New code uses `StatePill` + `toUiState`.
 */
export default function StatusBadge({ status, label }: Props) {
  const state = toUiState(status)
  return <StatePill state={state} label={label ? capitalize(label) : undefined} />
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
