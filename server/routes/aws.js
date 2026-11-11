const express = require('express');
const { httpError } = require('../core/http');

// GET /api/aws/costs — the Usage screen reads it while the AWS module is
// enabled. It composes from the scheduled `aws.costs` source and never starts
// a process. Disabled module: 404 aws_disabled; not read yet: 503.
function buildAwsRouter({ awsCostsSource, isEnabled }) {
  if (typeof awsCostsSource?.snapshot !== 'function') throw new TypeError('buildAwsRouter: awsCostsSource required');
  const router = express.Router();

  router.get('/api/aws/costs', (req, res) => {
    if (!isEnabled()) throw httpError(404, 'aws_disabled', 'The AWS module is disabled');
    const snapshot = awsCostsSource.snapshot();
    if (!snapshot.data) throw httpError(503, 'aws_costs_unavailable', 'AWS cost data has not been read');
    return res.json({ ...snapshot.data, meta: snapshot.meta });
  });

  return router;
}

module.exports = {
  buildAwsRouter,
};
