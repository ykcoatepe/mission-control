import styles from './LoadingSpinner.module.css'

export default function LoadingSpinner() {
  return (
    <div className={styles.wrap} role="status" aria-label="Loading">
      <div className={styles.spinner} />
    </div>
  )
}
