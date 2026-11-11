import { useCallback, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Download, Upload } from 'lucide-react'
import { useApi } from '../lib/hooks'
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

interface OpenClawConfig {
  model?: string
  available_models?: string[]
  gateway_port?: number
  token?: string
  memory_path?: string
  skills_path?: string
  bedrock_region?: string
  system?: {
    mission_control_version?: string
    openclaw_version?: string | null
    node_version?: string
    platform?: string
    arch?: string
  }
}

interface ModelRoutingData {
  main?: string
  subagent?: string
  heartbeat?: string
}

interface ModelInfo {
  id: string
  name: string
  tags?: string[]
}

interface Routing {
  main: string
  subagent: string
  heartbeat: string
}

interface SaveMessages {
  success: string
  error: string
}

/** One save path for every write on this page: busy flag per action and a toast with the outcome. */
function useSaver() {
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)

  const run = useCallback(
    async (key: string, request: () => Promise<Response>, messages: SaveMessages): Promise<boolean> => {
      setBusy(key)
      try {
        const res = await request()
        if (res.ok) {
          toast.show('success', messages.success)
          return true
        }
        toast.show('error', messages.error)
        return false
      } catch {
        toast.show('error', messages.error)
        return false
      } finally {
        setBusy(null)
      }
    },
    [toast],
  )

  const postJson = useCallback(
    (key: string, url: string, body: unknown, messages: SaveMessages) =>
      run(
        key,
        () =>
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }),
        messages,
      ),
    [run],
  )

  return { busy, run, postJson }
}

type Saver = ReturnType<typeof useSaver>

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
]

const HEARTBEAT_OPTIONS: SelectOption[] = [
  { value: '', label: 'Choose an interval' },
  { value: '30min', label: 'Every 30 minutes' },
  { value: '1h', label: 'Every hour' },
  { value: '2h', label: 'Every 2 hours' },
  { value: '4h', label: 'Every 4 hours' },
  { value: 'off', label: 'Off' },
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

function modelOptions(models: ModelInfo[], current: string, allowInherit: boolean): SelectOption[] {
  const options: SelectOption[] = models.map((m) => ({ value: m.id, label: m.name || m.id }))
  if (current && !models.some((m) => m.id === current)) {
    options.unshift({ value: current, label: current })
  }
  if (allowInherit) {
    options.unshift({ value: '', label: 'Inherit from main model' })
  } else if (!current) {
    options.unshift({ value: '', label: 'Not set' })
  }
  return options
}

function ModelsPanel({ saver }: { saver: Saver }) {
  const models = useApi<ModelInfo[]>('/api/models')
  const routingApi = useApi<ModelRoutingData>('/api/settings/model-routing')
  const [draft, setDraft] = useState<Partial<Routing>>({})
  const [saved, setSaved] = useState<Routing | null>(null)

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
    const baseline: Routing = saved ?? {
      main: server.main || '',
      subagent: server.subagent || server.main || '',
      heartbeat: server.heartbeat || '',
    }
    const routing: Routing = { ...baseline, ...draft }
    const dirty = (Object.keys(routing) as (keyof Routing)[]).some((k) => routing[k] !== baseline[k])
    const list = models.data ?? []
    const set = (key: keyof Routing) => (e: ChangeEvent<HTMLSelectElement>) =>
      setDraft((prev) => ({ ...prev, [key]: e.target.value }))

    const onSave = async () => {
      const ok = await saver.postJson('routing', '/api/settings/model-routing', routing, {
        success: 'Model routing saved',
        error: 'Model routing could not be saved',
      })
      if (ok) {
        setSaved(routing)
        setDraft({})
      }
    }

    body = (
      <div className={styles.form}>
        <div className={styles.fields}>
          <Field label="Main model" hint="Used for the main assistant.">
            {(c) => <Select {...c} value={routing.main} onChange={set('main')} options={modelOptions(list, routing.main, false)} />}
          </Field>
          <Field label="Sub-agent model" hint="Used by sub-agents the assistant starts.">
            {(c) => <Select {...c} value={routing.subagent} onChange={set('subagent')} options={modelOptions(list, routing.subagent, false)} />}
          </Field>
          <Field label="Heartbeat model" hint="Used for scheduled heartbeat checks.">
            {(c) => <Select {...c} value={routing.heartbeat} onChange={set('heartbeat')} options={modelOptions(list, routing.heartbeat, true)} />}
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

  const onSave = () =>
    saver.postJson('heartbeat', '/api/settings/heartbeat', { interval }, {
      success: 'Heartbeat interval saved',
      error: 'Heartbeat interval could not be saved',
    })

  return (
    <Panel title="Heartbeat" description="How often the assistant checks in on its own.">
      <div className={styles.form}>
        <div className={styles.fields}>
          <Field label="Check interval" hint="The current interval is not readable here. Choose one to change it.">
            {(c) => <Select {...c} value={interval} onChange={(e) => setInterval(e.target.value)} options={HEARTBEAT_OPTIONS} />}
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

  const onExport = () => {
    window.location.href = '/api/settings/export'
  }

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target
    const file = input.files?.[0]
    if (!file) return
    setImported(false)
    const formData = new FormData()
    formData.append('config', file)
    const ok = await saver.run(
      'import',
      () => fetch('/api/settings/import', { method: 'POST', body: formData }),
      { success: 'Configuration imported. Restart required.', error: 'Configuration could not be imported' },
    )
    if (ok) setImported(true)
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
        {imported && (
          <Notice tone="warning" title="Restart required">
            The imported configuration takes effect after a restart.
          </Notice>
        )}
      </div>
    </Panel>
  )
}
