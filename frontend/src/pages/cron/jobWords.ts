/** What the scheduler calls things, in words an operator would use. */

const KIND_WORDS: Record<string, string> = {
  agentturn: 'Agent task',
  systemevent: 'System message',
  command: 'Shell command',
}

const TARGET_WORDS: Record<string, string> = {
  isolated: 'its own session',
  main: 'the main session',
}

export interface RunKind {
  /** Plain-words sentence, or null when the job did not report how it runs. */
  text: string | null
  /** A raw value that has no plain-words form yet; shown quietly in monospace. */
  unknown: string | null
}

/** "Agent task in its own session" from the raw payload kind and session target. */
export function describeRunKind(payload: string | null | undefined, target: string | null | undefined): RunKind {
  const kind = String(payload ?? '').trim()
  const where = String(target ?? '').trim()
  const kindWord = KIND_WORDS[kind.toLowerCase()]
  const whereWord = TARGET_WORDS[where.toLowerCase()]
  const rawKind = kind && kind !== '?' && !kindWord ? kind : null
  const rawWhere = where && !whereWord ? where : null
  const parts = [kindWord, whereWord ? `${kindWord ? 'in ' : 'Runs in '}${whereWord}` : null].filter(Boolean) as string[]
  const unknown = [rawKind, rawWhere].filter(Boolean).join(' · ') || null
  return { text: parts.length ? parts.join(' ') : null, unknown }
}

/** The description of a built-in job is sometimes an internal key such as `__openclaw_memory_core_x__`. */
export function isInternalKey(description: string | null | undefined): boolean {
  return /^__[A-Za-z0-9_]+__$/.test(String(description ?? '').trim())
}

/** The jobs list shortens every description to this many characters (`description.substring(0, 120)`). */
export const LIST_DESCRIPTION_LIMIT = 120

/** A description at the limit was cut by the list; the text stops mid-sentence and says so with an ellipsis. */
export function describeJobText(description: string | null | undefined): { text: string; cut: boolean } {
  const text = String(description ?? '').trim()
  const cut = String(description ?? '').length >= LIST_DESCRIPTION_LIMIT
  return { text, cut }
}

/**
 * Why the last run failed, from what the API reports: the job's own reason, else the newest failed run in its
 * history that has one. null when nothing says why (the drawer then says so).
 */
export function failureReason(job: {
  lastError?: string | null
  history?: Array<{ status?: string; error?: string | null }>
}): string | null {
  const own = String(job.lastError ?? '').trim()
  if (own) return own
  for (const run of job.history ?? []) {
    const reason = String(run?.error ?? '').trim()
    if (reason) return reason
  }
  return null
}
