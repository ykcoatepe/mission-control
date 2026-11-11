import type { FormEvent } from 'react'
import { Button, Field, Meter, Mono, Panel, Switch, TextInput } from '../../components/ui'
import type { UiState } from '../../lib/state'
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
  /** Used share of the cap (1 = 100%); null when tracked coverage is incomplete. */
  budgetUsage: number | null
  budgetUsagePct: number | null
  budgetRemaining: number | null
  monthlyBudgetBase: number | null
  /** Names the month the bar is about ("July 2026 tracked spend"). */
  spendLabel: string
}

function meterState(usage: number): UiState {
  if (usage > 0.9) return 'critical'
  if (usage > 0.7) return 'warning'
  return 'healthy'
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

  return (
    <Panel title="Budget" description="Monthly cap on tracked spend.">
      <div className={styles.body}>
        <div className={styles.progress}>
          {progressKnown ? (
            <>
              <div className={styles.progressLine}>
                <span className={styles.progressLabel}>{spendLabel}</span>
                <Mono>
                  {formatCurrency(monthlyBudgetBase)} of {formatCurrency(budget)}
                </Mono>
              </div>
              <Meter
                label="Budget used"
                value={budgetUsagePct}
                state={meterState(budgetUsage)}
              />
              <div className={styles.progressLine}>
                <span className={styles.muted}>{budgetUsagePct}% used</span>
                <span className={styles.muted}>
                  {budgetRemaining >= 0
                    ? `${formatCurrency(budgetRemaining)} left`
                    : `${formatCurrency(Math.abs(budgetRemaining))} over`}
                </span>
              </div>
            </>
          ) : budget !== null ? (
            <>
              <Meter label="Budget used" value={null} />
              <p className={styles.muted}>
                Progress is hidden until billing coverage for the period is complete.
              </p>
            </>
          ) : (
            <p className={styles.muted}>No monthly cap set.</p>
          )}
        </div>

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
                  placeholder={noBudget ? 'No budget' : 'Enter an amount'}
                />
              )}
            </Field>
            <Button type="submit" variant="primary" disabled={!canSaveBudget} loading={savingBudget}>
              Save
            </Button>
          </div>
          <Switch checked={noBudget} onChange={setNoBudget} label="No monthly budget" />
        </form>
      </div>
    </Panel>
  )
}
