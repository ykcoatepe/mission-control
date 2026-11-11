'use strict';

// The one state vocabulary and its one ordering, for every area (GBrain
// verdict and synoptic, Operations, signals, the timeline ledger) and equal
// to the frontend's worstState (frontend/src/lib/state.ts; a test compares
// the two). Worst first:
//
//   critical > warning > unavailable > healthy > inactive
//
// An observed condition outranks missing evidence; missing evidence still
// outranks healthy (absence of evidence is not green); inactive never
// degrades an aggregate. tests/scrubAndStateFinal.test.js fails when another
// rank table or state-order array appears under server/.

const STATE_ORDER = Object.freeze(['critical', 'warning', 'unavailable', 'healthy', 'inactive']);
const STATE_RANK = Object.freeze(Object.fromEntries(STATE_ORDER.map((state, index) => [state, STATE_ORDER.length - 1 - index])));

function isState(value) {
  return typeof value === 'string' && Object.hasOwn(STATE_RANK, value);
}

/** Rank of a state (higher = worse); an unknown word ranks like `fallback`. */
function stateRank(value, fallback = 'unavailable') {
  return isState(value) ? STATE_RANK[value] : STATE_RANK[fallback] ?? -1;
}

/** The worst of several states. An empty (or all-unknown) list was not read: `empty`. */
function worstState(states, { empty = 'unavailable' } = {}) {
  const list = (states || []).filter(isState);
  if (!list.length) return empty;
  return list.reduce((worst, state) => (STATE_RANK[state] > STATE_RANK[worst] ? state : worst));
}

/** Sort comparator: worst first. */
function bySeverity(a, b) {
  return stateRank(b) - stateRank(a);
}

module.exports = { STATE_ORDER, STATE_RANK, isState, stateRank, worstState, bySeverity };
