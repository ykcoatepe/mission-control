/** Version 1 of GET /api/gbrain/synoptic; all timestamps are ISO 8601 or null. */
export type State = 'healthy' | 'warning' | 'critical' | 'unavailable' | 'inactive';
export interface Evidence { state: State; observedAt: string | null }
export interface Measurement<T = number> extends Evidence { value: T | null; unit: string }
export interface Source extends Evidence {
  id: string; label: string; lastSyncAt: string | null;
  behind: number | null; excludedByPolicy: boolean | null;
}
export interface SourceGroup extends Evidence { id: string; label: string; items: Source[] }
export interface Reader extends Evidence {
  id: string; label: string;
  integration: Evidence & { configured: boolean | null; evidence: string };
  connection: Evidence;
}
export interface Edge extends Evidence {
  from: string; to: string; label: string; unit: string; measurement: Measurement;
}
export interface GBrainSynoptic {
  schemaVersion: '1'; state: State;
  core: Evidence & {
    version: Measurement<string>; pages: Measurement; chunks: Measurement; embedded: Measurement;
    quality: Measurement & { components: Array<Measurement & { id: string }> };
  };
  sources: SourceGroup[]; sourcesState: State;
  queue: Evidence & { waiting: Measurement; active: Measurement; stalled: Measurement };
  readers: Reader[]; readersState: State; edges: Edge[];
}
export interface Meta {
  ok: boolean; stale: boolean; observedAt: string | null; ageMs: number | null;
  error: { code: string; message: string } | null; latencyMs: number | null; source: string;
}
export interface Envelope<T> { data: T | null; meta: Meta }
export type SynopticEnvelope = Envelope<GBrainSynoptic>;
