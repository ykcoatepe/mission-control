'use strict';
const { rangeForPeriod: calendarKeys } = require('../../services/claudeCodeUsage');
// The active usage projections share the existing calendar-key calculation.
// Unix bounds are derived from those same keys, never from cached usage values.
function rangeForPeriod(period, anchor = null, now = new Date()) {
    const range = calendarKeys(period, now, anchor);
    const startKey = range.keys[0], endKey = range.keys.at(-1);
    const seconds = (key, end = false) => Math.floor(new Date(key + (end ? 'T23:59:59.999' : 'T00:00:00')).getTime() / 1000);
    return {
        ...range, startKey, endKey, startSec: seconds(startKey),
        endSec: range.anchor ? seconds(endKey, true) : Math.floor(now.getTime() / 1000),
        previousStartSec: seconds(range.previousKeys[0]), previousEndSec: seconds(range.previousKeys.at(-1), true),
    };
}
module.exports = { rangeForPeriod };
