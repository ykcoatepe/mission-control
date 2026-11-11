'use strict';

// Restricted-project classification (hard boundary: Argus content is never
// shown). The markers below are the one configuration; everything that
// decides "restricted" goes through containsRestrictedMarker().
//
// Matching runs on COMPLETE RAW material (before any scrub, truncation or
// field whitelist) after folding: NFKC, lower case, combining marks and
// zero-width/format characters removed, common homoglyphs mapped to Latin,
// then every non-letter dropped so separators between letters do not hide
// the word. This over-matches on purpose (for example "Oscar Gustav" folds
// to "...cargus..."): a false positive hides an ordinary project's text and
// keeps its counts; a false negative would show restricted content.

const RESTRICTED_MARKERS = Object.freeze(['argus']);

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

function textHasMarker(text) {
  const folded = foldForMatch(text);
  return RESTRICTED_MARKERS.some((marker) => folded.includes(marker));
}

// Any string anywhere in `value`: arrays and objects are walked (keys and
// values), never serialised, since JSON escapes would insert letters.
function containsRestrictedMarker(value, depth = 0) {
  if (typeof value === 'string') return textHasMarker(value);
  if (value === null || typeof value !== 'object') return false;
  if (depth > 20) return true; // fail closed on absurd nesting
  if (Array.isArray(value)) return value.some((item) => containsRestrictedMarker(item, depth + 1));
  return Object.entries(value).some(([key, item]) => textHasMarker(key) || containsRestrictedMarker(item, depth + 1));
}

module.exports = { RESTRICTED_MARKERS, containsRestrictedMarker, foldForMatch };
