'use strict';

function requiresExplicitConfirmation(definition, payload) {
  return definition?.safetyClass === 'W1'
    && definition.requiresConfirmation === true
    && payload?.confirmed !== true;
}

module.exports = { requiresExplicitConfirmation };
