/** Version 1 of GET /api/gbrain/synoptic; all timestamps are ISO 8601 or null. */
export type State = 'healthy' | 'warning' | 'critical' | 'unavailable' | 'inactive';
export interface Evidence { state: State; observedAt: string | null }
export interface Measurement<T = number> extends Evidence { value: T | null; unit: string }
export interface Source extends Evidence {
  id: string; label: string; lastSyncAt: string | null;
  behind: number | null; excludedByPolicy: boolean; reason: string | null;
  syncTracked: boolean; ageHours: number | null; thresholdHours: number;
}
export interface SourceGroup extends Evidence { id: string; label: string; items: Source[] }
export interface Reader extends Evidence {
  id: string; label: string;
  /** Config reads cannot prove an observed connection. 'observed' is reserved for real telemetry. */
  observation: 'configured' | 'observed' | 'not_configured' | 'unreadable';
  integration: Evidence & { configured: boolean | null; evidence: string };
}
export interface MeasuredEdge extends Evidence {
  from: string; to: string; label: string; unit: string; measurement: Measurement;
}
/** Configuration evidence only; connection/call telemetry is not observed. */
export interface ReaderIntegrationEdge extends Evidence {
  from: string; to: string; label: 'configured'; unit?: never; measurement?: never;
}
export type Edge = MeasuredEdge | ReaderIntegrationEdge;
export interface VerdictReason { elementId: string; state: State; text: string }
export interface Verdict { state: State; reasons: VerdictReason[] }
export interface GBrainSynoptic {
  schemaVersion: '1'; state: State; verdict: Verdict;
  core: Evidence & {
    version: Measurement<string>; pages: Measurement; chunks: Measurement; embedded: Measurement;
    quality: Measurement & { components: Array<Measurement & { id: string }> };
  };
  sources: SourceGroup[]; sourcesState: State;
  queue: Evidence & { waiting: Measurement; active: Measurement; stalled: Measurement };
  readers: Reader[]; readersState: State;
  readersNote: 'connection telemetry is not observable locally'; edges: Edge[];
}
export interface Meta {
  ok: boolean; stale: boolean; observedAt: string | null; ageMs: number | null;
  error: { code: string; message: string } | null; latencyMs: number | null; source: string;
}
export interface Envelope<T> { data: T | null; meta: Meta }
export type SynopticEnvelope = Envelope<GBrainSynoptic>;
