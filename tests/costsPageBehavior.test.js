const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Read Costs.tsx plus its helper modules so guards work regardless of which
// file the string lives in after the modular refactor.
const pagesDir = path.join(__dirname, '..', 'frontend', 'src', 'pages');
const costsDir = path.join(pagesDir, 'costs');
const filesToCheck = [
  path.join(pagesDir, 'Costs.tsx'),
  path.join(costsDir, 'AgentSplitCard.tsx'),
  path.join(costsDir, 'lib.ts'),
  path.join(costsDir, 'types.ts'),
].filter(f => fs.existsSync(f));
const source = filesToCheck.map(f => fs.readFileSync(f, 'utf8')).join('\n');

assert.ok(
  source.includes("tokens?.source === 'sessions.fast_fallback'") && source.includes('tokens?.meta?.refreshing') && source.includes('tokens?.meta?.stale'),
  'Costs page should keep retrying while detailed cost data is fallback, refreshing, or stale',
);

assert.ok(
  source.includes('STALE_COSTS_RETRY_LIMIT = 60') && source.includes('STALE_COSTS_RETRY_TIMEOUT_MS') && source.includes('preservedPreviousOpenClaw') && source.includes('preservedPreviousClaudeCode') && source.includes('preservedPreviousUsage'),
  'Costs page stale retry polling should be capped and stop on fresh preserved cache responses',
);

assert.ok(
  source.includes('codexbarRowsForPeriod') && source.includes('previousCodexbarRows'),
  'Costs page should select sparse CodexBar rows with calendar-aware period helpers',
);

assert.ok(
  source.includes("return { period: 'vs previous month', daily: 'vs previous month avg' }"),
  'CodexBar month labels should describe the calendar-month baseline shared by Agent Split',
);

assert.ok(
  source.includes('OpenClaw is direct native usage; Codex App Sessions are nested app-launched runs; Claude Code comes from local CodexBar logs.') &&
  source.includes('Direct OpenClaw native sessions only. Nested app-launched Codex runs are counted in Codex App Sessions.') &&
  source.includes('agent/codex-home/sessions runs launched from the Codex app') &&
  source.includes('Claude Code usage from local logs via CodexBar. Cost is an API-equivalent estimate, not a subscription invoice.'),
  'Agent Split should explain direct OpenClaw, nested Codex App, and local Claude Code usage',
);

assert.ok(
  source.includes("agent.status === 'stale'") && source.includes('Stale source'),
  'Agent Split should visibly mark preserved Claude Code data as stale',
);

console.log('costs page behavior guards passed');
