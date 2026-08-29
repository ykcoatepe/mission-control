'use strict';

const os = require('os');
const { execFile } = require('child_process');
const util = require('util');
const { DEFAULT_COMMAND_TIMEOUT_MS } = require('./constants');

const defaultExecFilePromise = util.promisify(execFile);

function createGBrainExecOptions(timeoutMs, options = {}) {
  const pathEntries = [
    `${os.homedir()}/.bun/bin`,
    '/opt/homebrew/bin',
    '/usr/local/bin',
    process.env.PATH || '',
  ].filter(Boolean);
  const execOptions = {
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      PATH: pathEntries.join(':'),
    },
  };
  if (options.suppressStartupHooks) {
    // Mission Control owns update/version presentation for read-only probes.
    // Startup notices on stderr can otherwise mask the real failure when a
    // probe exits non-zero during a brief database reconnect. Maintenance
    // actions keep startup rails (including durability warnings) visible.
    execOptions.env.GBRAIN_SKIP_STARTUP_HOOKS = '1';
  }
  if (timeoutMs > 0) execOptions.timeout = timeoutMs;
  return execOptions;
}

function sanitizeMessage(value) {
  return String(value || 'Unknown error')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9_-]+/g, 'sk-[redacted]')
    .replace(/\/(?:Users|home)\/[^/\s]+/g, '~')
    .slice(0, 220);
}

function parseJsonFromOutput(output) {
  const text = String(output || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch {}
  }

  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try {
      return JSON.parse(text.slice(firstBracket, lastBracket + 1));
    } catch {}
  }

  return null;
}

async function runGBrain(execFilePromise, args, options = {}) {
  if (options.softTimeoutMs > 0 && execFilePromise === defaultExecFilePromise) {
    return runGBrainWithSoftTimeout(args, options);
  }

  try {
    const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const result = await execFilePromise('gbrain', args, createGBrainExecOptions(timeoutMs, options));
    return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '' };
  } catch (error) {
    return {
      ok: false,
      stdout: error?.stdout || '',
      stderr: error?.stderr || '',
      error: sanitizeMessage(error?.stderr || error?.stdout || error?.message),
    };
  }
}

function runGBrainWithSoftTimeout(args, options = {}) {
  const timeoutMs = options.softTimeoutMs;
  const child = execFile('gbrain', args, createGBrainExecOptions(0));
  let stdout = '';
  let stderr = '';
  let settled = false;
  let exited = false;
  let hardKillTimer = null;

  if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk; });
  if (child.stderr) child.stderr.on('data', (chunk) => { stderr += chunk; });

  const cleanup = new Promise((resolve) => {
    const finish = () => {
      exited = true;
      if (hardKillTimer) clearTimeout(hardKillTimer);
      resolve();
    };
    child.once('exit', finish);
    child.once('error', finish);
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGINT');
      hardKillTimer = setTimeout(() => {
        if (!exited) child.kill('SIGKILL');
      }, options.hardKillDelayMs || 30000);
      resolve({
        ok: false,
        stdout,
        stderr,
        pending: true,
        cleanup,
        error: `gbrain ${args.slice(0, 2).join(' ')} exceeded ${Math.round(timeoutMs / 1000)}s and was asked to stop`,
      });
    }, timeoutMs);

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout,
        stderr,
        error: sanitizeMessage(error?.stderr || error?.stdout || error?.message),
      });
    });

    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true, stdout, stderr });
      } else {
        resolve({
          ok: false,
          stdout,
          stderr,
          error: sanitizeMessage(stderr || stdout || `gbrain exited with ${signal || `code ${code}`}`),
        });
      }
    });
  });
}

function summarizeCommandOutput(stdout, stderr) {
  const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
  return sanitizeMessage(combined || 'Command completed without output');
}

function sanitizePayload(value) {
  if (typeof value === 'string') return sanitizeMessage(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitizePayload(item));

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [sanitizeMessage(key), sanitizePayload(item)])
  );
}

module.exports = {
  defaultExecFilePromise,
  createGBrainExecOptions,
  sanitizeMessage,
  parseJsonFromOutput,
  runGBrain,
  runGBrainWithSoftTimeout,
  summarizeCommandOutput,
  sanitizePayload,
};
