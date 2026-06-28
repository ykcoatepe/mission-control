import GlassCard from '../../components/GlassCard'
import { formatCurrency } from './lib'
import styles from './BudgetCard.module.css'

interface BudgetCardProps {
  m: boolean
  budget: number
  budgetInput: string
  setBudgetInput: (v: string) => void
  saveBudget: () => void
  savingBudget: boolean
  canSaveBudget: boolean
  budgetError: string | null
  budgetUsagePct: number
  budgetUsage: number
  budgetRemaining: number
  budgetBadgeClass: string
  monthlyBudgetBase: number
}

export default function BudgetCard({
  m,
  budget,
  budgetInput,
  setBudgetInput,
  saveBudget,
  savingBudget,
  canSaveBudget,
  budgetError,
  budgetUsagePct,
  budgetUsage,
  budgetRemaining,
  budgetBadgeClass,
  monthlyBudgetBase,
}: BudgetCardProps) {
  return (
    <GlassCard delay={0.18} noPad>
      <div className={m ? `${styles.inner} ${styles.innerMobile}` : styles.inner}>
        <div className={m ? `${styles.headerRow} ${styles.headerRowMobile}` : styles.headerRow}>
          <div>
            <h3 className={m ? `${styles.title} ${styles.titleMobile}` : styles.title}>
              Budget Guardrail
            </h3>
            <div className={styles.subtitle}>
              Set a monthly cap to keep alerts and runway tracking grounded.
            </div>
          </div>
          <span className={`macos-badge ${budgetBadgeClass}`}>
            {budget > 0 ? `${budgetUsagePct}% used` : 'No cap set'}
          </span>
        </div>

        <div className={m ? `${styles.inputRow} ${styles.inputRowMobile}` : styles.inputRow}>
          <div className={styles.inputGroup}>
            <label className={styles.inputLabel}>
              Monthly budget (USD)
            </label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={budgetInput}
              onChange={e => setBudgetInput(e.target.value)}
              placeholder="Enter budget amount"
              aria-invalid={!!budgetError}
              aria-describedby={budgetError ? 'monthly-budget-error' : undefined}
              className={`macos-input ${styles.inputField}`}
            />
            {budgetError && (
              <div id="monthly-budget-error" className={styles.inputError}>
                {budgetError}
              </div>
            )}
          </div>

          <button
            onClick={saveBudget}
            disabled={!canSaveBudget}
            className={`macos-button ${canSaveBudget ? 'macos-button-primary' : ''} ${styles.saveBtn}`}
            style={{
              cursor: canSaveBudget ? 'pointer' : 'not-allowed',
              opacity: canSaveBudget ? 1 : 0.5,
            }}
          >
            {savingBudget ? 'Saving...' : 'Save'}
          </button>
        </div>

        {budget > 0 ? (
          <div className={styles.progressSection}>
            <div className={styles.progressHeader}>
              <span className={styles.progressHeaderLabel}>Current spend vs budget</span>
              <span className={styles.progressHeaderValue}>
                {formatCurrency(monthlyBudgetBase)} / {formatCurrency(budget)}
              </span>
            </div>

            <div className={styles.progressTrack}>
              <div
                className={styles.progressFill}
                style={{
                  width: `${Math.min((monthlyBudgetBase / budget) * 100, 100)}%`,
                  background: budgetUsage > 0.9 ? '#FF453A' : budgetUsage > 0.7 ? '#FF9500' : '#32D74B',
                }}
              />
            </div>

            <div className={styles.progressFooter}>
              <span className={styles.progressFooterLabel}>{budgetUsagePct}% used</span>
              <span className={styles.progressFooterLabel}>{formatCurrency(budgetRemaining)} remaining</span>
            </div>
          </div>
        ) : (
          <div className={m ? `${styles.noBudgetBox} ${styles.noBudgetBoxMobile}` : `${styles.noBudgetBox} ${styles.noBudgetBoxDesktop}`}>
            <div className={styles.noBudgetTitle}>No monthly cap configured</div>
            <div className={styles.noBudgetSubtitle}>
              Add a budget to get progress tracking and early spend alerts.
            </div>
          </div>
        )}
      </div>
    </GlassCard>
  )
}
