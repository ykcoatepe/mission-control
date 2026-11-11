'use strict';
const { httpError } = require('../../core/http');

// Admission is separate from replacement: a new empty/failed read can never
// displace last-good data. Bounded staging lets successful new keys replace old
// good entries without making a full good cache permanently reject new queries.
function createEvidenceCache({ capacity, useful, pendingCapacity = 6 }) {
  const entries = new Map();
  const pending = new Map();
  const idle = (s) => !s.status().refreshing;
  function get(key, create) {
    if (entries.has(key)) return entries.get(key);
    if (pending.has(key)) return pending.get(key);
    const empty = [...entries].find(([, s]) => idle(s) && !useful(s.snapshot().data));
    if (entries.size < capacity || empty) {
      if (empty) entries.delete(empty[0]);
      const source = create(); entries.set(key, source); return source;
    }
    if (pending.size >= pendingCapacity) {
      const victim = [...pending].find(([, s]) => idle(s) && !useful(s.snapshot().data));
      if (!victim) throw httpError(429, 'gbrain_lookup_busy', 'GBrain lookup capacity reached');
      pending.delete(victim[0]);
    }
    const source = create(); pending.set(key, source); return source;
  }
  function promote(key) {
    const source = pending.get(key);
    if (!source || source.snapshot().meta.error || !useful(source.snapshot().data) || !idle(source)) return;
    const victim = [...entries].find(([, s]) => idle(s) && !useful(s.snapshot().data))
      || [...entries].find(([, s]) => idle(s));
    if (entries.size >= capacity && !victim) return;
    if (victim) entries.delete(victim[0]);
    pending.delete(key); entries.set(key, source);
  }
  return { get, promote, values: () => [...entries.values(), ...pending.values()],
    items: () => [...entries, ...pending] };
}
module.exports = { createEvidenceCache };
