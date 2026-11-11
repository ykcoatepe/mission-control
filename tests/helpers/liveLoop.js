'use strict';

// Production timers that only bound a wait (soft deadlines, lane queue
// timeouts, source read timeouts) are unref'd so they never hold the server
// open; in production the upstream's child process or socket keeps the event
// loop alive. A test fake has no such handle, so while a test awaits one of
// those timers the loop can be empty: Node's test runner then cancels the
// test ("Promise resolution is still pending but the event loop has already
// resolved") or the process exits early.
//
// withLiveLoop keeps the loop alive for exactly the scope of `fn` with one
// referenced interval that does nothing and is cleared in `finally`. It never
// settles a promise, advances a clock or changes when an assertion runs.
async function withLiveLoop(fn) {
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    return await fn();
  } finally {
    clearInterval(keepAlive);
  }
}

module.exports = { withLiveLoop };
