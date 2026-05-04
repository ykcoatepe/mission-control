const express = require('express');
const path = require('path');
const { execFile } = require('child_process');
const util = require('util');

function buildOpsRouter({ readJsonFileSafe, writeJsonFileAtomic, opsEventsPath, gatewayPort }) {
  const router = express.Router();
  const execFilePromise = util.promisify(execFile);

  async function fetchJsonWithTiming(url, timeoutMs = 2500) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      const latencyMs = Date.now() - started;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { ok: true, latencyMs, payload: await response.json(), error: null };
    } catch (error) {
      return { ok: false, latencyMs: Date.now() - started, payload: null, error: error.message || 'request failed' };
    } finally {
      clearTimeout(timer);
    }
  }

  router.get('/api/ops/events', (req, res) => {
    const events = readJsonFileSafe(opsEventsPath, []);
    const list = (Array.isArray(events) ? events : [])
      .sort((left, right) => new Date(right.timestamp || 0).getTime() - new Date(left.timestamp || 0).getTime())
      .slice(0, 200);
    return res.json({ events: list });
  });

  router.post('/api/ops/openclaw/self-heal', async (req, res) => {
    const eventList = readJsonFileSafe(opsEventsPath, []);
    const by = req.body?.by || 'unknown';
    const reason = req.body?.reason || 'manual trigger';
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;

    const pushEvent = (payload) => {
      const list = Array.isArray(eventList) ? eventList : [];
      list.unshift({
        eventId: `EVT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        eventType: 'ops.gateway.self_heal',
        source: 'mission-control-ui',
        entityType: 'gateway',
        payload,
        timestamp: new Date().toISOString(),
      });
      writeJsonFileAtomic(opsEventsPath, list);
    };

    try {
      const before = await fetchJsonWithTiming(`http://127.0.0.1:${gatewayPort}/health`, 2500);
      if (before.ok) {
        const payload = { ok: true, action: 'noop', reason: 'gateway reachable', by, triggerReason: reason, latencyMs: before.latencyMs };
        pushEvent(payload);
        return res.json(payload);
      }

      let action = 'kickstart';
      let launchctlError = null;
      try {
        if (uid == null) throw new Error('uid unavailable');
        await execFilePromise('launchctl', ['kickstart', '-k', `gui/${uid}/ai.openclaw.gateway`], { timeout: 15000, env: process.env });
      } catch (error) {
        action = 'bootstrap+kickstart';
        launchctlError = error.message || String(error);
        if (uid == null) throw error;
        await execFilePromise('launchctl', ['bootstrap', `gui/${uid}`, path.join(process.env.HOME || '/home/ubuntu', 'Library/LaunchAgents/ai.openclaw.gateway.plist')], { timeout: 15000, env: process.env }).catch(() => {});
        await execFilePromise('launchctl', ['kickstart', '-k', `gui/${uid}/ai.openclaw.gateway`], { timeout: 15000, env: process.env });
      }

      const after = await fetchJsonWithTiming(`http://127.0.0.1:${gatewayPort}/health`, 5000);
      const payload = {
        ok: after.ok,
        action,
        reason: after.ok ? 'gateway reachable after self-heal' : (after.error || launchctlError || 'gateway still unreachable'),
        by,
        triggerReason: reason,
        latencyMs: after.latencyMs,
      };
      pushEvent(payload);
      return res.status(after.ok ? 200 : 502).json(payload);
    } catch (error) {
      const payload = {
        ok: false,
        action: 'failed',
        reason: error.message || 'self-heal failed',
        by,
        triggerReason: reason,
      };
      pushEvent(payload);
      return res.status(500).json(payload);
    }
  });

  return router;
}

module.exports = {
  buildOpsRouter,
};
