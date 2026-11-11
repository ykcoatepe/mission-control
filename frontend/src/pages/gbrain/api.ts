import { postJson } from '../../lib/hooks'
import type { GBrainActionResult } from './types'

/**
 * Runs one GBrain action. A failure throws the shared `ApiError`: its message
 * is the server's (`{ error: { code, message } }`, or the action result's own
 * `error` text), and `payload` keeps the full action result, which the flow
 * needs to tell a timed-out action that is still cleaning up from a failure.
 */
export function postGBrainAction(action: string, confirmed = false): Promise<GBrainActionResult> {
  return postJson<GBrainActionResult>('/api/gbrain/actions', confirmed ? { action, confirmed: true } : { action })
}
