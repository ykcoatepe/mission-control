import type { ReactNode } from 'react'

export interface TabItem {
  id: string
  label: ReactNode
  /** Optional count after the label. Only pass real numbers. */
  count?: number
  disabled?: boolean
}

/** Active tab id for URL-synced tabs; unknown or missing values fall back to the default. */
export function resolveTab(tabs: TabItem[], raw: string | null | undefined, fallback?: string): string {
  const enabled = tabs.filter((tab) => !tab.disabled)
  if (raw && enabled.some((tab) => tab.id === raw)) return raw
  if (fallback && enabled.some((tab) => tab.id === fallback)) return fallback
  return enabled[0]?.id ?? tabs[0]?.id ?? ''
}
