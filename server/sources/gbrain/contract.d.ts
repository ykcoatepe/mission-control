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
/**
 * `action`: something a person can do or must look at (warning, critical, a missing reading).
 * `info`: something to know, never a fault: every inactive reason, and a reading limitation such
 * as the embed-job probe. Derived once, in verdict.js. An `info` reason never counts toward `Verdict.state`.
 */
export type ReasonKind = 'action' | 'info';
/** `elementId` is the reason's stable identity (never its text); `count` its magnitude when it has one. */
export interface VerdictReason { elementId: string; state: State; text: string; kind: ReasonKind; count?: number }
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

/** POST /api/gbrain/actions, only for recognized R0 diagnostic reports. */
export interface DiagnosticFinding { name: string | null; status: string | null; message: string | null }
export interface DiagnosticResult {
  reportStatus: string | null;
  healthScore: number | null;
  failing: DiagnosticFinding[];
  warning: DiagnosticFinding[];
  /** Observed report counts; optional keys depend on the action's schema. */
  counts: { failing: number; warning: number; checks?: number; issues?: number; pages?: number;
    missingFiles?: number; failingOmitted?: number; warningOmitted?: number };
}
/** Added after a completed action with refreshAfter=true (R0 or W1). */
export interface ActionReadingRefresh {
  observedAt: string | null;
  refreshPending: boolean;
  meta: Meta;
}
export interface CompletedDiagnosticAction extends Partial<ActionReadingRefresh> {
  ok: true; status: 'completed'; outcome: 'clean' | 'findings'; result: DiagnosticResult;
  action: 'doctor-fast' | 'check-resolvable' | 'storage-status';
  mode: 'live-write'; label: string; checkedAt: string; args: string[];
  summary: string; payload: Record<string, unknown>; pending: false; refreshAfter: boolean;
}
