const express = require('express');
const fs = require('fs');
const path = require('path');

function buildMemoryRouter({ memoryPath, workspacePath }) {
  const router = express.Router();

  router.get('/api/memory', (req, res) => {
    try {
      const scope = String(req.query.scope || 'all');
      const query = String(req.query.query || '').trim().toLowerCase();
      const limit = Math.max(1, Math.min(500, parseInt(String(req.query.limit || '120'), 10) || 120));
      const docs = [];

      const pushDoc = (filePath, scopeName) => {
        if (!fs.existsSync(filePath)) return;
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return;
        const fullText = fs.readFileSync(filePath, 'utf8');
        const normalized = path.resolve(filePath);
        const base = path.basename(filePath);
        const dateMatch = base.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
        const title = base === 'MEMORY.md' ? 'MEMORY.md' : base.replace(/\.md$/, '');
        const haystack = `${title}\n${fullText}`.toLowerCase();
        if (query && !haystack.includes(query)) return;

        docs.push({
          id: normalized,
          title,
          scope: scopeName,
          date: dateMatch ? dateMatch[1] : null,
          path: normalized,
          preview: fullText.slice(0, 280),
          fullText,
          updatedAt: stat.mtime.toISOString(),
        });
      };

      if ((scope === 'all' || scope === 'daily') && fs.existsSync(memoryPath)) {
        for (const name of fs.readdirSync(memoryPath)) {
          if (!/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) continue;
          pushDoc(path.join(memoryPath, name), 'daily');
        }
      }

      if (scope === 'all' || scope === 'longterm') {
        pushDoc(path.join(workspacePath, 'MEMORY.md'), 'longterm');
      }

      docs.sort((left, right) => new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());

      return res.json({
        documents: docs.slice(0, limit),
        total: docs.length,
        query: req.query.query || '',
        scope,
        limit,
      });
    } catch (error) {
      return res.status(500).json({ documents: [], total: 0, error: error.message || String(error) });
    }
  });

  return router;
}

module.exports = {
  buildMemoryRouter,
};
