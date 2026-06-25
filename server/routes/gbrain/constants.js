'use strict';

const AUDIT_REPORT_PATH = '~/hermes-workspace/reports/gbrain-full-audit-20260524.md';
const DESIGN_HANDOFF_PATH = 'docs/gbrain-hybrid-brain-view-handoff-20260524.md';
const AUDIT_VERIFIED_AT = '2026-05-24T00:00:00.000Z';
const DEFAULT_COMMAND_TIMEOUT_MS = 7000;
const DEFAULT_SOURCE_FRESHNESS_HOURS = 24;
const SOURCE_FRESHNESS_THRESHOLDS_HOURS = {
  missioncontrol: 12,
  missionControl: 12,
  clawd: 24,
  hermes: 24,
  hermesagent: 24,
  openclaw: 24,
  codex: 48,
  codexmemories: 48,
  default: DEFAULT_SOURCE_FRESHNESS_HOURS,
};
const REQUIRED_GBRAIN_TOOLS = [
  { id: 'get_page', label: 'get_page', mode: 'read', purpose: 'Read shared memory pages by slug.' },
  { id: 'put_page', label: 'put_page', mode: 'write', purpose: 'Write curated shared-memory pages, never raw transcripts.' },
  { id: 'query', label: 'query', mode: 'read', purpose: 'Use hybrid search as the default shared recall surface.' },
  { id: 'recall', label: 'recall', mode: 'read', purpose: 'Read hot facts for cross-system memory recall.' },
  { id: 'think', label: 'think', mode: 'read', purpose: 'Run multi-hop synthesis across pages, takes, and graph evidence.' },
  { id: 'sources_list', label: 'sources', mode: 'read', purpose: 'Inspect registered shared-brain sources and freshness.' },
  { id: 'get_health', label: 'health', mode: 'read', purpose: 'Verify GBrain health before relying on shared context.' },
];
const GBRAIN_BASE_TOOL_IDS = new Set(['get_page', 'put_page', 'query', 'recall', 'sources_list', 'get_health']);
const GBRAIN_RUNTIME_CONTRACT_MARKER = 'mission-control-gbrain-contract';
const GBRAIN_INTEGRATION_CONTRACT = {
  role: 'shared-brain',
  label: 'Shared brain contract',
  summary: 'GBrain is the shared machine brain. Hermes and OpenClaw keep their own local memory systems, and only curated cross-system knowledge is promoted into GBrain.',
  localMemoryBoundary: 'Hermes profile memory and OpenClaw native memory remain local/private runtime memory.',
  writePolicy: 'Curated decisions, playbooks, handoffs, and verified task outcomes may be exported; raw transcripts, secrets, credentials, and untagged private memory stay out.',
  systems: [
    {
      id: 'hermes',
      label: 'Hermes hmudur',
      localMemory: 'Hermes profile memories remain the local conversational memory.',
      gbrainUse: 'Uses GBrain for MCP recall/search plus curated memory bridge exports.',
      proof: 'gbrain MCP server and hermes_hmudur_memory_bridge.py',
    },
    {
      id: 'openclaw',
      label: 'OpenClaw',
      localMemory: 'OpenClaw native memory, sessions, and runtime state remain local to OpenClaw.',
      gbrainUse: 'Uses GBrain as the shared recall/search/tool surface plus tagged main-memory bridge for cross-agent knowledge.',
      proof: 'openclaw MCP gbrain server, main_memory_to_gbrain_bridge.py, and shared-memory source sync',
    },
  ],
};
const GBrainActionDefinitions = {
  'doctor-fast': {
    label: 'Run fast doctor',
    description: 'Check resolver, schema, embeddings, and local runtime health without repair flags.',
    kind: 'diagnostic',
    args: ['doctor', '--json', '--fast'],
    timeoutMs: 30000,
    refreshAfter: true,
  },
  'preview-sync': {
    label: 'Preview source sync',
    description: 'Dry-run every registered local source without pulling from remotes.',
    kind: 'preview',
    args: ['sync', '--all', '--no-pull', '--parallel', '1', '--dry-run', '--json', '--yes'],
    timeoutMs: 60000,
    refreshAfter: false,
  },
  'sync-sources': {
    label: 'Sync local sources',
    description: 'Incrementally sync every registered local source without remote pulls, then embed stale chunks.',
    kind: 'maintenance',
    args: ['sync', '--all', '--no-pull', '--parallel', '1', '--json', '--yes'],
    afterSuccessArgs: ['embed', '--stale'],
    softTimeoutMs: 120000,
    hardKillDelayMs: 30000,
    timeoutMs: 120000,
    refreshAfter: true,
  },
  'retry-failed-sync': {
    label: 'Retry failed syncs',
    description: 'Re-attempt previously failed source files, embed stale chunks, then refresh live proof.',
    kind: 'repair',
    args: ['sync', '--all', '--retry-failed', '--serial', '--no-pull', '--json', '--yes'],
    afterSuccessArgs: ['embed', '--stale'],
    softTimeoutMs: 120000,
    hardKillDelayMs: 30000,
    timeoutMs: 120000,
    refreshAfter: true,
  },
  'embed-stale': {
    label: 'Embed stale chunks',
    description: 'Refresh embeddings for chunks marked stale by GBrain.',
    kind: 'maintenance',
    args: ['embed', '--stale'],
    timeoutMs: 120000,
    refreshAfter: true,
  },
  'embed-missing': {
    label: 'Backfill missing embeddings',
    description: 'Backfill missing embedding vectors using the stale-chunk fast path, then refresh live proof.',
    kind: 'repair',
    args: ['embed', '--stale', '--priority', 'recent', '--batch-size', '1000'],
    softTimeoutMs: 1800000,
    hardKillDelayMs: 30000,
    timeoutMs: 1800000,
    refreshAfter: true,
  },
  'check-resolvable': {
    label: 'Check skill routing',
    description: 'Validate skill-tree reachability, overlap, duplication, and gaps without fixes.',
    kind: 'diagnostic',
    args: ['check-resolvable', '--json'],
    timeoutMs: 60000,
    refreshAfter: false,
  },
  'storage-status': {
    label: 'Check storage status',
    description: 'Inspect GBrain storage tier status for the current local repo.',
    kind: 'diagnostic',
    args: ['storage', 'status', '--json'],
    timeoutMs: 30000,
    refreshAfter: false,
  },
};
const activeGBrainActions = new Set();

module.exports = {
  AUDIT_REPORT_PATH,
  DESIGN_HANDOFF_PATH,
  AUDIT_VERIFIED_AT,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_SOURCE_FRESHNESS_HOURS,
  SOURCE_FRESHNESS_THRESHOLDS_HOURS,
  REQUIRED_GBRAIN_TOOLS,
  GBRAIN_BASE_TOOL_IDS,
  GBRAIN_RUNTIME_CONTRACT_MARKER,
  GBRAIN_INTEGRATION_CONTRACT,
  GBrainActionDefinitions,
  activeGBrainActions,
};
