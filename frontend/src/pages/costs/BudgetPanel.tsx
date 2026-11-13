import type { FormEvent } from 'react'
import { AnalogBar, Button, Field, Panel, Switch, TextInput } from '../../components/ui'
import type { AnalogLimit } from '../../components/ui'
import type { UiState } from '../../lib/state'
import { StaleWriteNote } from '../../components/StaleWriteNote'
import { formatCurrency } from './lib'
import styles from './BudgetPanel.module.css'

interface BudgetPanelProps {
  /** Saved monthly cap; null = no budget. */
  budget: number | null
  budgetInput: string
  setBudgetInput: (v: string) => void
  /** The explicit "no budget" choice: saving it removes the cap (sends null). */
  noBudget: boolean
  setNoBudget: (v: boolean) => void
  saveBudget: () => void
  savingBudget: boolean
  canSaveBudget: boolean
  budgetError: string | null
  /** The last save went through, but the server's follow-up reading is not confirmed yet. */
  catchingUp?: boolean
  /** Used share of the cap (1 = 100%); null when tracked coverage is incomplete. */
  budgetUsage: number | null
  budgetUsagePct: number | null
  budgetRemaining: number | null
  monthlyBudgetBase: number | null
  /** Names the month the bar is about ("July 2026 tracked spend"). */
  spendLabel: string
}

/** The share of the budget at which the bar turns to caution. */
const BUDGET_WARNING_SHARE = 0.7

/** Normal up to the warning share, caution above it, critical once the budget is exceeded. */
function budgetState(usage: number): UiState {
  if (usage > 1) return 'critical'
  if (usage > BUDGET_WARNING_SHARE) return 'warning'
  return 'healthy'
}

/** The scale always shows the budget with room to spare, and grows to hold a spend that exceeds it. */
function scaleMax(budget: number, spend: number | null): number {
  return Math.max(budget * 1.25, (spend ?? 0) * 1.1)
}

export default function BudgetPanel({
  budget,
  budgetInput,
  setBudgetInput,
  noBudget,
  setNoBudget,
  saveBudget,
  savingBudget,
  canSaveBudget,
  budgetError,
  catchingUp = false,
  budgetUsage,
  budgetUsagePct,
  budgetRemaining,
  monthlyBudgetBase,
  spendLabel,
}: BudgetPanelProps) {
  const progressKnown = budget !== null && monthlyBudgetBase !== null && budgetUsage !== null
    && budgetRemaining !== null && budgetUsagePct !== null

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (canSaveBudget) saveBudget()
  }

  const limits = (cap: number, max: number): AnalogLimit[] => [
    0,
    { value: cap * BUDGET_WARNING_SHARE, label: `${Math.round(BUDGET_WARNING_SHARE * 100)}%` },
    { value: cap, label: formatCurrency(cap) },
    { value: max, label: formatCurrency(max) },
  ]

  let progress = null
  if (progressKnown) {
    const max = scaleMax(budget, monthlyBudgetBase)
    progress = (
      <>
        <AnalogBar
          label={spendLabel}
          value={monthlyBudgetBase}
          min={0}
          max={max}
          band={[0, budget]}
          limits={limits(budget, max)}
          format={formatCurrency}
          state={budgetState(budgetUsage)}
        />
        <p className={styles.muted}>
          {budgetUsagePct}% used ·{' '}
          {budgetRemaining >= 0
            ? `${formatCurrency(budgetRemaining)} left`
            : `${formatCurrency(Math.abs(budgetRemaining))} over`}
        </p>
      </>
    )
  } else if (budget !== null) {
    // The reading is missing, not zero: the hollow mark and the reason, no pointer.
    progress = (
      <>
        <AnalogBar
          label={spendLabel}
          value={null}
          unread
          min={0}
          max={scaleMax(budget, null)}
          band={[0, budget]}
          format={formatCurrency}
        />
        <p className={styles.muted}>Progress is hidden until billing coverage for the period is complete.</p>
      </>
    )
  } else if (!noBudget) {
    // "No monthly budget" is said once, by the switch below. Only an unsaved edit needs words.
    progress = <p className={styles.muted}>No cap is saved yet.</p>
  }

  return (
    <Panel
      title="Budget"
      meta={budget !== null ? `${formatCurrency(budget)} a month` : undefined}
      description="Monthly cap on tracked spend."
      id="usage-budget"
    >
      <div className={styles.split}>
        {progress && <div className={styles.progress}>{progress}</div>}

        <form className={styles.form} onSubmit={onSubmit}>
          <div className={styles.formRow}>
            <Field label="Monthly budget (USD)" error={budgetError}>
              {control => (
                <TextInput
                  {...control}
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={noBudget ? '' : budgetInput}
                  onChange={event => setBudgetInput(event.target.value)}
                  disabled={noBudget}
                  placeholder={noBudget ? undefined : 'Enter an amount'}
                />
              )}
            </Field>
            <Button type="submit" variant="primary" disabled={!canSaveBudget} loading={savingBudget}>
              Save
            </Button>
          </div>
          <Switch checked={noBudget} onChange={setNoBudget} label="No monthly budget" aria-label="No monthly budget" />
          <StaleWriteNote show={catchingUp} />
        </form>
      </div>
    </Panel>
  )
}
