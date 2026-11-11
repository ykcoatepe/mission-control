'use strict';

// The one "needs the operator" number. /api/signals (attention) and
// /api/loops (totals.needsOperator) both call needsOperator(), so the top
// bar, the sidebar and the Attention page show the same count.
//
//   count = systems               Operations overview attention items
//         + findings              manager-loop findings rated warning/error,
//                                 excluding overdue-confirmation findings
//         + overdueConfirmations  pending confirmations past their deadline
//         + restricted            restricted (Argus) projects: the same two
//                                 kinds, by count only
//
// Info findings are not operator work. A TEYIT_STALE finding is the same
// thing as the overdue confirmations it summarises, so it is counted once,
// as overdue. A part that was not read is null (never 0) and the count is
// the sum of the parts that were read.

const { worstState } = require('../../core/state');

// Findings that stand for a pending live confirmation; TEYIT_STALE = past
// its deadline (aggregated rows carry `count`).
const CONFIRMATION_CODES = new Set([
  'TEYIT_DUE', 'TEYIT_STALE', 'TEYIT_UNRESOLVED', 'DEPLOYED_UNCONFIRMED', 'ACCEPTED_NOT_LIVE',
]);
const OVERDUE_CODES = new Set(['TEYIT_STALE']);
// mloop severity -> state vocabulary (server/core/state.js).
const LOOP_STATE = Object.freeze({ error: 'critical', warning: 'warning' });

function isOperatorFinding(finding) {
  return Boolean(LOOP_STATE[finding?.severity]) && !OVERDUE_CODES.has(finding?.code);
}

function needsOperator({ systemsAttention = null, loops = null } = {}) {
  if (!Array.isArray(systemsAttention) && !loops) return null;
  const states = [];
  const breakdown = { systems: null, findings: null, overdueConfirmations: null, restricted: null };
  if (Array.isArray(systemsAttention)) {
    breakdown.systems = systemsAttention.length;
    for (const item of systemsAttention) states.push(item?.severity);
  }
  if (loops && Array.isArray(loops.projects)) {
    breakdown.findings = 0;
    breakdown.overdueConfirmations = 0;
    breakdown.restricted = 0;
    for (const project of loops.projects) {
      if (project.restricted) {
        const findings = Number(project.operatorFindings) || 0;
        const overdue = Number(project.overdueConfirmations) || 0;
        breakdown.restricted += findings + overdue;
        if (findings + overdue > 0) states.push(LOOP_STATE[project.worstSeverity] || 'warning');
        continue;
      }
      for (const finding of project.findings || []) {
        if (!isOperatorFinding(finding)) continue;
        breakdown.findings += 1;
        states.push(LOOP_STATE[finding.severity]);
      }
      const overdue = (project.pendingConfirmations || []).filter((item) => item.overdue).length;
      breakdown.overdueConfirmations += overdue;
      if (overdue) states.push('warning');
    }
  }
  const count = Object.values(breakdown).reduce((sum, part) => sum + (part ?? 0), 0);
  return { count, worst: worstState(states, { empty: null }), breakdown };
}

module.exports = { CONFIRMATION_CODES, OVERDUE_CODES, LOOP_STATE, isOperatorFinding, needsOperator };
