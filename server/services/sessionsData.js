const fs = require('fs');
const path = require('path');
const os = require('os');

function createSessionsService({
  openclawExec,
  parseFirstJson,
  gatewayPort,
  gatewayToken,
  hiddenSessionsPath,
}) {
  let sessionsCache = null;
  let sessionsCacheTime = 0;
  const sessionsCacheTtl = 60000;

  let hiddenSessions = [];
  try {
    hiddenSessions = JSON.parse(fs.readFileSync(hiddenSessionsPath, 'utf8'));
  } catch {
    hiddenSessions = [];
  }

  async function fetchSessionsRaw(limit = 50) {
    try {
      const { stdout } = await openclawExec(['sessions', '--json', '--limit', String(limit)], 15000);
      const parsed = parseFirstJson(stdout, {});
      if (parsed?.sessions) return parsed;
    } catch {}

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const gwRes = await fetch(`http://127.0.0.1:${gatewayPort}/tools/invoke`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${gatewayToken}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          tool: 'sessions_list',
          args: { limit, messageLimit: 1 },
        }),
      });
      clearTimeout(timer);
      const data = await gwRes.json();
      if (data?.result?.details) return data.result.details;
      const textResult = data?.result?.content?.[0]?.text;
      if (textResult) return JSON.parse(textResult);
      return { count: 0, sessions: [] };
    } catch (error) {
      console.error('[fetchSessions]', error.message);
      return { count: 0, sessions: [] };
    }
  }

  function clearSessionsCache() {
    sessionsCache = null;
    sessionsCacheTime = 0;
  }

  async function listVisibleSessions(limit = 25) {
    if (sessionsCache && Date.now() - sessionsCacheTime < sessionsCacheTtl) {
      return sessionsCache;
    }

    const sessionData = await fetchSessionsRaw(limit);
    const sessions = sessionData.sessions || [];
    const liveWindowMs = 30 * 60 * 1000;

    const result = {
      count: sessionData.count || sessions.length,
      sessions: sessions.map((session) => {
        const key = session.key || '';
        const type = key.includes(':subagent:') ? 'sub-agent'
          : key.includes(':discord:') ? 'discord'
          : key.includes(':openai') ? 'web'
          : key.includes(':main:main') ? 'main'
          : 'other';

        const updatedAt = session.updatedAt ? new Date(session.updatedAt).toISOString() : null;
        const updatedMs = updatedAt ? new Date(updatedAt).getTime() : 0;
        return {
          key: session.key,
          kind: session.kind,
          channel: session.channel || 'unknown',
          displayName: session.displayName || session.key.split(':').slice(-1)[0],
          model: (session.model || '').replace('us.anthropic.', ''),
          totalTokens: session.totalTokens || 0,
          contextTokens: session.contextTokens || 0,
          updatedAt,
          label: session.label || null,
          type,
          isActive: updatedMs > 0 && (Date.now() - updatedMs) < liveWindowMs,
        };
      }),
    };

    result.sessions = result.sessions.filter((session) => !hiddenSessions.includes(session.key));
    result.count = result.sessions.length;
    sessionsCache = result;
    sessionsCacheTime = Date.now();
    return result;
  }

  async function getSessionHistory(sessionKey) {
    const decodedKey = decodeURIComponent(sessionKey);
    const openclawConfigPath = path.join(os.homedir(), '.openclaw/openclaw.json');
    const cfg = fs.existsSync(openclawConfigPath) ? JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8')) : {};
    const gwToken = cfg.gateway?.auth?.token || process.env.MC_GATEWAY_TOKEN || '';
    const gwPort = cfg.gateway?.port || 18789;

    const listRes = await fetch(`http://127.0.0.1:${gwPort}/tools/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gwToken}` },
      body: JSON.stringify({ tool: 'sessions_list', input: { limit: 100, messageLimit: 0 } }),
    });

    if (!listRes.ok) return { messages: [] };

    const listData = await listRes.json();
    const listText = listData?.result?.content?.[0]?.text || '{}';
    const parsed = JSON.parse(listText);
    const session = (parsed.sessions || []).find((row) => row.key === decodedKey);
    if (!session?.transcriptPath) return { messages: [], info: 'No transcript found' };

    const transcriptDir = path.join(os.homedir(), '.openclaw/agents/main/sessions');
    const transcriptFile = path.join(transcriptDir, session.transcriptPath);
    if (!fs.existsSync(transcriptFile)) return { messages: [], info: 'Transcript file missing' };

    const lines = fs.readFileSync(transcriptFile, 'utf8').split('\n').filter(Boolean);
    const messages = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'message' || !entry.message) continue;
        const msg = entry.message;
        const role = msg.role;
        if (!role || role === 'toolResult' || role === 'toolUse') continue;

        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          text = msg.content
            .filter((item) => item.type === 'text')
            .map((item) => item.text || '')
            .join('\n');
        }

        if (text.trim()) {
          messages.push({ role, content: text.substring(0, 3000), ts: entry.timestamp });
        }
      } catch {}
    }

    return { messages: messages.slice(-50), total: messages.length, sessionKey: decodedKey };
  }

  async function sendSessionMessage(sessionKey, message) {
    const decodedKey = decodeURIComponent(sessionKey);
    const openclawConfigPath = path.join(os.homedir(), '.openclaw/openclaw.json');
    const cfg = fs.existsSync(openclawConfigPath) ? JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8')) : {};
    const gwToken = cfg.gateway?.auth?.token || process.env.MC_GATEWAY_TOKEN || '';
    const gwPort = cfg.gateway?.port || 18789;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    try {
      const response = await fetch(`http://127.0.0.1:${gwPort}/tools/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${gwToken}` },
        signal: controller.signal,
        body: JSON.stringify({
          tool: 'sessions_send',
          args: { sessionKey: decodedKey, message, timeoutSeconds: 90 },
        }),
      });

      clearTimeout(timeout);
      const data = await response.json();
      let resultText = data?.result?.content?.[0]?.text || '';
      try {
        const parsed = JSON.parse(resultText);
        if (parsed.reply) resultText = parsed.reply;
      } catch {}

      return { ok: !!resultText, result: resultText };
    } catch {
      clearTimeout(timeout);

      let resultText = '';
      try {
        const sessionsFile = path.join(os.homedir(), '.openclaw/agents/main/sessions/sessions.json');
        const sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8'));
        const sessionInfo = sessions[decodedKey] || {};
        const sessionId = sessionInfo.sessionId || '';
        if (sessionId) {
          const transcriptPath = path.join(os.homedir(), '.openclaw/agents/main/sessions', `${sessionId}.jsonl`);
          if (fs.existsSync(transcriptPath)) {
            const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
            for (let index = lines.length - 1; index >= 0; index -= 1) {
              try {
                const evt = JSON.parse(lines[index]);
                if (evt.type === 'message' && evt.message?.role === 'assistant') {
                  const content = evt.message.content;
                  resultText = Array.isArray(content)
                    ? content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
                    : typeof content === 'string' ? content : '';
                  if (resultText) break;
                }
              } catch {}
            }
          }
        }
      } catch {}

      if (resultText) {
        return { ok: true, result: resultText };
      }
      return { ok: false, result: 'Response is taking longer than expected. The agent is still working — check back in a moment.' };
    }
  }

  function hideSession(key) {
    const decodedKey = decodeURIComponent(key);
    if (!hiddenSessions.includes(decodedKey)) {
      hiddenSessions.push(decodedKey);
      fs.writeFileSync(hiddenSessionsPath, JSON.stringify(hiddenSessions, null, 2));
    }
    clearSessionsCache();
    return { status: 'hidden', message: `Session "${decodedKey}" hidden from view` };
  }

  return {
    fetchSessionsRaw,
    listVisibleSessions,
    getSessionHistory,
    sendSessionMessage,
    hideSession,
    clearSessionsCache,
    getHiddenSessions: () => [...hiddenSessions],
  };
}

module.exports = {
  createSessionsService,
};
