const express = require('express');
const { httpError } = require('../core/http');

function buildCalendarRouter({ calendarService, automationSource }) {
  const router = express.Router();

  router.get('/api/calendar', (req, res, next) => {
    const snap = automationSource.snapshot();
    if (!snap.data) throw httpError(503, 'calendar_unavailable', 'Calendar data has not been observed');
    return res.json({ ...snap.data.calendar, meta: snap.meta });
  });

  router.post('/api/calendar/sync-cron', async (req, res, next) => {
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
      return next(error);
    }
  });

  router.post('/api/calendar', (req, res, next) => {
    try {
      return res.json(calendarService.createCalendarEntry(req.body || {}));
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/api/calendar/:id', (req, res, next) => {
    try {
      return res.json(calendarService.updateCalendarEntry(req.params.id, req.body || {}));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = {
  buildCalendarRouter,
};
