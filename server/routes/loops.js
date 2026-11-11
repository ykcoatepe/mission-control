'use strict';

// GET /api/loops and GET /api/loops/:project — manager-loop ledger, composed
// from the scheduled mloop source. No request runs mloop or reads the ledger.

const express = require('express');
const { asyncHandler, httpError, sendEnvelope } = require('../core/http');
const { loopsView, loopDetailView, PROJECT_ID_PATTERN } = require('../sources/mloop');

// operationsOverviewService (memory-only) supplies the system attention items
// for totals.needsOperator, the same number /api/signals reports.
function buildLoopsRouter({ loopsSource, operationsOverviewService = null } = {}) {
  if (typeof loopsSource?.snapshot !== 'function') throw new TypeError('buildLoopsRouter: loopsSource required');
  const router = express.Router();

  router.get('/api/loops', asyncHandler(async (req, res) => {
    const snapshot = loopsSource.snapshot();
    const overview = operationsOverviewService ? await operationsOverviewService.getOverview() : null;
    const systemsAttention = Array.isArray(overview?.attention) ? overview.attention : null;
    return sendEnvelope(res, { data: loopsView(snapshot.data, { systemsAttention }), meta: snapshot.meta });
  }));

  router.get('/api/loops/:project', (req, res) => {
    const id = String(req.params.project || '');
    if (!PROJECT_ID_PATTERN.test(id)) throw httpError(400, 'invalid_project', 'Project id is not valid');
    const snapshot = loopsSource.snapshot();
    const detail = loopDetailView(snapshot.data, id);
    if (detail === undefined) throw httpError(404, 'loop_project_not_found', 'No manager-loop project with that id');
    return sendEnvelope(res, { data: detail, meta: snapshot.meta });
  });

  return router;
}

module.exports = { buildLoopsRouter };
