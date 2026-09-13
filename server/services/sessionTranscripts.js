const os = require('os');
const path = require('path');

const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function agentSessionsDir(agentId) {
  const agent = SAFE_NAME_PATTERN.test(String(agentId || '')) ? String(agentId) : 'main';
  return path.join(os.homedir(), '.openclaw', 'agents', agent, 'sessions');
}

// A transcriptPath supplied by OpenClaw is honored only when it resolves
// inside the owning agent's sessions directory; otherwise fall back to the
// <sessionId>.jsonl convention.
function resolveSessionTranscriptFile(session) {
  if (!session) return null;
  const sessionsDir = agentSessionsDir(session.agentId);
  const transcriptPath = session.transcriptPath;
  if (typeof transcriptPath === 'string' && transcriptPath.trim()) {
    const candidate = path.resolve(sessionsDir, transcriptPath);
    return candidate.startsWith(sessionsDir + path.sep) ? candidate : null;
  }
  if (typeof session.sessionId === 'string' && SAFE_NAME_PATTERN.test(session.sessionId)) {
    return path.join(sessionsDir, `${session.sessionId}.jsonl`);
  }
  return null;
}

module.exports = {
  agentSessionsDir,
  resolveSessionTranscriptFile,
};
