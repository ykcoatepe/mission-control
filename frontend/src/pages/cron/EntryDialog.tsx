import { useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { Button, Dialog, Field, Mono, Notice, Select, StatePill, TextInput, TimeAgo } from '../../components/ui'
import { describeApiError } from '../../lib/hooks'
import type { CalendarEntry, EntryForm, OverridableField } from './scheduleLib'
import {
  ASSIGNEE_OPTIONS,
  CREATE_SOURCE_OPTIONS,
  STATUS_OPTIONS,
  buildCreatePayload,
  buildUpdatePatch,
  entryState,
  entryStatusLabel,
  formFromEntry,
  isLinkedEntry,
  isOverridden,
  jobHref,
  scheduleValue,
  sourceLabel,
  toInputDateTime,
} from './scheduleLib'
import { scheduleDisplay } from './cronSchedule'
import { isInternalKey } from './jobWords'
import styles from './EntryDialog.module.css'

/** What the dialog asks the schedule view to send. The id of an update is in the URL, never in a body. */
export type EntryChange =
  | { kind: 'create'; payload: Record<string, unknown> }
  | { kind: 'update'; id: string; patch: Record<string, unknown> }

interface EntryDialogProps {
  entry: CalendarEntry | null
  /** Throws when the server refuses; the dialog shows the server's message and stays open. */
  onSave: (change: EntryChange) => Promise<void>
  onClose: () => void
}

const FORM_ID = 'schedule-entry-form'

const toOptions = (values: string[], label: (value: string) => string = (value) => value) =>
  values.map((value) => ({ value, label: label(value) }))

/** Create a manual entry, or edit one. Mount it only while it is open: the form starts from `entry`. */
export default function EntryDialog({ entry, onClose, onSave }: EntryDialogProps) {
  const linked = entry !== null && isLinkedEntry(entry)
  const [form, setForm] = useState<EntryForm>(() => formFromEntry(entry))
  // Linked fields the person asked to hand back to the schedule; saved as null.
  const [reset, setReset] = useState<ReadonlySet<string>>(() => new Set())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const edit = (patch: Partial<EntryForm>) => {
    setError(null)
    setForm((prev) => ({ ...prev, ...patch }))
  }

  const editOverridable = (field: OverridableField, value: string) => {
    setReset((prev) => {
      if (!prev.has(field)) return prev
      const next = new Set(prev)
      next.delete(field)
      return next
    })
    edit({ [field]: value })
  }

  const resetField = (field: OverridableField) => {
    const derived = entry ? scheduleValue(entry, field) : null
    setReset((prev) => new Set(prev).add(field))
    if (derived !== null) edit({ [field]: derived })
    else setError(null)
  }

  const submit = async () => {
    if (saving) return
    if (!entry && !form.title.trim()) {
      setError('Give the entry a title.')
      return
    }
    const change: EntryChange = entry
      ? { kind: 'update', id: entry.id, patch: buildUpdatePatch(entry, form, reset) }
      : { kind: 'create', payload: buildCreatePayload(form) }
    if (change.kind === 'update' && Object.keys(change.patch).length === 0) {
      onClose()
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onSave(change)
      onClose()
    } catch (failure) {
      setError(describeApiError(failure, 'The entry could not be saved.'))
    } finally {
      setSaving(false)
    }
  }

  /** Hint and reset control under a field the schedule normally fills in. */
  const overrideHint = (field: OverridableField) => {
    if (!entry || !linked || !isOverridden(entry, field) || reset.has(field)) return undefined
    const derived = scheduleValue(entry, field)
    return (
      <span className={styles.override}>
        Changed by you{derived !== null ? <>. Schedule value: <Mono>{derived || 'empty'}</Mono></> : ''}.{' '}
        <Button size="sm" variant="ghost" onClick={() => resetField(field)}>
          Reset to schedule value
        </Button>
      </span>
    )
  }

  const fieldHint = (field: OverridableField) =>
    reset.has(field) ? 'Will return to the schedule value when you save.' : overrideHint(field)

  const state = entry ? entryState(entry.status) : null
  const href = entry ? jobHref(entry) : null

  return (
    <Dialog
      open
      size="md"
      onClose={() => {
        if (!saving) onClose()
      }}
      title={entry ? 'Edit schedule entry' : 'New schedule entry'}
      actions={
        <>
          <Button onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} variant="primary" loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <form
        id={FORM_ID}
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {error && (
          <Notice tone="critical" title="Not saved">
            {error}
          </Notice>
        )}

        {linked && entry && (
          <Notice tone="info" title="Status and next run come from the scheduler">
            {href ? (
              <>
                To turn this job on or off, use its switch in <Link to={href}>Automations, Jobs</Link>.
              </>
            ) : (
              'To turn this job on or off, use its switch in Automations, Jobs.'
            )}
          </Notice>
        )}

        <Field label="Title" hint={fieldHint('title')}>
          {(control) => (
            <TextInput
              {...control}
              data-autofocus
              value={form.title}
              onChange={(event) => (linked ? editOverridable('title', event.target.value) : edit({ title: event.target.value }))}
            />
          )}
        </Field>

        <div className={styles.pair}>
          {linked && entry ? (
            <ReadOnly label="Next run">
              {entry.startsAt ? <TimeAgo value={entry.startsAt} /> : 'Not scheduled'}
            </ReadOnly>
          ) : (
            <Field label="Starts at">
              {(control) => (
                <TextInput
                  {...control}
                  type="datetime-local"
                  value={toInputDateTime(form.startsAt)}
                  onChange={(event) =>
                    edit({ startsAt: event.target.value ? new Date(event.target.value).toISOString() : null })
                  }
                />
              )}
            </Field>
          )}
          {linked ? (
            // The scheduler owns a linked entry's schedule: editing it here would not change the real job.
            // A schedule someone overrode earlier can still be handed back.
            <ReadOnly label="Cron schedule">
              {scheduleDisplay(form.schedule).raw ? <Mono>{form.schedule}</Mono> : scheduleDisplay(form.schedule).text}
              {fieldHint('schedule')}
            </ReadOnly>
          ) : (
            <Field label="Cron schedule (optional)">
              {(control) => (
                <TextInput
                  {...control}
                  className={styles.mono}
                  value={form.schedule}
                  onChange={(event) => edit({ schedule: event.target.value })}
                  placeholder="0 8 * * *"
                />
              )}
            </Field>
          )}
        </div>

        <div className={styles.triple}>
          {linked && entry ? (
            <ReadOnly label="Status">
              {state ? <StatePill state={state} label={entryStatusLabel(entry.status)} /> : entryStatusLabel(entry.status)}
            </ReadOnly>
          ) : (
            <Field label="Status">
              {(control) => (
                <Select
                  {...control}
                  options={toOptions(STATUS_OPTIONS, entryStatusLabel)}
                  value={form.status}
                  onChange={(event) => edit({ status: event.target.value })}
                />
              )}
            </Field>
          )}
          <Field label="Assignee" hint={fieldHint('assignee')}>
            {(control) => (
              <Select
                {...control}
                options={toOptions(ASSIGNEE_OPTIONS)}
                value={form.assignee}
                onChange={(event) => (linked ? editOverridable('assignee', event.target.value) : edit({ assignee: event.target.value }))}
              />
            )}
          </Field>
          {entry ? (
            <ReadOnly label="Source">{sourceLabel(entry.source)}</ReadOnly>
          ) : (
            <Field label="Source">
              {(control) => (
                <Select
                  {...control}
                  options={toOptions(CREATE_SOURCE_OPTIONS, sourceLabel)}
                  value={form.source}
                  onChange={(event) => edit({ source: event.target.value })}
                />
              )}
            </Field>
          )}
        </div>

        {entry ? (
          (entry.linkedJobId || entry.linkedTaskId) && (
            <div className={styles.pair}>
              {entry.linkedTaskId && (
                <ReadOnly label="Linked task">
                  <Mono>{entry.linkedTaskId}</Mono>
                </ReadOnly>
              )}
              {entry.linkedJobId && (
                <ReadOnly label="Linked job">
                  <Mono>{entry.linkedJobId}</Mono>
                </ReadOnly>
              )}
            </div>
          )
        ) : (
          <Field label="Linked task id (optional)">
            {(control) => (
              <TextInput
                {...control}
                className={styles.mono}
                value={form.linkedTaskId}
                onChange={(event) => edit({ linkedTaskId: event.target.value })}
              />
            )}
          </Field>
        )}

        <Field
          label="Notes"
          hint={
            isInternalKey(form.notes) && !isOverridden(entry ?? { userOverrides: [] }, 'notes')
              ? 'This is the scheduler’s internal name for a built-in job. It has no description.'
              : fieldHint('notes')
          }
        >
          {(control) => (
            <textarea
              {...control}
              className={styles.textarea}
              rows={3}
              value={form.notes}
              onChange={(event) => (linked ? editOverridable('notes', event.target.value) : edit({ notes: event.target.value }))}
            />
          )}
        </Field>
      </form>
    </Dialog>
  )
}

function ReadOnly({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.readOnly}>
      <span className={styles.readOnlyLabel}>{label}</span>
      <span className={styles.readOnlyValue}>{children}</span>
    </div>
  )
}
