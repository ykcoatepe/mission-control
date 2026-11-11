import { useState } from 'react'
import { Button, Dialog, Field, Select, TextInput } from '../../components/ui'
import type { CalendarEntry } from './scheduleLib'
import { ASSIGNEE_OPTIONS, SOURCE_OPTIONS, STATUS_OPTIONS, toInputDateTime } from './scheduleLib'
import styles from './EntryDialog.module.css'

interface EntryDialogProps {
  entry: CalendarEntry | null
  onClose: () => void
  onSave: (payload: Partial<CalendarEntry>) => Promise<void>
}

const FORM_ID = 'schedule-entry-form'

const toOptions = (values: string[]) => values.map((value) => ({ value, label: value }))

/** Create or edit a schedule entry. Mount it only while it is open: the form starts from `entry`. */
export default function EntryDialog({ entry, onClose, onSave }: EntryDialogProps) {
  const [form, setForm] = useState<Partial<CalendarEntry>>(
    entry ?? { status: 'scheduled', source: 'manual', assignee: 'Mudur' },
  )
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (saving) return
    setSaving(true)
    try {
      await onSave(form)
      onClose()
    } catch {
      // The caller already reported the failure; keep the form open for another try.
    } finally {
      setSaving(false)
    }
  }

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
        <Field label="Title">
          {(control) => (
            <TextInput
              {...control}
              data-autofocus
              value={form.title || ''}
              onChange={(event) => setForm((prev) => ({ ...prev, title: event.target.value }))}
            />
          )}
        </Field>

        <div className={styles.pair}>
          <Field label="Starts at">
            {(control) => (
              <TextInput
                {...control}
                type="datetime-local"
                value={toInputDateTime(form.startsAt)}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    startsAt: event.target.value ? new Date(event.target.value).toISOString() : null,
                  }))
                }
              />
            )}
          </Field>
          <Field label="Cron schedule (optional)">
            {(control) => (
              <TextInput
                {...control}
                className={styles.mono}
                value={form.schedule || ''}
                onChange={(event) => setForm((prev) => ({ ...prev, schedule: event.target.value }))}
                placeholder="0 8 * * *"
              />
            )}
          </Field>
        </div>

        <div className={styles.triple}>
          <Field label="Status">
            {(control) => (
              <Select
                {...control}
                options={toOptions(STATUS_OPTIONS)}
                value={form.status || 'scheduled'}
                onChange={(event) => setForm((prev) => ({ ...prev, status: event.target.value }))}
              />
            )}
          </Field>
          <Field label="Assignee">
            {(control) => (
              <Select
                {...control}
                options={toOptions(ASSIGNEE_OPTIONS)}
                value={form.assignee || 'Mudur'}
                onChange={(event) => setForm((prev) => ({ ...prev, assignee: event.target.value }))}
              />
            )}
          </Field>
          <Field label="Source">
            {(control) => (
              <Select
                {...control}
                options={toOptions(SOURCE_OPTIONS)}
                value={form.source || 'manual'}
                onChange={(event) => setForm((prev) => ({ ...prev, source: event.target.value }))}
              />
            )}
          </Field>
        </div>

        <div className={styles.pair}>
          <Field label="Linked task id">
            {(control) => (
              <TextInput
                {...control}
                className={styles.mono}
                value={form.linkedTaskId || ''}
                onChange={(event) => setForm((prev) => ({ ...prev, linkedTaskId: event.target.value || null }))}
              />
            )}
          </Field>
          <Field label="Linked job id">
            {(control) => (
              <TextInput
                {...control}
                className={styles.mono}
                value={form.linkedJobId || ''}
                onChange={(event) => setForm((prev) => ({ ...prev, linkedJobId: event.target.value || null }))}
              />
            )}
          </Field>
        </div>

        <Field label="Notes">
          {(control) => (
            <textarea
              {...control}
              className={styles.textarea}
              rows={3}
              value={form.notes || ''}
              onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
            />
          )}
        </Field>
      </form>
    </Dialog>
  )
}
