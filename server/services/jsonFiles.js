const fs = require('fs');

function readJsonFileSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// Temp file created 0600 (whatever the umask); the target keeps its existing
// mode. A failed write never leaves the temp file behind.
function writeJsonFileAtomic(filePath, data) {
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  let mode = 0o600;
  try {
    mode = fs.statSync(filePath).mode & 0o777;
  } catch {}
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, filePath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {}
    throw error;
  }
}

module.exports = {
  readJsonFileSafe,
  writeJsonFileAtomic,
};
