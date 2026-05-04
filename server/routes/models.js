const express = require('express');

function buildModelsRouter({ openclawExec, parseFirstJson, prettyModelName, settingsService }) {
  const router = express.Router();

  router.get('/api/models', async (req, res) => {
    try {
      let raw = '';
      try {
        const { stdout, stderr } = await openclawExec(['models', 'list', '--json'], 12000);
        raw = [stdout, stderr].filter(Boolean).join('\n');
      } catch (error) {
        // `openclaw models list --json` can emit valid JSON on stdout while exiting
        // non-zero due optional missing env vars. Prefer usable JSON over a UI 500.
        raw = [error?.stdout, error?.stderr].filter(Boolean).join('\n');
        if (!raw.trim()) throw error;
      }
      const payload = parseFirstJson(raw, {});
      const models = payload.models || [];
      return res.json(models.map((model) => ({
        id: model.key,
        name: model.name || prettyModelName(model.key),
        contextWindow: model.contextWindow,
        input: model.input,
        local: !!model.local,
        available: model.available !== false,
        tags: model.tags || [],
      })));
    } catch (error) {
      const defaultModel = settingsService.getSettingsPayload().model;
      const fallbackIds = Array.from(new Set([
        defaultModel,
        'gpt-5.5',
      ].filter(Boolean)));
      return res.json(fallbackIds.map((id) => ({
        id,
        name: prettyModelName(id),
        contextWindow: null,
        input: 'text+image',
        local: id.startsWith('local-') || id.startsWith('ollama/'),
        available: id === defaultModel,
        tags: id === defaultModel ? ['default', 'fallback'] : ['fallback'],
      })));
    }
  });

  router.get('/api/model', async (req, res) => {
    try {
      return res.json({ model: settingsService.getSettingsPayload().model });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.post('/api/model', async (req, res) => {
    try {
      return res.json(await settingsService.setDefaultModel(req.body?.model));
    } catch (error) {
      console.error('Model switch error:', error);
      const status = error.message === 'model required' ? 400 : 500;
      return res.status(status).json({ error: error.message || 'Failed to switch model' });
    }
  });

  return router;
}

module.exports = {
  buildModelsRouter,
};
