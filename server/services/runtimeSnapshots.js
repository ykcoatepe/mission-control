const fs = require('fs');
const path = require('path');

function createRuntimeSnapshotStore({ baseDir }) {
  function runtimeSnapshotPath(name) {
    return path.join(baseDir, `${name}.json`);
  }

  function readRuntimeSnapshot(name, maxAgeMs) {
    try {
      const filePath = runtimeSnapshotPath(name);
      if (!fs.existsSync(filePath)) return null;
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const generatedAt = payload?.generatedAt || payload?.updatedAt || null;
      const generatedMs = generatedAt ? Date.parse(generatedAt) : NaN;
      if (!Number.isFinite(generatedMs)) return null;
      if ((Date.now() - generatedMs) > maxAgeMs) return null;
      return payload;
    } catch {
      return null;
    }
  }

  function writeRuntimeSnapshot(name, payload) {
    try {
      fs.mkdirSync(baseDir, { recursive: true });
      const next = {
        ...payload,
        generatedAt: new Date().toISOString(),
      };
      const tmpPath = `${runtimeSnapshotPath(name)}.tmp-${Date.now()}`;
      fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), 'utf8');
      fs.renameSync(tmpPath, runtimeSnapshotPath(name));
      return next;
    } catch (error) {
      console.warn(`[runtime-snapshot:${name}]`, error.message);
      return payload;
    }
  }

  return {
    runtimeSnapshotPath,
    readRuntimeSnapshot,
    writeRuntimeSnapshot,
  };
}

module.exports = {
  createRuntimeSnapshotStore,
};
