const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

function formatSize(sizeBytes) {
  if (sizeBytes > 1024 * 1024) return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  if (sizeBytes > 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${sizeBytes} B`;
}

function buildDocsRouter({ projectRoot }) {
  const router = express.Router();
  const docsDir = path.join(projectRoot, 'documents');
  const uploadDir = path.join(docsDir, '.tmp');
  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

  router.get('/api/docs', (req, res) => {
    try {
      const files = fs.existsSync(docsDir) ? fs.readdirSync(docsDir).filter((file) => !file.startsWith('.')) : [];
      const documents = files.map((file) => {
        const stat = fs.statSync(path.join(docsDir, file));
        const ext = path.extname(file).replace('.', '');
        const sizeBytes = stat.size;
        return {
          id: file,
          name: file,
          type: ext,
          size: formatSize(sizeBytes),
          sizeBytes,
          chunks: Math.max(1, Math.round(sizeBytes / 500)),
          modified: stat.mtime.toISOString(),
        };
      });
      return res.json({ documents, total: documents.length });
    } catch {
      return res.json({ documents: [], total: 0 });
    }
  });

  router.post('/api/docs/upload', upload.array('files', 20), (req, res) => {
    try {
      const uploaded = [];
      for (const file of req.files || []) {
        const original = String(file.originalname || 'upload');
        let safeName = path.basename(original).replace(/[^a-zA-Z0-9._ -]/g, '_');
        if (!safeName || safeName === '.' || safeName === '..') safeName = `upload-${Date.now()}`;

        let dest = path.join(docsDir, safeName);
        if (fs.existsSync(dest)) {
          dest = path.join(docsDir, `${Date.now()}-${safeName}`);
        }

        fs.renameSync(file.path, dest);
        uploaded.push(path.basename(dest));
      }
      return res.json({ ok: true, uploaded });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/cron-search', (req, res) => {
    return res.sendFile(path.join(projectRoot, 'public/cron-search.html'));
  });

  return router;
}

module.exports = {
  buildDocsRouter,
};
