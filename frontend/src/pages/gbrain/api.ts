import { ApiError, isApiError, postJson } from '../../lib/hooks'
import type { GBrainActionResult } from './types'

/**
 * A failed action answers the one error contract with the action result
 * alongside: `{ ...result, error: { code, message } }` (400/409/502/504), or
 * just `{ error: { code, message } }` (503, lane quarantined). The flow reads
 * the result's own fields (`status`, `pending`, `refreshAfter`, `summary`) and
 * `error` as text, so the payload kept on the `ApiError` carries `error` as
 * the message string.
 */
function withTextError(error: ApiError): ApiError {
  const payload = error.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return error
  const body = payload as Record<string, unknown>
  const detail = body.error
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return error
  return new ApiError({
    status: error.status,
    code: error.code,
    message: error.message,
    retryAfterMs: error.retryAfterMs,
    payload: { ...body, error: error.message },
  })
}

/**
 * Runs one GBrain action. A failure throws the shared `ApiError`: its message
 * and code are the server's, and `payload` keeps the full action result, which
 * the flow needs to tell a timed-out action that is still cleaning up from a
 * failure.
 */
export async function postGBrainAction(action: string, confirmed = false): Promise<GBrainActionResult> {
  try {
    return await postJson<GBrainActionResult>('/api/gbrain/actions', confirmed ? { action, confirmed: true } : { action })
  } catch (error) {
    throw isApiError(error) ? withTextError(error) : error
  }
}
