import type { GBrainActionResult } from './types'

export async function postGBrainAction(action: string): Promise<GBrainActionResult> {
  const response = await fetch('/api/gbrain/actions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  const payload = (await response.json()) as GBrainActionResult
  if (!response.ok) {
    throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { payload })
  }
  return payload
}
