'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Metadata only. Never publish configuration values or inspect session/transcript bodies.
// These files establish configuration, not a successful query or a live connection.
function readReaders({ homeDir = os.homedir() } = {}) {
  function inspect(id, label, suffix, detect) {
    try {
      const text = fs.readFileSync(path.join(homeDir, suffix), 'utf8');
      return { id, label, observed: true, configured: detect(text), evidence: 'local MCP configuration' };
    } catch { return { id, label, observed: false, configured: null, evidence: 'local MCP configuration not read' }; }
  }
  return [
    inspect('hermes', 'Hermes', '.hermes/profiles/hmudur/config.yaml', (t) => /mcp_servers:\s*[\s\S]*?\bgbrain:/i.test(t)),
    inspect('codex', 'Codex', '.codex/config.toml', (t) => /\[mcp_servers\.[^\]\n]*gbrain[^\]\n]*\]/i.test(t)),
    inspect('claude-code', 'Claude Code', '.claude.json', (t) => {
      const p = JSON.parse(t);
      return Object.keys(p.mcpServers || {}).some((k) => /gbrain/i.test(k));
    }),
    inspect('openclaw', 'OpenClaw', '.openclaw/openclaw.json', (t) => {
      const p = JSON.parse(t);
      return Object.keys(p.mcp?.servers || {}).some((k) => /gbrain/i.test(k));
    }),
  ];
}
module.exports = { readReaders };
