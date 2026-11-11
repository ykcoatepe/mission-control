'use strict';

// The one sanitizer for text and paths that leave the process.
//
// scrubText(text)            free text (error messages, CLI diagnostics,
//                            action summaries, caveats): credentials go
//                            through config.redactString; then absolute
//                            filesystem paths under a user home become ~/...
// homeRelativePath(value)    a structured path field (settings folders, task
//                            workspaces): canonicalised against the real home
//                            and its aliases, then ~/...; a home path that
//                            cannot be rewritten confidently keeps only its
//                            last segment.
//
// Path policy for free text:
//   - URLs are recognised first (scheme://...) and their host and path are
//     never treated as filesystem paths; only a file: URL's path, and
//     percent-encoded home paths in a URL's query or fragment, are scrubbed.
//   - A home root is /Users/<name>, /home/<name> or /var/root (any case,
//     optionally under /private or /System/Volumes/Data), raw or with its
//     separators percent-encoded once (%2F), or a Windows home
//     (C:\Users\<name>, C:/Users/<name>, \\?\C:\Users\<name>, mixed
//     separators). Separators are matched escape-aware, so the same paths
//     inside JSON text (\\, \/, \u005c, nested levels) are scrubbed too.
//   - Relative paths, non-home absolute paths and prose stay byte-identical.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { redactString, truncationMarker } = require('./config');

// LINEAR TIME is part of the contract (see the rules in config.js above
// redactString): every quantifier that can be followed by a failure is
// bounded, and input is bounded before any scanning.
const SCRUB_MAX_CHARS = 64 * 1024;

const URL_TOKEN = /\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>`]+/gi;
// Separators are escape-aware: diagnostics often carry JSON (possibly nested),
// where "/" may be written "\/" or "\u002f" and "\" is doubled per level.
const BS = '\\\\{1,16}'; // a run of backslashes (one separator at any JSON depth)
const SEP = `(?:\\\\{0,16}/|%2f|${BS}u002f)`;
const WIN_SEP = `(?:${BS}/?|/|\\\\{0,16}u00(?:5c|2f)|%5c|%2f)`;
// A user name: anything that is not a separator, path-ending punctuation or
// a regex/glob metacharacter (so non-ASCII names work, patterns do not), or a \uXXXX escape of such a character.
const NAME = `(?:[^\\s/\\\\'"\`<>|;,:()\\[\\]{}^$+%?*#&=]|${BS}u(?!00(?:2f|5c))[0-9a-f]{4}){1,255}`;
const PATH_END = `(?=$|[\\s'"\`),;:<>|\\]}])`;
const ROOT_PREFIX = `(?:${SEP}private|${SEP}system${SEP}volumes${SEP}data)?`;
const HOME_ROOT = `${ROOT_PREFIX}(?:${SEP}(?:users|home)${SEP}${NAME}|${SEP}var${SEP}root)`;
// A path starts at a separator that is not glued to a word, dot, ~ or a
// preceding path segment (an escaped \n, \r or \t before it counts as
// whitespace); it ends at whitespace, a quote, or punctuation that cannot be
// part of a path in prose.
const ESCAPED_SPACE = `(?<=${BS}[nrt])`; // \n, \r, \t written out, at any JSON depth
const PATH_START = `(?:(?<![A-Za-z0-9._~%/\\\\-])|${ESCAPED_SPACE})`;
const POSIX_HOME_PATH = new RegExp(`${PATH_START}${HOME_ROOT}(?:(?=${SEP})|${PATH_END})((?:${SEP}[^\\s'"\`<>|;,)\\]}]*)?)`, 'gi');
// C:\Users\<name>, C:/Users/<name>, \\?\C:\Users\<name>, mixed separators,
// at any JSON escape depth.
const WINDOWS_HOME_PATH = new RegExp(`(?:(?<![A-Za-z0-9])|${ESCAPED_SPACE})(?:\\\\{2,32}\\?${BS})?[A-Za-z]:${WIN_SEP}Users${WIN_SEP}${NAME}(?:(?=${WIN_SEP})|${PATH_END})`, 'gi');
// A bare secret-key shape redactString leaves for prose safety ("sk-learn");
// diagnostics are stricter.
const LOOSE_SK = /\bsk-[A-Za-z0-9_-]{6,}/g;

function decodeOnce(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value.replace(/%2f/gi, '/');
  }
}

function scrubPosixPaths(text) {
  return text.replace(POSIX_HOME_PATH, (match, rest) => `~${rest ? decodeOnce(rest) : ''}`);
}

function scrubPathText(text) {
  // Windows first: "C:/Users/alice" must not be read as a POSIX /Users path.
  return scrubPosixPaths(text.replace(WINDOWS_HOME_PATH, '~'));
}

function scrubUrl(url) {
  const scheme = url.slice(0, url.indexOf(':')).toLowerCase();
  if (scheme === 'file') {
    // file:///Users/alice/x -> file://~/x ; the URL's path is a filesystem path.
    const pathStart = url.indexOf('/', 'file://'.length);
    if (pathStart < 0) return url;
    return url.slice(0, pathStart) + scrubPathText(url.slice(pathStart));
  }
  // Host and path of any other URL are never filesystem paths. Only an
  // encoded home path carried in the query or fragment is scrubbed.
  const cut = url.search(/[?#]/);
  if (cut < 0) return url;
  return url.slice(0, cut) + scrubPosixPaths(url.slice(cut));
}

/**
 * Free text: credentials, then home paths; URLs and non-home paths untouched.
 * The input is bounded BEFORE any scanning: text past `maxChars` is dropped
 * and replaced by a marker, never returned unscanned.
 */
function scrubText(input, { maxChars = SCRUB_MAX_CHARS } = {}) {
  if (typeof input !== 'string' || input === '') return input;
  const bounded = input.length > maxChars ? input.slice(0, maxChars) : input;
  const redacted = redactString(bounded, { maxChars }).replace(LOOSE_SK, '[redacted]');
  let out = '';
  let cursor = 0;
  URL_TOKEN.lastIndex = 0;
  for (let match = URL_TOKEN.exec(redacted); match; match = URL_TOKEN.exec(redacted)) {
    out += scrubPathText(redacted.slice(cursor, match.index)) + scrubUrl(match[0]);
    cursor = match.index + match[0].length;
  }
  out += scrubPathText(redacted.slice(cursor));
  return bounded === input ? out : out + truncationMarker(input.length - maxChars);
}

// --- structured path fields -------------------------------------------------

function realpathOrNull(value, fsImpl) {
  try {
    return fsImpl.realpathSync(value);
  } catch {
    return null;
  }
}

function stripTrailing(value) {
  return value.length > 1 ? value.replace(/\/+$/, '') : value;
}

// Every spelling of the home directory: as given, resolved, and with or
// without the macOS /private and /System/Volumes/Data prefixes.
function homeForms(homeDir, fsImpl) {
  const forms = new Set();
  const add = (value) => {
    if (typeof value !== 'string' || !value.startsWith('/')) return;
    const clean = stripTrailing(path.normalize(value));
    forms.add(clean);
    if (clean.startsWith('/private/')) forms.add(clean.slice('/private'.length));
    else if (/^\/(?:var|tmp|etc)\//.test(clean)) forms.add(`/private${clean}`);
    if (clean.startsWith('/System/Volumes/Data/')) forms.add(clean.slice('/System/Volumes/Data'.length));
    else if (clean.startsWith('/Users/')) forms.add(`/System/Volumes/Data${clean}`);
  };
  add(homeDir);
  add(realpathOrNull(homeDir, fsImpl));
  for (const form of [...forms]) add(realpathOrNull(form, fsImpl));
  return [...forms].sort((a, b) => b.length - a.length);
}

function underRoot(value, root, caseInsensitive) {
  const a = caseInsensitive ? value.toLowerCase() : value;
  const b = caseInsensitive ? root.toLowerCase() : root;
  if (a === b) return '';
  return a.startsWith(`${b}/`) ? value.slice(root.length) : null;
}

/**
 * A structured path for display. Under the home directory (any alias): ~/...
 * Another home path that cannot be rewritten confidently: its last segment
 * only. Anything else (relative, non-home): unchanged.
 */
function homeRelativePath(value, {
  homeDir = os.homedir(),
  fsImpl = fs,
  caseInsensitive = process.platform === 'darwin',
} = {}) {
  if (typeof value !== 'string' || !value) return value ?? null;
  if (!path.isAbsolute(value)) return value;
  const normalized = stripTrailing(path.normalize(value));
  const candidates = [normalized];
  const resolved = realpathOrNull(normalized, fsImpl);
  if (resolved && resolved !== normalized) candidates.push(resolved);
  for (const root of homeForms(homeDir, fsImpl)) {
    for (const candidate of candidates) {
      const rest = underRoot(candidate, root, caseInsensitive);
      if (rest !== null) return `~${rest}`;
    }
  }
  // A home path that cannot be rewritten confidently (another user's home, a
  // case variant where case is significant): never expose its directory.
  const roots = homeForms(homeDir, fsImpl);
  const caseOnly = roots.some((root) => candidates.some((candidate) => underRoot(candidate, root, true) !== null));
  if (caseOnly || scrubPathText(normalized) !== normalized) return path.basename(normalized);
  return value;
}

module.exports = { scrubText, homeRelativePath, SCRUB_MAX_CHARS };
