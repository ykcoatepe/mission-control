import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff } from 'lucide-react'
import {
  Button,
  ErrorState,
  Field,
  IconButton,
  Mono,
  Notice,
  Page,
  Panel,
  Skeleton,
  StatePill,
  TextInput,
} from '../components/ui'
import { describeApiError, postJson, useApi } from '../lib/hooks'
import { buildSetupPayload, detectedLines, gatewayLines, nameError, suggestName } from './setup/lib'
import type { SetupStatus } from './setup/lib'
import styles from './Setup.module.css'

type Step = 'detect' | 'configure' | 'done'

/**
 * A step change unmounts the button that was just pressed, which would drop focus to the page.
 * The new step takes it: the first field when it has one (`data-autofocus`), else its first control.
 */
function useFocusOnMount(ref: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const root = ref.current
    const target =
      root?.querySelector<HTMLElement>('[data-autofocus]') ?? root?.querySelector<HTMLElement>('input, button, select, textarea')
    target?.focus()
  }, [ref, enabled])
}

/** Queries that read `/api/setup`: the shell redirects here while it says setup is needed. */
const SETUP_QUERY_KEY = ['api', '/api/setup']

export default function Setup() {
  const status = useApi<SetupStatus>('/api/setup')
  const [step, setStep] = useState<Step>('detect')
  // Focus moves only after the person has moved between steps, never on the first load.
  const [moved, setMoved] = useState(false)
  const go = (next: Step) => {
    setMoved(true)
    setStep(next)
  }

  return (
    // /setup renders without the top bar, so this page carries its own h1.
    <Page title="Set up Mission Control" width="narrow">
      <div className={styles.frame}>
        <header className={styles.head}>
          <h1 className={styles.title}>Set up Mission Control</h1>
          <p className={styles.lead}>
            Name the dashboard and, if the gateway needs it, give it the token. Everything else is read from this machine.
          </p>
        </header>

        {status.loading ? (
          <Skeleton variant="block" label="Reading this machine" />
        ) : status.error || !status.data ? (
          <ErrorState
            title="This machine could not be read"
            message={status.error ?? 'No setup reading was returned.'}
            onRetry={status.refetch}
          />
        ) : step === 'detect' ? (
          <DetectStep status={status.data} onContinue={() => go('configure')} takeFocus={moved} />
        ) : step === 'configure' ? (
          <ConfigureStep status={status.data} onBack={() => go('detect')} onSaved={() => go('done')} />
        ) : (
          <DoneStep />
        )}
      </div>
    </Page>
  )
}

interface CatalogModel {
  id: string
  name?: string
}

function DetectStep({ status, onContinue, takeFocus }: { status: SetupStatus; onContinue: () => void; takeFocus: boolean }) {
  const frame = useRef<HTMLDivElement>(null)
  useFocusOnMount(frame, takeFocus)
  // The catalog gives the model its readable name (as Settings shows it); without it the id is shown.
  const catalog = useApi<CatalogModel[]>('/api/models')
  const modelNames = useMemo<Record<string, string>>(() => {
    const names: Record<string, string> = {}
    if (Array.isArray(catalog.data)) {
      for (const model of catalog.data) {
        if (model && typeof model.id === 'string' && typeof model.name === 'string' && model.name) names[model.id] = model.name
      }
    }
    return names
  }, [catalog.data])
  const gateway = gatewayLines(status)
  const detected = detectedLines(status, modelNames)
  return (
    <div ref={frame} className={styles.step}>
      <Panel title="OpenClaw gateway" description="What this machine reports. Reachability is checked on the Services page.">
        <dl className={styles.rows}>
          {gateway.map((line) => (
            <div key={line.label} className={styles.row}>
              <dt className={styles.rowLabel}>{line.label}</dt>
              <dd className={styles.rowValue}>
                {line.state ? <StatePill state={line.state} label={line.value} /> : <Mono truncate>{line.value}</Mono>}
              </dd>
            </div>
          ))}
        </dl>
      </Panel>

      {detected.length > 0 && (
        <Panel title="Detected configuration">
          <dl className={styles.rows}>
            {detected.map((line) => (
              <div key={line.label} className={styles.row}>
                <dt className={styles.rowLabel}>{line.label}</dt>
                <dd className={styles.rowValue}>
                  <Mono truncate>{line.value}</Mono>
                </dd>
              </div>
            ))}
          </dl>
        </Panel>
      )}

      <div className={styles.actions}>
        <Button variant="primary" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}

function ConfigureStep({ status, onBack, onSaved }: { status: SetupStatus; onBack: () => void; onSaved: () => void }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState(() => suggestName(status))
  // Never pre-filled: the server does not send the token, and nothing here may echo one.
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  useFocusOnMount(form)
  const tokenConfigured = status.detectedConfig?.gatewayTokenConfigured === true
  const invalidName = nameError(name)

  const save = async () => {
    if (saving || invalidName) return
    setSaving(true)
    setFailure(null)
    try {
      await postJson('/api/setup', buildSetupPayload({ name, token }))
    } catch (error) {
      // Nothing was saved: say so, and stay here.
      setFailure(describeApiError(error, 'The settings could not be saved.'))
      setSaving(false)
      return
    }
    // The shell sends people here while its cached reading says setup is needed: refresh that
    // reading first, so leaving the page does not bounce straight back.
    await queryClient.invalidateQueries({ queryKey: SETUP_QUERY_KEY })
    onSaved()
  }

  return (
    <Panel title="Configure" description="Two settings. Both can be changed later.">
      <form
        ref={form}
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        {failure && (
          <Notice tone="critical" title="Nothing was saved">
            {failure}
          </Notice>
        )}

        <Field label="Dashboard name" hint="Required." error={name.length > 0 ? invalidName : null}>
          {(control) => (
            <TextInput
              {...control}
              data-autofocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Name this dashboard"
              maxLength={200}
            />
          )}
        </Field>

        <Field
          label="Gateway token"
          hint={
            tokenConfigured
              ? 'A token is already configured locally. Leave this empty to keep it.'
              : 'Only needed if the gateway asks for one. It is stored in this dashboard\'s configuration and never shown again.'
          }
        >
          {(control) => (
            <div className={styles.secret}>
              <TextInput
                {...control}
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(event) => setToken(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder={tokenConfigured ? 'Keep the configured token' : 'Paste the gateway token'}
              />
              <IconButton
                variant="secondary"
                label={showToken ? 'Hide token' : 'Show token'}
                pressed={showToken}
                icon={showToken ? <EyeOff size={16} /> : <Eye size={16} />}
                onClick={() => setShowToken((shown) => !shown)}
              />
            </div>
          )}
        </Field>

        <div className={styles.actions}>
          <Button onClick={onBack} disabled={saving}>
            Back
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={Boolean(invalidName)}>
            Save and finish
          </Button>
        </div>
      </form>
    </Panel>
  )
}

function DoneStep() {
  const navigate = useNavigate()
  const body = useRef<HTMLDivElement>(null)
  useFocusOnMount(body)
  return (
    <Panel title="Setup saved">
      <div ref={body} className={styles.form}>
        <p className={styles.lead}>The settings were saved. The dashboard is ready.</p>
        <div className={styles.actions}>
          <Button variant="primary" onClick={() => navigate('/')}>
            Open the dashboard
          </Button>
        </div>
      </div>
    </Panel>
  )
}
