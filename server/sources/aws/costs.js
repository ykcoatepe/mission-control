'use strict';

// AWS Cost Explorer month-to-date spend, read by the scheduler through the
// core runner (fixed argv, no shell). Only while the AWS module is enabled;
// a disabled module never starts a process.

const { createSource, SourceReadError } = require('../../core/source');

const AWS_COSTS_REFRESH_INTERVAL_MS = 60 * 60_000;

function isoDay(date) {
  return date.toISOString().split('T')[0];
}

function parseCostAndUsage(stdout, start, end) {
  let data;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new SourceReadError('AWS cost data is not valid JSON', { code: 'aws_costs_invalid' });
  }
  if (!Array.isArray(data?.ResultsByTime)) throw new SourceReadError('AWS cost data has no results', { code: 'aws_costs_invalid' });
  const services = {};
  const daily = [];
  let total = 0;
  for (const row of data.ResultsByTime) {
    let dayTotal = 0;
    for (const group of row?.Groups || []) {
      const service = String(group?.Keys?.[0] || 'unknown');
      const amount = Number.parseFloat(group?.Metrics?.BlendedCost?.Amount);
      if (Number.isFinite(amount) && amount > 0.001) {
        services[service] = (services[service] || 0) + amount;
        dayTotal += amount;
      }
    }
    daily.push({ date: String(row?.TimePeriod?.Start || ''), cost: Math.round(dayTotal * 100) / 100 });
    total += dayTotal;
  }
  return {
    period: { start, end },
    total: Math.round(total * 100) / 100,
    daily,
    services: Object.entries(services)
      .map(([name, cost]) => ({ name, cost: Math.round(cost * 100) / 100 }))
      .sort((left, right) => right.cost - left.cost),
  };
}

function createAwsCostsSource({ exec, isEnabled, env = {}, now = Date.now, logger = null } = {}) {
  if (typeof exec?.run !== 'function') throw new TypeError('createAwsCostsSource: exec.run required');
  if (typeof isEnabled !== 'function') throw new TypeError('createAwsCostsSource: isEnabled required');
  return createSource({
    id: 'aws.costs',
    ttlMs: AWS_COSTS_REFRESH_INTERVAL_MS,
    timeoutMs: 30_000,
    staleAfterMs: 3 * AWS_COSTS_REFRESH_INTERVAL_MS,
    now,
    logger,
    read: async () => {
      if (!isEnabled()) throw new SourceReadError('AWS module disabled', { code: 'aws_disabled' });
      const today = new Date(now());
      const start = isoDay(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)));
      // Cost Explorer's end date is exclusive: tomorrow includes today.
      const end = isoDay(new Date(today.getTime() + 24 * 60 * 60_000));
      const result = await exec.run('aws', [
        'ce', 'get-cost-and-usage',
        '--time-period', `Start=${start},End=${end}`,
        '--granularity', 'DAILY',
        '--metrics', 'BlendedCost',
        '--group-by', 'Type=DIMENSION,Key=SERVICE',
        '--output', 'json',
      ], { lane: 'default', timeoutMs: 20_000, env: { ...process.env, ...env } });
      if (!result?.ok || result.truncated) throw new SourceReadError('AWS cost data could not be read', { code: 'aws_costs_unavailable' });
      return parseCostAndUsage(result.stdout, start, end);
    },
  });
}

module.exports = { createAwsCostsSource, parseCostAndUsage, AWS_COSTS_REFRESH_INTERVAL_MS };
