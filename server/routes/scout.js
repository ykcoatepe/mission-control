const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function buildScoutRouter({ projectRoot }) {
  const router = express.Router();
  const scoutFile = path.join(projectRoot, 'scout-results.json');
  const tasksFile = path.join(projectRoot, 'tasks.json');
  let scoutScanRunning = false;

  router.get('/api/scout', (req, res) => {
    try {
      let scoutData = { opportunities: [], lastScan: null };
      try {
        scoutData = JSON.parse(fs.readFileSync(scoutFile, 'utf8'));
      } catch {
        console.log('[Scout] No scout-results.json yet — run: node scout-engine.js');
      }

      const opportunities = (scoutData.opportunities || []).filter((opportunity) => opportunity.score >= 15);

      return res.json({
        opportunities,
        lastScan: scoutData.lastScan || null,
        queryCount: scoutData.queryCount || 0,
        stats: {
          total: opportunities.length,
          new: opportunities.filter((opportunity) => opportunity.status === 'new').length,
          deployed: opportunities.filter((opportunity) => opportunity.status === 'deployed').length,
          dismissed: opportunities.filter((opportunity) => opportunity.status === 'dismissed').length,
          avgScore: opportunities.length ? Math.round(opportunities.reduce((acc, opportunity) => acc + opportunity.score, 0) / opportunities.length) : 0,
        },
      });
    } catch (error) {
      console.error('[Scout API]', error.message);
      return res.json({ opportunities: [], stats: {}, error: error.message });
    }
  });

  router.post('/api/scout/deploy', (req, res) => {
    try {
      const { opportunityId } = req.body;
      if (!opportunityId) return res.status(400).json({ error: 'Missing opportunityId' });

      const scoutData = JSON.parse(fs.readFileSync(scoutFile, 'utf8'));
      const opportunity = scoutData.opportunities.find((item) => item.id === opportunityId);
      if (!opportunity) return res.status(404).json({ error: 'Opportunity not found' });

      opportunity.status = 'deployed';
      fs.writeFileSync(scoutFile, JSON.stringify(scoutData, null, 2));

      const tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
      tasks.columns.queue.unshift({
        id: `scout-${Date.now()}`,
        title: opportunity.title.substring(0, 80),
        description: `${opportunity.summary}\n\nSource: ${opportunity.source} | Score: ${opportunity.score}\nURL: ${opportunity.url}`,
        priority: opportunity.score >= 80 ? 'high' : opportunity.score >= 50 ? 'medium' : 'low',
        created: new Date().toISOString(),
        tags: opportunity.tags || [opportunity.category],
        source: 'scout',
      });
      fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));

      return res.json({ ok: true, task: tasks.columns.queue[0] });
    } catch (error) {
      console.error('[Scout deploy]', error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/scout/dismiss', (req, res) => {
    try {
      const { opportunityId } = req.body;
      const scoutData = JSON.parse(fs.readFileSync(scoutFile, 'utf8'));
      const opportunity = scoutData.opportunities.find((item) => item.id === opportunityId);
      if (opportunity) {
        opportunity.status = 'dismissed';
        fs.writeFileSync(scoutFile, JSON.stringify(scoutData, null, 2));
      }
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/scout/scan', (req, res) => {
    try {
      if (scoutScanRunning) {
        return res.json({ status: 'already_scanning', message: 'Scout scan is already running' });
      }

      scoutScanRunning = true;
      execFile('node', [path.join(projectRoot, 'scout-engine.js')], { timeout: 300000 }, (error) => {
        scoutScanRunning = false;
        if (error) {
          console.error('[Scout scan]', error.message);
        } else {
          console.log('[Scout scan] Completed successfully');
        }
      });

      return res.json({ status: 'scanning', message: 'Scout scan started in background' });
    } catch (error) {
      scoutScanRunning = false;
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/scout/status', (req, res) => {
    return res.json({
      scanning: scoutScanRunning,
      status: scoutScanRunning ? 'scanning' : 'idle',
    });
  });

  return router;
}

module.exports = {
  buildScoutRouter,
};
