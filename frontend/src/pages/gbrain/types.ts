export interface GBrainActionResult {
  ok: boolean
  action?: string
  label?: string
  status: string
  summary?: string
  error?: string
  checkedAt: string
  refreshAfter?: boolean
}
