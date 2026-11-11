'use strict';

// Restricted-project classification (hard boundary: Argus content is never
// shown).
//
// THE GUARANTEE IS IDENTITY. A project whose id, folded, contains a configured
// marker (RESTRICTED_MARKERS plus the optional MC_RESTRICTED_PROJECT_MARKERS
// extension, comma-separated) is restricted before anything about it is read:
// no per-project command runs, nothing under its ledger directory is touched,
// and from the all-projects check only counts are kept (subjects are replaced
// by ordinals before counting).
//
// CONTENT MATCHING IS A HEURISTIC SECOND LINE. It exists for restricted text
// that turns up under an ordinary project id. It cannot be complete: text can
// be paraphrased, encoded or split in ways no matcher anticipates. What it
// does:
//   - fold every string: NFKC, lower case, combining marks and zero-width /
//     format characters removed, common homoglyphs mapped to Latin, every
//     non-letter dropped (so whitespace, punctuation and line breaks between
//     letters never hide the word; joining fields "with separators" and
//     "without" therefore folds to the same letters);
//   - find the marker inside one string, or split across strings in ANY
//     order: a marker prefix at the end of one string, zero or more strings
//     that are wholly marker letters, and the rest at the start of another.
//     Multi-line strings also count line by line, and a "Label:" prefix is
//     also tried without its label.
// It over-matches on purpose ("Oscar Gustav" folds to "...cargus..."): a
// false positive hides an ordinary project's text and keeps its counts.

const RESTRICTED_MARKERS = Object.freeze(['argus']);
const MARKERS_ENV = 'MC_RESTRICTED_PROJECT_MARKERS';

// Letters that render like Latin ones and survive NFKC. Lower case only:
// the text is lower-cased first.
const HOMOGLYPHS = new Map(Object.entries({
  'а': 'a', 'ɑ': 'a', 'α': 'a', 'ᴀ': 'a', // а ɑ α ᴀ
  'г': 'r', 'ʀ': 'r', 'ᴦ': 'r', 'ɼ': 'r', 'ɾ': 'r', // г ʀ ᴦ ɼ ɾ
  'ɡ': 'g', 'ց': 'g', 'ǥ': 'g', 'ɢ': 'g', // ɡ ց ǥ ɢ
  'υ': 'u', 'ս': 'u', 'ᴜ': 'u', 'ʋ': 'u', 'μ': 'u', // υ ս ᴜ ʋ μ
  'ѕ': 's', 'ꜱ': 's', 'ʂ': 's', 'ƽ': 's', // ѕ ꜱ ʂ ƽ
}));

function foldForMatch(value) {
  const text = String(value)
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\p{Cf}/gu, '');
  let out = '';
  for (const char of text) {
    const mapped = HOMOGLYPHS.get(char) || char;
    if (/\p{L}/u.test(mapped)) out += mapped;
  }
  return out;
}

// The configured set: the constant plus the optional env extension. An
// extension entry needs at least three letters after folding.
function restrictedMarkers(env = process.env) {
  const extra = String(env?.[MARKERS_ENV] || '')
    .split(',')
    .map(foldForMatch)
    .filter((marker) => marker.length >= 3);
  return Object.freeze([...new Set([...RESTRICTED_MARKERS, ...extra])]);
}

// Primary boundary.
function isRestrictedId(id, markers = RESTRICTED_MARKERS) {
  const folded = foldForMatch(id);
  return markers.some((marker) => folded.includes(marker));
}

// Every string in `value` (keys too when `keys`), plus each line of a
// multi-line string and a labelled line without its label. Walked, never
// serialised: JSON escapes would insert letters.
function collectStrings(value, { keys = true } = {}, out = [], depth = 0) {
  if (typeof value === 'string') {
    out.push(value);
    if (value.includes('\n') || value.includes(':')) {
      for (const line of value.split(/\r?\n/)) {
        out.push(line);
        const unlabelled = line.replace(/^[^:]{1,40}:/, '');
        if (unlabelled !== line) out.push(unlabelled);
      }
    }
    return out;
  }
  if (value === null || typeof value !== 'object') return out;
  if (depth > 20) {
    out.push(RESTRICTED_MARKERS[0]); // fail closed on absurd nesting
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, { keys }, out, depth + 1);
    return out;
  }
  for (const [key, item] of Object.entries(value)) {
    if (keys) out.push(key);
    collectStrings(item, { keys }, out, depth + 1);
  }
  return out;
}

// Indices of the strings that form a marker (one string, or a chain across
// strings in any order), or null. Strings are folded first.
function findMarkerChain(strings, markers = RESTRICTED_MARKERS) {
  const folded = strings.map(foldForMatch);
  for (const marker of markers) {
    for (let i = 0; i < folded.length; i += 1) if (folded[i].includes(marker)) return [i];
    const length = marker.length;
    // via[k]: a chain has produced the first k letters, ending at string `index`.
    const via = new Array(length).fill(null);
    for (let i = 0; i < folded.length; i += 1) {
      if (!folded[i]) continue;
      for (let k = 1; k < length; k += 1) {
        if (!via[k] && folded[i].endsWith(marker.slice(0, k))) via[k] = { index: i, prev: 0 };
      }
    }
    for (let k = 1; k < length; k += 1) {
      if (!via[k]) continue;
      const rest = marker.slice(k);
      for (let i = 0; i < folded.length; i += 1) {
        const text = folded[i];
        if (!text) continue;
        if (text.startsWith(rest)) {
          const chain = [i];
          for (let at = k; at > 0; at = via[at].prev) chain.unshift(via[at].index);
          return chain;
        }
        if (text.length < rest.length && rest.startsWith(text) && !via[k + text.length]) {
          via[k + text.length] = { index: i, prev: k };
        }
      }
    }
  }
  return null;
}

// Secondary boundary for one value (a project's raw material).
function containsRestrictedMarker(value, markers = RESTRICTED_MARKERS) {
  return findMarkerChain(collectStrings(value), markers) !== null;
}

module.exports = {
  MARKERS_ENV,
  RESTRICTED_MARKERS,
  collectStrings,
  containsRestrictedMarker,
  findMarkerChain,
  foldForMatch,
  isRestrictedId,
  restrictedMarkers,
};
