import { Freshness } from '../../components/ui'

interface ReadingAgeProps {
  observedAt: string | null | undefined
  /** The server flagged this reading as the last good one. */
  stale: boolean
}

/**
 * Where this page's reading came from, only when that matters (HMI rule 8): a flagged or old reading says
 * "as of 12:41", a missing time says "not read", and a fresh reading says nothing.
 */
export default function ReadingAge({ observedAt, stale }: ReadingAgeProps) {
  return <Freshness observedAt={observedAt} state={stale ? 'stale' : undefined} />
}
