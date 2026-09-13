'use strict';

const { buildGBrainRouter } = require('./router');
const { createGBrainOverviewService } = require('../../services/gbrainOverviewData');
const { buildGBrainOverview, statusLabelText } = require('./overview');
const { buildGBrainIntegrationHealth } = require('./integrationHealth');
const { buildLocalGBrainIntegrationRuntime, hasOpenClawSemanticGBrainContract } = require('./integrationRuntime');
const { listGBrainActions, runGBrainAction } = require('./actionsExecutor');
const {
  buildLiveGBrainHealth,
  buildLiveGBrainSources,
  buildLiveGBrainVersion,
  buildLiveGBrainTools,
  buildLiveGBrainFeatures,
  buildLiveGBrainProviders,
  buildLiveHermesProxyStatus,
  liveHealthStatus,
} = require('./liveProbes');
const { sanitizeMessage } = require('./commandRunner');

module.exports = {
  buildGBrainRouter,
  createGBrainOverviewService,
  buildGBrainOverview,
  buildLiveGBrainHealth,
  buildLiveGBrainSources,
  buildLiveGBrainVersion,
  buildLiveGBrainTools,
  buildLiveGBrainFeatures,
  buildLiveGBrainProviders,
  buildLiveHermesProxyStatus,
  buildGBrainIntegrationHealth,
  buildLocalGBrainIntegrationRuntime,
  hasOpenClawSemanticGBrainContract,
  listGBrainActions,
  runGBrainAction,
  sanitizeMessage,
  liveHealthStatus,
};
