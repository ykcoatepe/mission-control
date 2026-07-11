export interface GBrainActionResult {
  ok: boolean
  action?: string
  label?: string
  status: string
  pending?: boolean
  summary?: string
  error?: string
  checkedAt: string
  refreshAfter?: boolean
}
