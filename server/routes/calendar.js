const express = require('express');

function buildCalendarRouter({ calendarService, cronCacheTtl = 30000 }) {
  const router = express.Router();

  router.get('/api/calendar', async (req, res) => {
    try {
      const current = calendarService.readCalendarDataSafe();
      const lastSyncMs = current.lastCronSyncAt ? Date.parse(current.lastCronSyncAt) : 0;
      const shouldSync = !lastSyncMs || Number.isNaN(lastSyncMs) || (Date.now() - lastSyncMs > cronCacheTtl);

      if (shouldSync) {
        try {
          const synced = await calendarService.syncCalendarWithLiveCron();
          return res.json(synced);
        } catch (error) {
          console.error('[Calendar sync/get]', error.message);
          return res.json({ ...current, warning: error.message });
        }
      }

      return res.json(current);
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/calendar/sync-cron', async (req, res) => {
    try {
      const synced = await calendarService.syncCalendarWithLiveCron();
      return res.json({
        ok: true,
        synced: true,
        entries: synced.entries,
        updatedAt: synced.updatedAt,
        lastCronSyncAt: synced.lastCronSyncAt,
      });
    } catch (error) {
      console.error('[Calendar sync]', error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/calendar', (req, res) => {
    try {
      return res.json(calendarService.createCalendarEntry(req.body || {}));
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  router.patch('/api/calendar/:id', (req, res) => {
    try {
      return res.json(calendarService.updateCalendarEntry(req.params.id, req.body || {}));
    } catch (error) {
      return res.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = {
  buildCalendarRouter,
};
