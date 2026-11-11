const express = require('express');
const { httpError } = require('../core/http');
const { withWriteThrough, publishMutation } = require('../sources/openclaw/writeThrough');
const { CALENDAR_EDITABLE_FIELDS } = require('../services/calendarEntrySchema');

function buildCalendarRouter({ calendarService, calendarSource }) {
  const router = express.Router();
  withWriteThrough(calendarSource);
  async function committed(result) {
    const cleanDiagnostics = { quarantined: { count: 0, ids: [] }, duplicates: { count: 0, ids: [] } };
    const confirmsEntry = (actual, expected, meta) => actual && ([...CALENDAR_EDITABLE_FIELDS, 'scheduleKind', 'everyMs', 'atIso', 'userOverrides', 'cronDerived']
      .every(field => JSON.stringify(actual[field]) === JSON.stringify(expected[field]))
      || (expected.source === 'cron' && !meta?.error && Date.parse(actual.updatedAt) > Date.parse(expected.updatedAt)));
    const prior = calendarSource?.snapshot()?.data;
    const seed = { entries: result.entries, updatedAt: result.updatedAt, lastCronSyncAt: result.lastCronSyncAt, diagnostics: cleanDiagnostics };
    const records = (result.entry ? [result.entry] : result.entries).map(entry => ({
      key: `calendar:${entry.id}`,
      apply: data => ({ ...(data || seed), entries: calendarService.sortCalendarEntries
        ? calendarService.sortCalendarEntries((data?.entries || seed.entries).filter(row => row.id !== entry.id).concat(entry))
        : (data?.entries || seed.entries).filter(row => row.id !== entry.id).concat(entry) }),
      confirmed: (data, meta) => confirmsEntry(data?.entries?.find(row => row.id === entry.id), entry, meta),
    }));
    if (!result.entry) {
      const kept = new Set(result.entries.map(entry => entry.id));
      for (const entry of prior?.entries || []) if (!kept.has(entry.id)) records.push({
        key: `calendar:${entry.id}`,
        apply: data => ({ ...(data || seed), entries: (data?.entries || []).filter(row => row.id !== entry.id) }),
        confirmed: data => Array.isArray(data?.entries) && !data.entries.some(row => row.id === entry.id),
      });
    }
    records.push({
      key: 'calendar:metadata', meta: { repairAvailable: false },
      apply: data => ({ ...(data || seed), updatedAt: result.updatedAt, lastCronSyncAt: result.lastCronSyncAt, diagnostics: cleanDiagnostics }),
      confirmed: data => data && !data.diagnostics?.quarantined.count && !data.diagnostics?.duplicates.count
        && (!result.updatedAt || Date.parse(data.updatedAt) >= Date.parse(result.updatedAt)),
    });
    const snap = await publishMutation(calendarSource, records);
    return { ...result, meta: { ...snap.meta, repairAvailable: false } };
  }

  router.get('/api/calendar', (req, res, next) => {
    const snap = calendarSource.snapshot();
    if (!snap.data) throw httpError(503, 'calendar_unavailable', 'Calendar data has not been observed');
    return res.json({ ...snap.data, meta: snap.meta });
  });

  router.post('/api/calendar/repair', async (req, res, next) => {
    try {
      return res.json(await committed(calendarService.repairCalendarData()));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/api/calendar/sync-cron', async (req, res, next) => {
    try {
      const synced = await calendarService.syncCalendarWithLiveCron();
      return res.json(await committed({
        ok: true,
        synced: true,
        entries: synced.entries,
        updatedAt: synced.updatedAt,
        lastCronSyncAt: synced.lastCronSyncAt,
        upstream: synced.upstream,
      }));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/api/calendar', async (req, res, next) => {
    try {
      return res.json(await committed(calendarService.createCalendarEntry(req.body || {})));
    } catch (error) {
      return next(error);
    }
  });

  router.patch('/api/calendar/:id', async (req, res, next) => {
    try {
      return res.json(await committed(calendarService.updateCalendarEntry(req.params.id, req.body || {})));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = {
  buildCalendarRouter,
};
