import { useCallback, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Download, Upload } from 'lucide-react'
import { describeApiError, isApiError, postForm, postJson, useApi } from '../lib/hooks'
import { changedRouting, heartbeatError, routingErrors } from './settings/lib'
import type { Routing, RoutingField } from './settings/lib'
import { useTheme } from '../lib/theme'
import type { Theme } from '../lib/theme'
import {
  Button,
  ErrorState,
  Field,
  Mono,
  Notice,
  Page,
  Panel,
  SegmentedControl,
  Select,
  Skeleton,
  useToast,
} from '../components/ui'
import type { SelectOption } from '../components/ui'
import styles from './Settings.module.css'

/** GET /api/settings. The gateway token is never part of it. */
interface OpenClawConfig {
  model?: string | null
  gateway_port?: number | null
  memory_path?: string | null
  skills_path?: string | null
  bedrock_region?: string | null
  system?: {
    mission_control_version?: string
    openclaw_version?: string | null
    node_version?: string
    platform?: string
    arch?: string
  }
}

/** Whether a routing field is set, left unset in the configuration, or could not be read (`*Source`). */
type RoutingSource = 'set' | 'unset' | 'unreadable'

interface ModelRoutingData {
  main?: string | null
  subagent?: string | null
  heartbeat?: string | null
  mainSource?: RoutingSource
  subagentSource?: RoutingSource
  heartbeatSource?: RoutingSource
}

interface ModelInfo {
  id: string
  name: string
  tags?: string[]
}

interface SaveMessages {
  success: string
  error: string
}

type SaveResult = { ok: true } | { ok: false; error: unknown; message: string }

/**
 * One save path for every write on this page: busy flag per action and a toast
 * with the outcome. A failure toast carries the server's reason; the caller
 * also gets the error back, to show a 400 next to the field it is about.
 */
function useSaver() {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)

  const run = useCallback(
    async (key: string, request: () => Promise<unknown>, messages: SaveMessages): Promise<SaveResult> => {
      setBusy(key)
      try {
        await request()
        toast.show('success', messages.success)
        return { ok: true }
      } catch (error) {
        const message = describeApiError(error)
        toast.show('error', `${messages.error}: ${message}`)
        return { ok: false, error, message }
      } finally {
        setBusy(null)
      }
    },
    [toast],
  )

  const post = useCallback(
    (key: string, url: string, body: unknown, messages: SaveMessages) =>
      run(key, () => postJson(url, body), messages),
    [run],
  )

  return { busy, run, post }
}

type Saver = ReturnType<typeof useSaver>

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

const HEARTBEAT_OPTIONS: SelectOption[] = [
  { value: '', label: 'Choose an interval' },
  { value: '30m', label: 'Every 30 minutes' },
  { value: '1h', label: 'Every hour' },
  { value: '2h', label: 'Every 2 hours' },
  { value: '4h', label: 'Every 4 hours' },
]

export default function Settings() {
  const saver = useSaver()

  return (
    <Page title="Settings" description="Model routing, heartbeat, appearance and backup." width="narrow">
      <ModelsPanel saver={saver} />
      <HeartbeatPanel saver={saver} />
      <AppearancePanel />
      <ConnectionPanel />
      <BackupPanel saver={saver} />
    </Page>
  )
}

/**
 * "Inherits the main model": the field is unset in the configuration (`*Source` is `unset`) or
 * the person chose to unset it. Only the heartbeat model can be unset through the API, so only
 * it is offered as a choice; a sub-agent that inherits shows it as its current state.
 * `''` is a value that is not a model: "Not set" (main) or "Not read" (the source could not be read).
 */
const INHERIT = '__inherit__'

/** The select value for a routing field, from what the server reported. */
function baselineFor(field: RoutingField, value: string | null | undefined, source: RoutingSource | undefined): string {
  if (source === 'set' && typeof value === 'string' && value) return value
  if (source === 'unset' && field !== 'main') return INHERIT
  return ''
}

function emptyLabel(source: RoutingSource | undefined): string {
  return source === 'unset' ? 'Not set' : 'Not read'
}

function modelOptions(models: ModelInfo[], current: string, field: RoutingField, source: RoutingSource | undefined): SelectOption[] {
  const options: SelectOption[] = models.map((m) => ({ value: m.id, label: m.name || m.id }))
  if (current && current !== INHERIT && !models.some((m) => m.id === current)) {
    options.unshift({ value: current, label: current })
  }
  // The heartbeat model can be unset through the API; a sub-agent only shows that it inherits.
  if (field === 'heartbeat' || current === INHERIT) {
    options.unshift({ value: INHERIT, label: 'Inherits the main model' })
  }
  if (!current) options.unshift({ value: '', label: emptyLabel(source) })
  return options
}

/** The routing as the server takes it: the explicit inherit choice becomes the empty string. */
function routingForServer(changed: Partial<Routing>): Partial<Routing> {
  return changed.heartbeat === INHERIT ? { ...changed, heartbeat: '' } : changed
}

/** The hint under a field that holds no model: the server's `*Source` says why. */
function unreadHint(name: string, source: RoutingSource | undefined): string {
  return source === 'unset'
    ? `No ${name} model is set. Choose one to set it.`
    : `The current ${name} model could not be read. Choose one to change it.`
}

function ModelsPanel({ saver }: { saver: Saver }) {
  const models = useApi<ModelInfo[]>('/api/models')
  const routingApi = useApi<ModelRoutingData>('/api/settings/model-routing')
  const [draft, setDraft] = useState<Partial<Routing>>({})
  const [saved, setSaved] = useState<Routing | null>(null)
  // What the server said about the last save, next to the fields that were sent.
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<RoutingField, string>>>({})

  const loading = models.loading || routingApi.loading
  const error = routingApi.error ?? models.error

  const retry = () => {
    if (routingApi.error) routingApi.refetch()
    if (models.error) models.refetch()
  }

  let body
  if (loading) {
    body = <Skeleton lines={3} label="Reading model routing" />
  } else if (error || !routingApi.data) {
    body = (
      <ErrorState
        title="Model routing could not be read"
        message={error ?? undefined}
        onRetry={retry}
      />
    )
  } else {
    const server = routingApi.data
    // Each field comes as the server reported it. A sub-agent model that is unset inherits the main
    // model; the page does not copy the main model into it.
    const baseline: Routing = saved ?? {
      main: baselineFor('main', server.main, server.mainSource),
      subagent: baselineFor('subagent', server.subagent, server.subagentSource),
      heartbeat: baselineFor('heartbeat', server.heartbeat, server.heartbeatSource),
    }
    const routing: Routing = { ...baseline, ...draft }
    const dirty = (Object.keys(routing) as (keyof Routing)[]).some((k) => routing[k] !== baseline[k])
    const list = models.data ?? []
    const set = (key: keyof Routing) => (e: ChangeEvent<HTMLSelectElement>) => {
      setDraft((prev) => ({ ...prev, [key]: e.target.value }))
      setFieldErrors((prev) => ({ ...prev, [key]: undefined }))
    }

    const onSave = async () => {
      // A partial update: only the fields that changed are sent.
      const changed = routingForServer(changedRouting(baseline, routing))
      const invalid = routingErrors(changed)
      if (Object.keys(invalid).length > 0) {
        setFieldErrors(invalid)
        return
      }
      setFieldErrors({})
      const result = await saver.post('routing', '/api/settings/model-routing', changed, {
        success: 'Model routing saved',
        error: 'Model routing could not be saved',
      })
      if (result.ok) {
        setSaved(routing)
        setDraft({})
      } else if (isApiError(result.error) && result.error.status === 400) {
        // The server validates every model value; say so next to the fields that were sent.
        const sent = Object.keys(changed) as RoutingField[]
        setFieldErrors(Object.fromEntries(sent.map((field) => [field, result.message])))
      }
    }

    body = (
      <div className={styles.form}>
        <div className={styles.fields}>
          <Field label="Main model" hint={routing.main === '' ? unreadHint('main', server.mainSource) : 'Used for the main assistant.'} error={fieldErrors.main}>
            {(c) => <Select {...c} value={routing.main} onChange={set('main')} options={modelOptions(list, routing.main, 'main', server.mainSource)} />}
          </Field>
          <Field
            label="Sub-agent model"
            hint={routing.subagent === '' ? unreadHint('sub-agent', server.subagentSource) : 'Used by sub-agents the assistant starts.'}
            error={fieldErrors.subagent}
          >
            {(c) => <Select {...c} value={routing.subagent} onChange={set('subagent')} options={modelOptions(list, routing.subagent, 'subagent', server.subagentSource)} />}
          </Field>
          <Field
            label="Heartbeat model"
            hint={routing.heartbeat === '' ? unreadHint('heartbeat', server.heartbeatSource) : 'Used for scheduled heartbeat checks.'}
            error={fieldErrors.heartbeat}
          >
            {(c) => <Select {...c} value={routing.heartbeat} onChange={set('heartbeat')} options={modelOptions(list, routing.heartbeat, 'heartbeat', server.heartbeatSource)} />}
          </Field>
        </div>
        {models.error && (
          <Notice tone="warning" title="Model list could not be read">
            Only the current choices are listed.
          </Notice>
        )}
        <div className={styles.actions}>
          <Button
            variant="primary"
            onClick={onSave}
            loading={saver.busy === 'routing'}
            disabled={!dirty || saver.busy !== null}
          >
            Save routing
          </Button>
        </div>
      </div>
    )
  }

  return (
    <Panel title="Models" description="Which model handles each kind of work.">
      {body}
    </Panel>
  )
}

function HeartbeatPanel({ saver }: { saver: Saver }) {
  const [interval, setInterval] = useState('')
  const [error, setError] = useState<string | null>(null)

  const onSave = async () => {
    const invalid = heartbeatError(interval)
    if (invalid) {
      setError(invalid)
      return
    }
    setError(null)
    const result = await saver.post('heartbeat', '/api/settings/heartbeat', { interval }, {
      success: 'Heartbeat interval saved',
      error: 'Heartbeat interval could not be saved',
    })
    if (!result.ok && isApiError(result.error) && result.error.status === 400) setError(result.message)
  }

  return (
    <Panel title="Heartbeat" description="How often the assistant checks in on its own.">
      <div className={styles.form}>
        <div className={styles.fields}>
          <Field label="Check interval" hint="The current interval is not readable here. Choose one to change it." error={error}>
            {(c) => (
              <Select
                {...c}
                value={interval}
                onChange={(e) => {
                  setInterval(e.target.value)
                  setError(null)
                }}
                options={HEARTBEAT_OPTIONS}
              />
            )}
          </Field>
        </div>
        <div className={styles.actions}>
          <Button
            variant="primary"
            onClick={onSave}
            loading={saver.busy === 'heartbeat'}
            disabled={!interval || saver.busy !== null}
          >
            Save interval
          </Button>
        </div>
      </div>
    </Panel>
  )
}

function AppearancePanel() {
  const { theme, setTheme } = useTheme()
  return (
    <Panel title="Appearance" description="Saved in this browser.">
      <div className={styles.appearance}>
        <span className={styles.rowLabel}>Theme</span>
        <SegmentedControl<Theme> ariaLabel="Theme" options={THEME_OPTIONS} value={theme} onChange={setTheme} />
      </div>
    </Panel>
  )
}

function ConnectionPanel() {
  const { data, loading, error, refetch } = useApi<OpenClawConfig>('/api/settings')

  let body
  if (loading) {
    body = <Skeleton lines={4} label="Reading connection details" />
  } else if (error || !data) {
    body = <ErrorState title="Connection details could not be read" message={error ?? undefined} onRetry={refetch} />
  } else {
    const sys = data.system
    const rows: { label: string; value: string | number | null | undefined }[] = [
      { label: 'Gateway port', value: data.gateway_port },
      { label: 'Memory folder', value: data.memory_path },
      { label: 'Skills folder', value: data.skills_path },
      { label: 'Bedrock region', value: data.bedrock_region },
      { label: 'Mission Control', value: sys?.mission_control_version ? `v${sys.mission_control_version}` : null },
      { label: 'OpenClaw', value: sys?.openclaw_version },
      { label: 'Node.js', value: sys?.node_version },
      { label: 'Platform', value: sys?.platform && sys?.arch ? `${sys.platform} ${sys.arch}` : null },
    ]
    body = (
      <dl className={styles.rows}>
        {rows.map((row) => (
          <div key={row.label} className={styles.row}>
            <dt className={styles.rowLabel}>{row.label}</dt>
            <dd className={styles.rowValue}>
              {row.value === null || row.value === undefined || row.value === '' ? (
                <span className={styles.missing} aria-label="not read">
                  —
                </span>
              ) : (
                <Mono truncate>{String(row.value)}</Mono>
              )}
            </dd>
          </div>
        ))}
      </dl>
    )
  }

  return (
    <Panel title="Connection" description="Read-only values reported by the gateway.">
      {body}
    </Panel>
  )
}

function BackupPanel({ saver }: { saver: Saver }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [imported, setImported] = useState(false)
  // The server names the offending path when it refuses a document; keep that visible.
  const [importError, setImportError] = useState<string | null>(null)

  const onExport = () => {
    window.location.href = '/api/settings/export'
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target
    const file = input.files?.[0]
    if (!file) return
    setImported(false)
    setImportError(null)
    const formData = new FormData()
    formData.append('config', file)
    const result = await saver.run(
      'import',
      () => postForm('/api/settings/import', formData),
      { success: 'Configuration imported. Restart required.', error: 'Configuration could not be imported' },
    )
    if (result.ok) setImported(true)
    else setImportError(result.message)
    input.value = ''
  }

  return (
    <Panel title="Backup" description="Export the configuration, or load one from a JSON file.">
      <div className={styles.form}>
        <div className={styles.actions}>
          <Button icon={<Download size={14} />} onClick={onExport}>
            Export configuration
          </Button>
          <Button
            icon={<Upload size={14} />}
            loading={saver.busy === 'import'}
            disabled={saver.busy !== null}
            onClick={() => inputRef.current?.click()}
          >
            Import configuration
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept=".json"
            className={styles.fileInput}
            aria-label="Configuration file to import"
            tabIndex={-1}
            onChange={onFile}
          />
        </div>
        {importError && (
          <Notice tone="critical" title="This file was not imported">
            {importError}
          </Notice>
        )}
        {imported && (
          <Notice tone="warning" title="Restart required">
            The imported configuration takes effect after a restart.
          </Notice>
        )}
      </div>
    </Panel>
  )
}
