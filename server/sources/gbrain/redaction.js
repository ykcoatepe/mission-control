'use strict';
const { redactString } = require('../../core/config');
const { scrubText } = require('../../core/scrub');

// Bound BEFORE lexing, decoding, JSON parsing or shared-helper calls. Limits
// cannot be lifted by a caller. Nested examples use an explicit bounded stack.
const PAGE_SCAN_MAX_CHARS = 40_000;
const MAX_JSON_DEPTH = 8;
const WORK_BUDGET = PAGE_SCAN_MAX_CHARS * 12;
const MARKER = '…[truncated]';
const ENCODED_LIMIT = '[redacted: truncated encoded content]';
const KEYS = new Set(['token', 'pass', 'password', 'passwd', 'pwd', 'secret', 'apikey',
  'authorization', 'credential', 'secretkey', 'accesstoken', 'authtoken']);
// Prose is an explicit compatibility exception, not the default for any value
// containing a space. Credential names/aliases remain wholly core-owned.
const PROSE_LEADS = new Set(['a', 'an', 'the', 'this', 'that', 'these', 'those', 'use', 'read', 'see', 'review',
  'ship', 'please', 'do', "don't", 'keep', 'never', 'always', 'only', 'when', 'if', 'to', 'for', 'we', 'you',
  'your', 'our', 'it', 'they', 'there', 'here', 'is', 'are', 'should', 'must', 'can', 'will', 'would', 'note',
  'avoid', 'remember', 'write', 'check', 'set', 'choose', 'open', 'save', 'follow', 'refer', 'prefer', 'ordinary', 'readable']);
const whitespace = (c) => c !== undefined && /\s/u.test(c);
const isQuote = (c) => c === '"' || c === "'" || c === '`';
const isBoundary = (c) => c === ':' || c === '=' || c === '\n' || c === '\r'
  || c === '{' || c === '}' || c === '[' || c === ']' || c === ',' || c === ';';

function urlEnd(text, start) {
  // A bounded scheme check; a successful URL scan consumes its entire run.
  if (!/[A-Za-z]/.test(text[start]) || (start && /[A-Za-z0-9_.-]/.test(text[start - 1]))) return start;
  let end = start + 1;
  while (end - start < 32 && end < text.length && /[A-Za-z0-9+.-]/.test(text[end])) end++;
  if (!text.startsWith('://', end)) return start;
  end += 3;
  while (end < text.length && !whitespace(text[end]) && !isQuote(text[end]) && text[end] !== '<' && text[end] !== '>') end++;
  return end;
}
function lex(text) {
  const quotes = []; const boundaries = []; const urls = [];
  for (let i = 0; i < text.length;) {
    const end = urlEnd(text, i);
    if (end > i) { urls.push({ start: i, end }); i = end; continue; }
    const mark = text[i];
    if (isQuote(mark)) {
      const start = i++;
      while (i < text.length && text[i] !== mark) {
        if (text[i] === '\\' && i + 1 < text.length) i += 2;
        else i++;
      }
      const closed = i < text.length;
      if (closed) i++;
      quotes.push({ start, end: i, mark, closed });
    } else {
      if (isBoundary(mark)) boundaries.push({ index: i, mark });
      i++;
    }
  }
  return { quotes, boundaries, urls };
}
function quoteBody(text, token) {
  const raw = text.slice(token.start, token.end);
  if (token.closed && token.mark === '"') { try { return JSON.parse(raw); } catch {} }
  return raw.slice(1, token.closed ? -1 : undefined);
}
function keyName(raw) {
  let name = raw.trim();
  if (name.length > 128) return null;
  if (/^[-*+]\s/.test(name)) name = name.slice(1).trimStart();
  if (isQuote(name[0]) && name.at(-1) === name[0]) {
    if (name[0] === '"') { try { name = JSON.parse(name); } catch { return null; } }
    else name = name.slice(1, -1);
  }
  if (!/^[A-Za-z][A-Za-z0-9_. -]{0,127}$/.test(name)) return null;
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/^api(?:[ \t]{1,8}|[_.-])key$/, 'apikey')
    .replace(/^secret[_-]key$/, 'secretkey').replace(/^(access|auth)[_-]token$/, '$1token');
}
function wordsOf(value) {
  // One forward pass; at most three words are needed for all classifications.
  const words = [];
  for (let i = 0; i < value.length;) {
    while (i < value.length && whitespace(value[i])) i++;
    if (i === value.length) break;
    const start = i;
    while (i < value.length && !whitespace(value[i])) i++;
    words.push({ value: value.slice(start, i), start, end: i });
    if (words.length === 3) break;
  }
  return words;
}
function credentialKind(name) {
  if (KEYS.has(name)) return name;
  const words = name.split(/[_. -]/).filter(Boolean);
  const last = words.at(-1);
  if (last === 'key' && words.at(-2) === 'api') return 'apikey';
  return KEYS.has(last) ? last : null;
}
// The only explicit compatibility exception to core's strong-name assignment
// policy: a complete, single prose field, never a row with more assignments.
// It is applied AFTER core scrub. Core still sanitizes its prefix and RHS, so
// provider tokens, credentials embedded in URLs, paths and nested assignments
// cannot be restored from original text.
function proseView(text) {
  const tokens = lex(text);
  const assignments = tokens.boundaries.filter((b) => b.mark === ':' || b.mark === '=');
  if (assignments.length !== 1) return null;
  const separator = assignments[0].index;
  let keyStart = 0;
  while (keyStart < separator && (whitespace(text[keyStart]) || text[keyStart] === '{' || text[keyStart] === '[')) keyStart++;
  const name = keyName(text.slice(keyStart, separator));
  if (!name || !(KEYS.has(name) || name.includes(' ') || /(?:[_.-](?:hint|note))$/.test(name))) return null;
  let start = separator + 1;
  while (start < text.length && whitespace(text[start])) start++;
  let end = text.length;
  while (end > start && (whitespace(text[end - 1]) || (keyStart > 0 && (text[end - 1] === '}' || text[end - 1] === ']')))) end--;
  const quote = tokens.quotes.find((q) => q.start === start && q.end === end && q.closed);
  const body = quote ? quoteBody(text, quote) : text.slice(start, end);
  const urls = lex(body).urls;
  let count = 0; let urlIndex = 0; let firstWord = '';
  // A prose word is alphabetic with ordinary punctuation, not an opaque
  // credential, a number or a second field. Inspect every word, not a prefix.
  for (let i = 0; i < body.length;) {
    if (whitespace(body[i])) { i++; continue; }
    if (urls[urlIndex]?.start === i) { i = urls[urlIndex++].end; if (!count) firstWord = 'url'; count++; continue; }
    const from = i;
    while (i < body.length && !whitespace(body[i])) i++;
    if (i - from > 15 || !/^[A-Za-z'"`.,!?;:=-]{1,15}$/.test(body.slice(from, i))) return null;
    if (!count) {
      let fromWord = from; let toWord = i;
      while (fromWord < toWord && isQuote(body[fromWord])) fromWord++;
      while (toWord > fromWord && /['"`.,!?;:=-]/.test(body[toWord - 1])) toWord--;
      firstWord = body.slice(fromWord, toWord).toLowerCase();
    }
    count++;
  }
  const paddedShortWord = quote && count === 1 && body.trim() !== body && body.trim().length < 4;
  if (!paddedShortWord && (count < 2 || !PROSE_LEADS.has(firstWord))) return null;
  return scrubText(text.slice(0, start), { maxChars: WORK_BUDGET })
    + scrubText(text.slice(start, end), { maxChars: WORK_BUDGET })
    + scrubText(text.slice(end), { maxChars: WORK_BUDGET });
}
function coreFirst(text) {
  const core = scrubText(text, { maxChars: WORK_BUDGET });
  if (core === text) return core;
  const prose = proseView(text);
  if (prose !== null) return prose;
  const original = text.split('\n'); const lines = core.split('\n');
  if (original.length !== lines.length) return core;
  for (let i = 0; i < lines.length; i++) {
    if (original[i] === lines[i]) continue;
    const line = proseView(original[i]);
    if (line !== null && scrubText(original[i], { maxChars: WORK_BUDGET }) === lines[i]) lines[i] = line;
  }
  return lines.join('\n');
}
function pagePass(text) {
  const { quotes, boundaries, urls } = lex(text);
  // Value spans end at a structural delimiter, not at ':'/'=' inside a
  // credential. These tables make even overlapping candidate spans O(1) to
  // classify (token:token:... and authorization: authorization:...).
  const fields = boundaries.filter((b) => b.mark !== ':' && b.mark !== '=');
  const nextSpace = new Int32Array(text.length + 1);
  const nextWord = new Int32Array(text.length + 1);
  const priorWord = new Int32Array(text.length + 1);
  nextSpace[text.length] = nextWord[text.length] = text.length;
  for (let i = text.length - 1; i >= 0; i--) {
    const space = whitespace(text[i]);
    nextSpace[i] = space ? i : nextSpace[i + 1];
    nextWord[i] = space ? nextWord[i + 1] : i;
  }
  for (let i = 0; i < text.length; i++) priorWord[i + 1] = whitespace(text[i]) ? priorWord[i] : i + 1;
  const quoteEnds = new Map(quotes.filter((q) => q.closed).map((q) => [q.end, q]));
  const candidates = new Map(); const starts = [];
  for (const { index, mark } of boundaries) {
    if (mark !== ':' && mark !== '=') continue;
    const keyEnd = priorWord[index]; const quotedKey = quoteEnds.get(keyEnd);
    let keyStart = quotedKey?.start ?? keyEnd;
    if (!quotedKey) {
      while (keyStart > 0 && keyEnd - keyStart < 128 && /[A-Za-z0-9_.-]/.test(text[keyStart - 1])) keyStart--;
      if (keyStart > 0 && /[A-Za-z0-9_.-]/.test(text[keyStart - 1])) continue;
    }
    const name = keyName(text.slice(keyStart, keyEnd));
    if (name === null) continue;
    candidates.set(index, name);
    if (keyStart > 0 && whitespace(text[keyStart - 1])) starts.push(keyStart);
  }
  const edits = [];
  let previous = -1; let right = 0; let quoteIndex = 0; let nextAssignment = 0;
  for (let b = 0; b < boundaries.length; b++) {
    const { index, mark } = boundaries[b];
    const name = mark === ':' || mark === '=' ? keyName(text.slice(previous + 1, index)) : null;
    previous = index;
    const kind = (name === null ? null : credentialKind(name)) || credentialKind(candidates.get(index) || '');
    if (!kind) continue;
    const start = nextWord[index + 1];
    while (right < fields.length && fields[right].index < start) right++;
    while (nextAssignment < starts.length && starts[nextAssignment] <= start) nextAssignment++;
    const fieldEnd = right < fields.length ? fields[right].index : text.length;
    const end = priorWord[Math.min(fieldEnd, starts[nextAssignment] ?? text.length)];
    if (end <= start) continue;
    while (quoteIndex < quotes.length && quotes[quoteIndex].start < start) quoteIndex++;
    const quote = quotes[quoteIndex];
    const quoted = quote?.start === start && quote.end === end;
    const value = quoted ? quoteBody(text, quote) : null;
    const words = quoted ? wordsOf(value) : null;
    const firstEnd = Math.min(nextSpace[start], end);
    const secondStart = nextWord[firstEnd];
    const secondEnd = Math.min(nextSpace[secondStart], end);
    const oneWord = quoted ? words.length === 1 && words[0].start === 0 && words[0].end === value.length && value.length >= 4
      : firstEnd === end && end - start >= 4;
    const twoWords = quoted ? words.length === 2 : firstEnd < end && secondStart < end && secondEnd === end;
    const second = twoWords ? quoted ? words[1].value : text.slice(secondStart, Math.min(secondStart + 16, secondEnd)) : '';
    let replacement;
    if (oneWord) replacement = '[redacted]';
    else if (twoWords && /^(?:postgres(?:ql)?|mysql|redis):\/\//i.test(second.slice(0, 16))) {
      replacement = '[redacted] [redacted connection]';
    } else if (kind === 'authorization' && twoWords) {
      const scheme = quoted ? words[0].value : firstEnd - start <= 6 ? text.slice(start, firstEnd) : '';
      if (/^(?:basic|bearer|token|digest)$/i.test(scheme)) {
        replacement = redactString(`Authorization: ${quoted ? value : text.slice(start, end)}`).slice('Authorization: '.length);
      }
    }
    if (replacement !== undefined && replacement !== value) {
      edits.push({ start, end, replacement: quoted && quote.mark === '"' ? JSON.stringify(replacement)
        : quoted ? quote.mark + replacement + (quote.closed ? quote.mark : '') : replacement });
    }
  }
  for (const url of urls) if (/^(?:postgres(?:ql)?|mysql|redis):\/\//i.test(text.slice(url.start, url.start + 16))) {
    edits.push({ ...url, replacement: '[redacted connection]' });
  }
  // Positions arrive from two linear scanners. Sorting is unnecessary: bucket
  // edits by start, then consume the text once. Outer redactions win overlaps.
  const byStart = new Map();
  for (const edit of edits) {
    const old = byStart.get(edit.start);
    if (!old || edit.end > old.end) byStart.set(edit.start, edit);
  }
  const output = [];
  for (let i = 0; i < text.length;) {
    const edit = byStart.get(i);
    if (edit) { output.push(edit.replacement); i = edit.end; }
    else { output.push(text[i]); i++; }
  }
  return output.join('')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]');
}
function redactBounded(text) {
  let remaining = WORK_BUDGET; let limited = false;
  function frame(value, depth) {
    remaining -= value.length;
    const text = coreFirst(value);
    return { text, depth, quotes: lex(text).quotes, next: 0, cursor: 0, pieces: [] };
  }
  const stack = [frame(text, 0)]; let result = '';
  while (stack.length) {
    const current = stack.at(-1);
    if (current.next < current.quotes.length) {
      const token = current.quotes[current.next++];
      current.pieces.push(current.text.slice(current.cursor, token.start));
      current.cursor = token.end;
      const body = quoteBody(current.text, token);
      const render = (value) => value === body ? current.text.slice(token.start, token.end)
        : token.mark === '"' && token.closed ? JSON.stringify(value)
        : token.mark + value + (token.closed ? token.mark : '');
      if (!body) { current.pieces.push(render(body)); continue; }
      if (current.depth >= MAX_JSON_DEPTH || remaining < body.length) {
        limited = true; current.pieces.push(render(ENCODED_LIMIT)); continue;
      }
      // No recursive call: both stack depth and total decoded work are bounded.
      const child = frame(body, current.depth + 1); child.render = render;
      stack.push(child);
    } else {
      current.pieces.push(current.text.slice(current.cursor));
      result = pagePass(current.pieces.join(''));
      stack.pop();
      if (stack.length) stack.at(-1).pieces.push(current.render(result));
    }
  }
  return { text: result, limited };
}
function safeTextResult(value, max = 1000) {
  if (typeof value !== 'string') return { text: null, truncated: false };
  const limit = Number.isFinite(max) ? Math.max(0, Math.min(PAGE_SCAN_MAX_CHARS, Math.floor(max))) : 1000;
  let bounded = value.slice(0, PAGE_SCAN_MAX_CHARS);
  if (value.length > bounded.length) {
    // A cut is not proof that the final value is a complete short word. Drop
    // an incomplete quoted example or final lexical token before decoding;
    // earlier redactions may shorten output enough to expose that fragment.
    const lastQuote = lex(bounded).quotes.at(-1);
    if (lastQuote && !lastQuote.closed) bounded = bounded.slice(0, lastQuote.start);
    let end = bounded.length;
    while (end > 0 && !whitespace(bounded[end - 1]) && !isBoundary(bounded[end - 1])) end--;
    bounded = bounded.slice(0, end);
  }
  const result = redactBounded(bounded);
  const truncated = result.limited || value.length > bounded.length || result.text.length > limit;
  const body = truncated ? result.text.slice(0, Math.max(0, limit - MARKER.length)) : result.text;
  return { text: truncated ? body + MARKER.slice(0, limit) : body, truncated };
}
function safeText(value, max) { return safeTextResult(value, max).text; }
module.exports = { safeText, safeTextResult, PAGE_SCAN_MAX_CHARS };
