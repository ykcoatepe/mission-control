const express = require('express');

// Only GET /api/aws/costs remains: the Usage screen reads it while the AWS
// module is enabled. The route answers a disabled payload otherwise.
function buildAwsRouter({
  exec: execAsync,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  mcConfig,
}) {
  const router = express.Router();
  const awsEnv = {
    ...process.env,
    ...(AWS_ACCESS_KEY_ID ? { AWS_ACCESS_KEY_ID } : {}),
    ...(AWS_SECRET_ACCESS_KEY ? { AWS_SECRET_ACCESS_KEY } : {}),
    ...(AWS_REGION ? { AWS_REGION } : {}),
  };

  router.use('/api/aws', (req, res, next) => {
    if (!(mcConfig.modules?.aws && mcConfig.aws?.enabled)) {
      const disabledPayload = { disabled: true, error: 'AWS module disabled' };
      if (req.path === '/costs') {
        return res.json({
          ...disabledPayload,
          total: 0,
          remaining: 0,
          credits: 0,
          services: [],
        });
      }
      return res.status(404).json(disabledPayload);
    }
    return next();
  });

  router.get('/api/aws/costs', async (req, res) => {
    try {
      const startDate = new Date();
      startDate.setDate(1);
      const start = startDate.toISOString().split('T')[0];
      const end = new Date().toISOString().split('T')[0];
      const command = `aws ce get-cost-and-usage --time-period Start=${start},End=${end} --granularity DAILY --metrics BlendedCost --group-by Type=DIMENSION,Key=SERVICE --output json 2>/dev/null`;
      const { stdout } = await execAsync(command, { timeout: 15000, env: awsEnv });
      const data = JSON.parse(stdout);
      const services = {};
      const daily = [];
      let total = 0;

      for (const row of data.ResultsByTime || []) {
        const day = row.TimePeriod.Start;
        let dayTotal = 0;
        for (const group of row.Groups || []) {
          const service = group.Keys[0];
          const amount = parseFloat(group.Metrics.BlendedCost.Amount);
          if (amount > 0.001) {
            services[service] = (services[service] || 0) + amount;
            dayTotal += amount;
          }
        }
        daily.push({ date: day, cost: Math.round(dayTotal * 100) / 100 });
        total += dayTotal;
      }

      const serviceList = Object.entries(services)
        .map(([name, cost]) => ({ name, cost: Math.round(cost * 100) / 100 }))
        .sort((left, right) => right.cost - left.cost);

      return res.json({
        period: { start, end },
        total: Math.round(total * 100) / 100,
        daily,
        services: serviceList,
        credits: 25000,
        remaining: Math.round((25000 - total) * 100) / 100,
      });
    } catch (error) {
      console.error('AWS costs error:', error);
      return res.status(500).json({ error: 'Failed to load cost data' });
    }
  });

  return router;
}

module.exports = {
  buildAwsRouter,
};
