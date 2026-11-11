import { useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Dialog, Field, Notice, Select, TextInput } from '../../components/ui'
import { CRON_PRESETS } from './lib'
import type { CreateCronJobPayload, ModelOption } from './types'
import styles from './CreateJobDialog.module.css'

interface CreateJobDialogProps {
  open: boolean
  onClose: () => void
  onSubmit: (job: CreateCronJobPayload) => Promise<void>
  modelOptions: ModelOption[]
}

const FORM_ID = 'create-automation-form'

const SESSION_TARGETS = [
  { value: 'isolated', label: 'Its own session' },
  { value: 'main', label: 'The main session' },
]

const PAYLOAD_TYPES = [
  { value: 'agentTurn', label: 'Ask the agent' },
  { value: 'systemEvent', label: 'Send a system message' },
]

const EMPTY_FORM = {
  name: '',
  schedule: '',
  sessionTarget: 'isolated',
  payloadType: 'agentTurn',
  message: '',
  model: '',
}

export default function CreateJobDialog({ open, onClose, onSubmit, modelOptions }: CreateJobDialogProps) {
  const [formError, setFormError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [formData, setFormData] = useState(EMPTY_FORM)

  const close = () => {
    if (isSubmitting) return
    setFormError(null)
    setFormData(EMPTY_FORM)
    onClose()
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (isSubmitting) return
    setFormError(null)

    if (!formData.name || !formData.schedule || !formData.message) {
      setFormError('Name, schedule, and message are required')
      return
    }

    const job: CreateCronJobPayload = {
      name: formData.name,
      schedule: {
        kind: 'cron',
        expr: formData.schedule,
      },
      sessionTarget: formData.sessionTarget,
      payload: {
        kind: formData.payloadType,
        message: formData.message,
        ...(formData.payloadType === 'agentTurn' && formData.model ? { model: formData.model } : {}),
      },
      enabled: true,
    }

    setIsSubmitting(true)
    try {
      await onSubmit(job)
      setFormData(EMPTY_FORM)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      size="md"
      title="Create automation"
      actions={
        <>
          <Button onClick={close} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} variant="primary" loading={isSubmitting}>
            {isSubmitting ? 'Creating' : 'Create'}
          </Button>
        </>
      }
    >
      <form id={FORM_ID} onSubmit={handleSubmit} className={styles.form}>
        <Field label="Name">
          {(control) => (
            <TextInput
              {...control}
              data-autofocus
              value={formData.name}
              onChange={(event) => setFormData((prev) => ({ ...prev, name: event.target.value }))}
              placeholder="e.g. Check emails"
            />
          )}
        </Field>

        <Field label="Schedule" hint="Five fields: minute, hour, day of month, month, day of week. * means any.">
          {(control) => (
            <>
              <TextInput
                {...control}
                className={styles.mono}
                value={formData.schedule}
                onChange={(event) => setFormData((prev) => ({ ...prev, schedule: event.target.value }))}
                placeholder="0 8 * * *"
              />
              <div className={styles.presets}>
                {CRON_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    size="sm"
                    variant="ghost"
                    onClick={() => setFormData((prev) => ({ ...prev, schedule: preset.expr }))}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </>
          )}
        </Field>

        <div className={styles.pair}>
          <Field label="Where it runs">
            {(control) => (
              <Select
                {...control}
                options={SESSION_TARGETS}
                value={formData.sessionTarget}
                onChange={(event) => setFormData((prev) => ({ ...prev, sessionTarget: event.target.value }))}
              />
            )}
          </Field>
          <Field label="What it does">
            {(control) => (
              <Select
                {...control}
                options={PAYLOAD_TYPES}
                value={formData.payloadType}
                onChange={(event) => setFormData((prev) => ({ ...prev, payloadType: event.target.value }))}
              />
            )}
          </Field>
        </div>

        <Field label="Message">
          {(control) => (
            <textarea
              {...control}
              className={styles.textarea}
              rows={3}
              value={formData.message}
              onChange={(event) => setFormData((prev) => ({ ...prev, message: event.target.value }))}
              placeholder="Task description or prompt"
            />
          )}
        </Field>

        {formData.payloadType === 'agentTurn' && (
          <Field label="Model (optional)">
            {(control) => (
              <Select
                {...control}
                options={modelOptions.map((option) => ({ value: option.value, label: option.label }))}
                value={formData.model}
                onChange={(event) => setFormData((prev) => ({ ...prev, model: event.target.value }))}
              />
            )}
          </Field>
        )}

        {formError && <Notice tone="critical">{formError}</Notice>}
      </form>
    </Dialog>
  )
}
