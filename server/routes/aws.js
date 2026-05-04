const express = require('express');
const fs = require('fs');
const path = require('path');

const S3_PREFIX = 'images/mc-generated';

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildAwsRouter({
  execSync,
  exec: execAsync,
  AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY,
  AWS_REGION,
  mcConfig,
  s3Bucket,
}) {
  const router = express.Router();
  const awsEnv = {
    ...process.env,
    ...(AWS_ACCESS_KEY_ID ? { AWS_ACCESS_KEY_ID } : {}),
    ...(AWS_SECRET_ACCESS_KEY ? { AWS_SECRET_ACCESS_KEY } : {}),
    ...(AWS_REGION ? { AWS_REGION } : {}),
  };

  async function awsExec(args, timeout = 10000) {
    const command = ['aws', ...args.map((arg) => shellQuote(arg))].join(' ');
    return execAsync(command, {
      timeout,
      maxBuffer: 20 * 1024 * 1024,
      env: awsEnv,
    });
  }

  router.use('/api/aws', (req, res, next) => {
    if (!(mcConfig.modules?.aws && mcConfig.aws?.enabled)) {
      const disabledPayload = { disabled: true, error: 'AWS module disabled' };
      if (req.path === '/services') {
        return res.json({
          ...disabledPayload,
          account: { id: 'disabled', region: AWS_REGION, user: '' },
          services: [],
          credits: { total: 25000, note: 'AWS module disabled' },
        });
      }
      if (req.path === '/bedrock-models') return res.json([]);
      if (req.path === '/gallery') return res.json({ ...disabledPayload, images: [] });
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

  router.get('/api/aws/services', async (req, res) => {
    try {
      let account = { id: 'unknown', region: AWS_REGION };
      try {
        const { stdout } = await awsExec(['sts', 'get-caller-identity', '--output', 'json'], 5000);
        const sts = JSON.parse(stdout);
        account.id = sts.Account;
        account.user = (sts.Arn || '').split('/').pop();
      } catch {}

      const services = [];
      const checks = [
        { name: 'Amazon Bedrock', args: ['bedrock', 'list-foundation-models', '--query', 'length(modelSummaries)', '--output', 'text'], desc: 'Foundation models (Opus, Sonnet, Haiku)', parse: (value) => `${String(value).trim()} models available` },
        { name: 'Amazon Polly', args: ['polly', 'describe-voices', '--query', 'length(Voices)', '--output', 'text'], desc: 'Text-to-speech (Neural voices)', parse: (value) => `${String(value).trim()} voices` },
        { name: 'Amazon Transcribe', args: ['transcribe', 'list-transcription-jobs', '--max-results', '1', '--output', 'json'], desc: 'Speech-to-text', parse: () => 'Ready' },
        { name: 'Amazon Translate', args: ['translate', 'list-languages', '--query', 'length(Languages)', '--output', 'text'], desc: 'Translation', parse: (value) => `${String(value).trim()} languages` },
      ];

      for (const service of checks) {
        try {
          const { stdout } = await awsExec(service.args, 5000);
          services.push({ name: service.name, status: 'active', description: service.desc, detail: service.parse(stdout) });
        } catch {
          services.push({ name: service.name, status: 'available', description: service.desc, detail: 'Not available' });
        }
      }

      if (s3Bucket) {
        try {
          await awsExec(['s3api', 'head-bucket', '--bucket', s3Bucket], 5000);
          services.push({ name: 'Amazon S3', status: 'active', description: `Storage (${s3Bucket})`, detail: 'Bucket active' });
        } catch {
          services.push({ name: 'Amazon S3', status: 'available', description: `Storage (${s3Bucket})`, detail: 'Bucket not accessible' });
        }
      } else {
        services.push({ name: 'Amazon S3', status: 'available', description: 'Storage (not configured)', detail: 'Not configured' });
      }

      return res.json({
        account,
        services,
        credits: { total: 25000, note: 'AWS Activate credits' },
      });
    } catch (error) {
      console.error('AWS services error:', error);
      return res.status(500).json({ error: 'Failed to load AWS services' });
    }
  });

  router.get('/api/aws/bedrock-models', async (req, res) => {
    try {
      const query = "modelSummaries[?modelLifecycle.status=='ACTIVE'].{modelId:modelId,modelName:modelName,provider:providerName,input:inputModalities,output:outputModalities}";
      const { stdout } = await awsExec(['bedrock', 'list-foundation-models', '--query', query, '--output', 'json'], 10000);
      const models = JSON.parse(stdout || '[]');
      return res.json(models.map((model) => ({
        modelId: model.modelId,
        modelName: model.modelName,
        provider: model.provider,
        status: 'ACTIVE',
        inputModalities: model.input,
        outputModalities: model.output,
      })));
    } catch (error) {
      console.error('Bedrock models error:', error);
      return res.status(500).json({ error: 'Failed to load Bedrock models' });
    }
  });

  router.post('/api/aws/generate-image', async (req, res) => {
    try {
      const { modelId, prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt required' });
      if (!modelId || typeof modelId !== 'string') return res.status(400).json({ error: 'modelId required' });
      if (!s3Bucket) return res.status(400).json({ error: 'S3 bucket not configured' });

      const timestamp = Date.now();
      let payload;
      if (modelId.startsWith('amazon.nova-canvas') || modelId.startsWith('amazon.titan-image')) {
        payload = {
          taskType: 'TEXT_IMAGE',
          textToImageParams: { text: prompt },
          imageGenerationConfig: { numberOfImages: 1, height: 1024, width: 1024 },
        };
      } else if (modelId.startsWith('stability.')) {
        payload = {
          prompt,
          mode: 'text-to-image',
          output_format: 'png',
        };
      } else {
        return res.status(400).json({ error: `Unsupported image model: ${modelId}` });
      }

      const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64');
      const outFile = `/tmp/mc-image-${timestamp}.json`;
      await awsExec([
        'bedrock-runtime',
        'invoke-model',
        '--model-id',
        modelId,
        '--content-type',
        'application/json',
        '--accept',
        'application/json',
        '--body',
        payloadB64,
        outFile,
      ], 60000);

      const result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      const imageB64 = result.images?.[0] || result.image;
      if (!imageB64) {
        return res.status(500).json({ error: 'No image in response', keys: Object.keys(result) });
      }

      const slug = prompt.replace(/[^a-zA-Z0-9]+/g, '-').substring(0, 40).toLowerCase();
      const filename = `${timestamp}-${slug}.png`;
      const localPath = `/tmp/mc-image-${timestamp}.png`;
      fs.writeFileSync(localPath, Buffer.from(imageB64, 'base64'));

      const s3Key = `${S3_PREFIX}/${filename}`;
      await awsExec(['s3', 'cp', localPath, `s3://${s3Bucket}/${s3Key}`, '--content-type', 'image/png'], 30000);
      try { fs.unlinkSync(outFile); } catch {}

      return res.json({
        ok: true,
        message: 'Image generated and saved to S3!',
        imageUrl: `/api/aws/image/${timestamp}`,
        s3: `s3://${s3Bucket}/${s3Key}`,
      });
    } catch (error) {
      console.error('Image gen error:', error);
      return res.status(500).json({ error: error.message || 'Image generation failed' });
    }
  });

  router.get('/api/aws/image/:id', (req, res) => {
    const imgPath = `/tmp/mc-image-${req.params.id}.png`;
    if (fs.existsSync(imgPath)) {
      return res.type('png').sendFile(imgPath);
    }
    return res.status(404).json({ error: 'Image not found locally — check S3' });
  });

  router.get('/api/aws/gallery', async (req, res) => {
    try {
      if (!s3Bucket) return res.json({ images: [] });
      const { stdout } = await awsExec(['s3api', 'list-objects-v2', '--bucket', s3Bucket, '--prefix', `${S3_PREFIX}/`, '--output', 'json'], 10000);
      const data = JSON.parse(stdout);
      const images = (data.Contents || [])
        .filter((entry) => entry.Key.endsWith('.png'))
        .map((entry) => {
          const filename = entry.Key.split('/').pop();
          const id = filename.split('-')[0];
          return {
            id,
            url: `/api/aws/s3-image/${encodeURIComponent(entry.Key)}`,
            created: entry.LastModified,
            size: entry.Size,
            s3Key: entry.Key,
          };
        })
        .sort((left, right) => new Date(right.created).getTime() - new Date(left.created).getTime());
      return res.json({ images });
    } catch (error) {
      try {
        const files = fs.readdirSync('/tmp')
          .filter((file) => file.startsWith('mc-image-') && file.endsWith('.png'))
          .map((file) => {
            const id = file.replace('mc-image-', '').replace('.png', '');
            const stat = fs.statSync(`/tmp/${file}`);
            return { id, url: `/api/aws/image/${id}`, created: stat.mtime.toISOString(), size: stat.size };
          })
          .sort((left, right) => new Date(right.created).getTime() - new Date(left.created).getTime());
        return res.json({ images: files });
      } catch {
        return res.json({ images: [] });
      }
    }
  });

  // Express 5/path-to-regexp v8 no longer accepts `:key(*)`.
  // RegExp route preserves nested S3 keys like `images/foo/bar.png`.
  router.get(/^\/api\/aws\/s3-image\/(.+)$/, async (req, res) => {
    try {
      if (!s3Bucket) return res.status(404).json({ error: 'Image not found' });
      const key = decodeURIComponent(req.params[0]);
      const localCache = `/tmp/s3-cache-${key.replace(/\//g, '_')}`;
      if (!fs.existsSync(localCache)) {
        await awsExec(['s3', 'cp', `s3://${s3Bucket}/${key}`, localCache], 15000);
      }
      return res.type('png').sendFile(localCache);
    } catch {
      return res.status(404).json({ error: 'Image not found' });
    }
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
