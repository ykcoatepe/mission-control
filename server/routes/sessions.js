const express = require('express');
const { httpError } = require('../core/http');

function buildSessionsRouter({ sessionsService }) {
  const router = express.Router();

  // { count, sessions, meta } from the scheduled sessions source. A failure to
  // compose it is the error contract (503), never a 200 with an error string.
  router.get('/api/sessions', async (req, res, next) => {
    let payload;
    try {
      payload = await sessionsService.listVisibleSessions(25);
    } catch {
      return next(httpError(503, 'sessions_unavailable', 'OpenClaw sessions could not be read'));
    }
    return res.json(payload);
  });

  return router;
}

module.exports = {
  buildSessionsRouter,
};
