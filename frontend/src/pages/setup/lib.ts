import type { UiState } from '../../lib/state'

/**
 * GET /api/setup. Every detected value can be null: the server reads local files
 * only and has not measured the gateway (`gatewayRunning` is null today).
 */
export interface SetupStatus {
  needsSetup: boolean
  gatewayRunning: boolean | null
  gatewayPort: number | null
  gatewayVersion: string | null
  detectedConfig: {
    model: string | null
    channels: string[] | null
    agentName: string | null
    workspacePath: string | null
    gatewayTokenConfigured: boolean | null
  } | null
}

/**
 * The only thing POST /api/setup is sent: the dashboard name and, when one was
 * typed, the gateway token. Modules are not a choice any more (the removed ones
 * no longer exist), the gateway port is detected, and Scout is gone.
 */
export interface SetupPayload {
  dashboardName: string
  gateway?: { token: string }
}

export const NAME_MAX = 120
export const DEFAULT_NAME = 'Mission Control'

/** A name pre-filled from the agent found on this machine; never from anything secret. */
export function suggestName(status: SetupStatus | null | undefined): string {
  const agent = status?.detectedConfig?.agentName?.trim()
  return agent ? `${agent} Control`.slice(0, NAME_MAX) : DEFAULT_NAME
}

export function nameError(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Give the dashboard a name.'
  if (trimmed.length > NAME_MAX) return `Use at most ${NAME_MAX} characters.`
  return null
}

/** The request body. An empty token is left out: it means "keep what is configured". */
export function buildSetupPayload(input: { name: string; token: string }): SetupPayload {
  const payload: SetupPayload = { dashboardName: input.name.trim() }
  const token = input.token.trim()
  if (token) payload.gateway = { token }
  return payload
}

export interface DetectedLine {
  label: string
  value: string
  state: UiState
}

/**
 * What the machine reports about the gateway. Reachability is not measured by
 * this endpoint, so it reads "not checked", never "not detected" or "running".
 */
export function gatewayLines(status: SetupStatus | null | undefined): DetectedLine[] {
  if (!status) return []
  const running = status.gatewayRunning
  const lines: DetectedLine[] = [
    {
      label: 'Gateway',
      value: running === true ? 'Running' : running === false ? 'Not running' : 'Not checked here',
      state: running === true ? 'healthy' : running === false ? 'critical' : 'unavailable',
    },
    {
      label: 'Port',
      value: status.gatewayPort === null || status.gatewayPort === undefined ? 'Not read' : String(status.gatewayPort),
      state: status.gatewayPort === null || status.gatewayPort === undefined ? 'unavailable' : 'healthy',
    },
  ]
  if (status.gatewayVersion) lines.push({ label: 'Version', value: status.gatewayVersion, state: 'healthy' })
  const configured = status.detectedConfig?.gatewayTokenConfigured
  lines.push({
    label: 'Token',
    value: configured === true ? 'Configured locally' : configured === false ? 'Not configured' : 'Not read',
    state: configured === true ? 'healthy' : configured === false ? 'warning' : 'unavailable',
  })
  return lines
}

/** Other detected values, only the ones that exist. */
export function detectedLines(status: SetupStatus | null | undefined): Array<{ label: string; value: string }> {
  const detected = status?.detectedConfig
  if (!detected) return []
  const lines: Array<{ label: string; value: string }> = []
  if (detected.model) lines.push({ label: 'Model', value: detected.model.replace(/^amazon-bedrock\//, '') })
  if (detected.channels && detected.channels.length > 0) lines.push({ label: 'Channels', value: detected.channels.join(', ') })
  if (detected.workspacePath) lines.push({ label: 'Workspace', value: detected.workspacePath })
  return lines
}
