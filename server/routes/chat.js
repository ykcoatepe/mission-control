const express = require('express');
const util = require('util');
const { execFile } = require('child_process');

const execFilePromise = util.promisify(execFile);

function sseChunk(text) {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function sseDone() {
  return 'data: [DONE]\n\n';
}

function sseComment(text) {
  return `: ${text}\n\n`;
}

function latestUserMessage(messages = []) {
  const userMessages = Array.isArray(messages) ? messages.filter((message) => message?.role === 'user') : [];
  return String(userMessages[userMessages.length - 1]?.content || '').trim();
}

function extractAgentText(payload) {
  const directPayload = payload?.result?.payloads?.find((item) => item?.text)?.text;
  if (directPayload) return String(directPayload).trim();
  const visible = payload?.result?.finalAssistantVisibleText || payload?.result?.finalAssistantRawText;
  if (visible) return String(visible).trim();
  if (typeof payload?.result === 'string') return payload.result.trim();
  return '';
}

function isGatewayChatMiss(status, text) {
  const body = String(text || '').trim();
  return status === 404 || body === 'Not Found' || body.startsWith('<!doctype html>');
}

async function runMainAgent({ openclawBin, message, signal }) {
  const bin = openclawBin || 'openclaw';
  const { stdout } = await execFilePromise(
    bin,
    ['agent', '--agent', 'main', '--message', message, '--json', '--timeout', '180'],
    {
      timeout: 190000,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
      signal,
    },
  );
  const parsed = JSON.parse(stdout);
  const text = extractAgentText(parsed);
  if (!text) throw new Error('Müdür returned no usable text.');
  return text;
}

function buildChatRouter({ gatewayPort, gatewayToken, openclawBin }) {
  const router = express.Router();

  async function streamMainAgentFallback(req, res, message) {
    const controller = new AbortController();
    let closed = false;
    req.on('close', () => {
      closed = true;
      controller.abort();
    });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(sseComment('connected'));

    const keepAlive = setInterval(() => {
      if (closed || res.destroyed) return;
      res.write(sseComment('waiting-for-mudur'));
    }, 10000);

    try {
      const fallback = await runMainAgent({ openclawBin, message, signal: controller.signal });
      if (closed || res.destroyed) return;
      res.write(sseChunk(fallback));
    } catch (fallbackError) {
      if (closed || fallbackError.name === 'AbortError') return;
      res.write(sseChunk(`Müdür could not answer right now: ${fallbackError.message}`));
    } finally {
      clearInterval(keepAlive);
      if (!closed && !res.destroyed) {
        res.write(sseDone());
        res.end();
      }
    }
  }

  router.post('/api/chat', async (req, res) => {
    const { messages, stream } = req.body;
    const message = latestUserMessage(messages);

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const payload = JSON.stringify({
      model: 'openclaw',
      messages: messages || [],
      stream: !!stream,
      user: 'mission-control',
    });

    console.log('[Chat proxy] Sending to gateway, payload length:', Buffer.byteLength(payload));

    try {
      const gwRes = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${gatewayToken}`,
        },
        body: payload,
        signal: AbortSignal.timeout(120000),
      });

      if (!stream) {
        const text = await gwRes.text();
        if (!gwRes.ok && isGatewayChatMiss(gwRes.status, text)) {
          const controller = new AbortController();
          let closed = false;
          const abortFallback = () => {
            closed = true;
            controller.abort();
          };
          res.on('close', abortFallback);
          try {
            const fallback = await runMainAgent({ openclawBin, message, signal: controller.signal });
            if (closed || res.destroyed) return;
            return res.json({ choices: [{ message: { role: 'assistant', content: fallback } }] });
          } catch (fallbackError) {
            if (closed || fallbackError.name === 'AbortError') return;
            throw fallbackError;
          } finally {
            res.off('close', abortFallback);
          }
        }
        console.log('[Chat proxy] Gateway responded:', gwRes.status, text.substring(0, 100));
        return res.status(gwRes.status).send(text);
      }

      if (stream) {
        if (!gwRes.ok) {
          const text = await gwRes.text();
          if (isGatewayChatMiss(gwRes.status, text)) {
            return streamMainAgentFallback(req, res, message);
          }
          res.writeHead(gwRes.status, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          res.write(sseChunk(text || `Gateway chat failed with HTTP ${gwRes.status}`));
          res.write(sseDone());
          return res.end();
        }

        res.writeHead(gwRes.status, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });

        const reader = gwRes.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              res.end();
              break;
            }
            res.write(value);
          }
        };

        pump().catch((error) => {
          console.error('[Chat proxy] Stream error:', error.message);
          res.end();
        });

        req.on('close', () => {
          reader.cancel();
        });
      }
    } catch (error) {
      console.error('[Chat proxy] Fetch error:', error.message);
      if (stream) {
        return streamMainAgentFallback(req, res, message);
      }
      if (!res.headersSent) return res.status(502).json({ error: `Gateway error: ${error.message}` });
    }
  });

  return router;
}

module.exports = {
  buildChatRouter,
};
