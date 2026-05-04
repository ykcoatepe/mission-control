const express = require('express');
const fs = require('fs');
const path = require('path');
const { parseFirstJson } = require('../services/cronData');

const TEAM_CAPABILITIES = [
  { key: 'orchestration', label: 'Orchestration', emoji: '🎛️', required: true },
  { key: 'delivery', label: 'Delivery', emoji: '🧩', required: true },
  { key: 'assurance', label: 'Assurance', emoji: '✅', required: true },
  { key: 'governance', label: 'Governance', emoji: '🏛️', required: true },
  { key: 'research', label: 'Research', emoji: '🔍', required: false },
  { key: 'trade', label: 'Trade', emoji: '📈', required: false },
  { key: 'risk', label: 'Risk', emoji: '🛡️', required: false },
  { key: 'knowledge', label: 'Knowledge', emoji: '🧠', required: false },
  { key: 'ops', label: 'Ops', emoji: '⚙️', required: false },
];

function capabilityMeta(capability) {
  return TEAM_CAPABILITIES.find((item) => item.key === capability) || { key: capability || 'ops', label: capability || 'Ops', emoji: '🤖', required: false };
}

function normalizeTextRole(value) {
  if (!value) return '';
  const normalized = String(value).toLowerCase().trim();
  if (!normalized) return '';

  const mapping = {
    'main-orchestrator': 'orchestration',
    orchestrator: 'orchestration',
    'execution-agent': 'delivery',
    execution: 'delivery',
    'code-implementer': 'delivery',
    'code-planner': 'delivery',
    'order-packager': 'delivery',
    'code-reviewer': 'assurance',
    'qa-verifier': 'assurance',
    qa: 'assurance',
    'risk-governor': 'risk',
    'council-router-l1': 'governance',
    'event-governance-auditor': 'governance',
    'memory-curator': 'knowledge',
    toolsmith: 'ops',
    'writer-editor': 'ops',
    'watchlist-curator': 'trade',
    'trader-assistant': 'trade',
    'portfolio-journaler': 'trade',
    'growth-scout': 'research',
    'macro-analyst': 'research',
    'market-regime-tracker': 'research',
    'earnings-sentinel': 'research',
    'news-scout': 'research',
    'shopping-research': 'research',
    'doc-extractor': 'research',
    'ticket-link-finder': 'research',
    'ci-doctor': 'ops',
    'token-budget-auditor': 'governance',
    doktor: 'research',
    trade: 'trade',
    risk: 'risk',
    research: 'research',
    ops: 'ops',
    governance: 'governance',
    delivery: 'delivery',
    assurance: 'assurance',
    knowledge: 'knowledge',
    orchestration: 'orchestration',
  };

  if (mapping[normalized]) return mapping[normalized];
  if (normalized.includes('govern')) return 'governance';
  if (normalized.includes('review') || normalized.includes('qa')) return 'assurance';
  if (normalized.includes('risk')) return 'risk';
  if (normalized.includes('trade') || normalized.includes('watchlist') || normalized.includes('portfolio')) return 'trade';
  if (normalized.includes('research') || normalized.includes('macro') || normalized.includes('news') || normalized.includes('shopping') || normalized.includes('extract')) return 'research';
  if (normalized.includes('memory') || normalized.includes('knowledge')) return 'knowledge';
  if (normalized.includes('tool') || normalized.includes('ops') || normalized.includes('doctor')) return 'ops';
  if (normalized.includes('deliver') || normalized.includes('execution') || normalized.includes('implement') || normalized.includes('order')) return 'delivery';
  if (normalized.includes('orchestr')) return 'orchestration';
  return '';
}

function prettyModelName(modelKey) {
  if (!modelKey) return '—';
  if (modelKey.includes('gpt-5.3-codex')) return 'GPT-5.3 Codex';
  if (modelKey.includes('gpt-5.2-codex')) return 'GPT-5.2 Codex';
  return modelKey
    .replace(/^openai-codex\//, '')
    .replace(/^openai\//, '')
    .replace(/^anthropic\//, '')
    .replace(/^ollama\//, '')
    .replace(/_/g, '-');
}

function getOpenclawDefaultModelKey(openclawConfigPath) {
  try {
    const cfg = JSON.parse(fs.readFileSync(openclawConfigPath, 'utf8'));
    return cfg?.agents?.defaults?.model?.primary
      || cfg?.agents?.defaults?.model?.default
      || cfg?.model?.default
      || '';
  } catch {
    return '';
  }
}

function inferAgentRole(agent) {
  const keys = [agent?.id, agent?.identityId, agent?.identityName, agent?.name, agent?.role, agent?.workspace]
    .filter(Boolean)
    .map((value) => String(value));
  for (const key of keys) {
    const capability = normalizeTextRole(key);
    if (capability) return capabilityMeta(capability).label;
  }
  return 'Ops';
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function registryAgentId(entry) {
  return String(entry?.agent_id || entry?.id || '').trim();
}

function registryIdentity(entry) {
  return entry?.identity && typeof entry.identity === 'object' ? entry.identity : {};
}

function registryModelAssignment(entry) {
  return entry?.model_assignment && typeof entry.model_assignment === 'object' ? entry.model_assignment : {};
}

function registryTaskDefinition(entry) {
  return entry?.task_definition && typeof entry.task_definition === 'object' ? entry.task_definition : {};
}

function registryMetadata(entry) {
  return entry?.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
}

function registryStatusForMember(registryEntry, runtimeAgent) {
  if (registryEntry && runtimeAgent) return 'registered';
  if (registryEntry) return 'registered';
  return 'unregistered';
}

function runtimeStatusForMember(registryEntry, runtimeAgent) {
  if (runtimeAgent) return 'active';
  if (registryEntry) return 'inactive';
  return 'inactive';
}

function memberSource(registryEntry, runtimeAgent) {
  if (registryEntry && runtimeAgent) return 'merged';
  if (registryEntry) return 'registry';
  if (runtimeAgent) return 'openclaw';
  return 'registry';
}

function inferCapabilityFromRegistry(entry) {
  const identity = registryIdentity(entry);
  const task = registryTaskDefinition(entry);
  const metadata = registryMetadata(entry);
  const candidates = [
    registryAgentId(entry),
    identity?.role || entry?.role,
    identity?.domain || metadata?.domain || entry?.domain,
    ...(Array.isArray(task?.responsibilities) ? task.responsibilities : Array.isArray(entry?.responsibilities) ? entry.responsibilities : []),
    ...(Array.isArray(task?.outputs) ? task.outputs : Array.isArray(entry?.outputs) ? entry.outputs : []),
  ];
  for (const candidate of candidates) {
    const capability = normalizeTextRole(candidate);
    if (capability) return capability;
  }
  return 'ops';
}

function inferCapabilityFromRuntime(agent) {
  const keys = [agent?.id, agent?.identityId, agent?.identityName, agent?.name, agent?.role, agent?.workspace];
  for (const key of keys) {
    const capability = normalizeTextRole(key);
    if (capability) return capability;
  }
  return 'ops';
}

function detectAgentName(workspacePath) {
  try {
    const identityPath = path.join(workspacePath, 'IDENTITY.md');
    if (!fs.existsSync(identityPath)) return 'OpenClaw Agent';
    const identity = fs.readFileSync(identityPath, 'utf8');
    const match = identity.match(/\*\*Name:\*\*\s*(.+)/);
    return match ? match[1].trim() : 'OpenClaw Agent';
  } catch {
    return 'OpenClaw Agent';
  }
}

async function fetchOpenclawModelCatalog(openclawExec) {
  const catalog = {
    byKey: new Map(),
    aliasToKey: new Map(),
  };

  try {
    const { stdout } = await openclawExec(['models', 'list', '--json'], 2000);
    const payload = parseFirstJson(stdout, {});
    const models = Array.isArray(payload?.models) ? payload.models : [];
    for (const model of models) {
      const key = String(model?.key || '').trim();
      if (!key) continue;
      catalog.byKey.set(key, {
        key,
        name: String(model?.name || '').trim() || prettyModelName(key),
      });
      const tags = Array.isArray(model?.tags) ? model.tags : [];
      for (const tag of tags) {
        const raw = String(tag || '').trim();
        if (!raw.startsWith('alias:')) continue;
        const alias = raw.slice('alias:'.length).trim();
        if (alias) catalog.aliasToKey.set(alias, key);
      }
    }
  } catch {}

  try {
    const { stdout } = await openclawExec(['models', 'aliases', 'list', '--json'], 6000);
    const payload = parseFirstJson(stdout, {});
    const aliases = payload?.aliases && typeof payload.aliases === 'object' ? payload.aliases : {};
    for (const [alias, key] of Object.entries(aliases)) {
      const aliasKey = String(alias || '').trim();
      const modelKey = String(key || '').trim();
      if (aliasKey && modelKey) catalog.aliasToKey.set(aliasKey, modelKey);
    }
  } catch {}

  return catalog;
}

function emptyModelCatalog() {
  return {
    byKey: new Map(),
    aliasToKey: new Map(),
  };
}

function resolveAgentModel(agent, overrides = {}, modelCatalog = null) {
  const configured = typeof agent?.model === 'string' ? agent.model.trim() : '';
  const overrideRecord = typeof overrides === 'object' ? (overrides[agent?.id] || {}) : {};
  const overrideModel = typeof overrideRecord?.model === 'string' ? overrideRecord.model.trim() : '';
  const rawModelKey = overrideModel || configured;
  const canonicalModelKey = modelCatalog?.aliasToKey?.get(rawModelKey) || rawModelKey;
  const catalogEntry = modelCatalog?.byKey?.get(canonicalModelKey) || null;
  return {
    modelKey: canonicalModelKey,
    modelLabel: catalogEntry?.name || prettyModelName(canonicalModelKey),
  };
}

function taskPreviewScore(task) {
  const column = String(task?.column || '').trim();
  const priority = String(task?.priority || '').trim().toLowerCase();
  const columnWeight = column === 'inProgress' ? 120 : column === 'blocked' ? 105 : column === 'queue' ? 90 : 10;
  const priorityWeight = priority === 'high' ? 30 : priority === 'medium' ? 18 : priority === 'low' ? 8 : 0;
  const updatedAt = new Date(task?.updatedAt || task?.startedAt || task?.created || task?.completed || 0).getTime() || 0;
  return columnWeight + priorityWeight + Math.round(updatedAt / 1_000_000_000_000);
}

function readTaskCountsByAssignee(tasksFile) {
  const counts = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
    const columns = parsed?.columns || {};
    for (const column of ['queue', 'inProgress', 'blocked', 'done']) {
      for (const task of columns[column] || []) {
        const assignee = String(task?.assignee || task?.owner || task?.agentId || task?.agent || '').trim();
        if (!assignee) continue;
        if (!counts[assignee]) {
          counts[assignee] = {
            open: 0,
            running: 0,
            blocked: 0,
            done: 0,
            paths: { direct: 0, taskPath: 0, automation: 0 },
            lastExecutionPath: null,
            taskPreview: [],
          };
        }
        if (column === 'inProgress') counts[assignee].running += 1;
        else if (column === 'done') counts[assignee].done += 1;
        else {
          counts[assignee].open += 1;
          if (column === 'blocked') counts[assignee].blocked += 1;
        }
        const executionPath = String(task?.executionPath || '').trim().toLowerCase();
        if (executionPath === 'direct') counts[assignee].paths.direct += 1;
        else if (executionPath === 'automation') counts[assignee].paths.automation += 1;
        else counts[assignee].paths.taskPath += 1;
        counts[assignee].lastExecutionPath = executionPath || counts[assignee].lastExecutionPath || null;
        counts[assignee].taskPreview.push({
          id: String(task?.id || '').trim(),
          title: String(task?.title || '').trim() || 'Untitled task',
          column,
          priority: String(task?.priority || 'medium').trim().toLowerCase(),
          status: String(task?.status || '').trim() || column,
          tags: Array.isArray(task?.tags) ? task.tags.slice(0, 3) : [],
          executionPath: executionPath || 'task-path',
          source: task?.source ? String(task.source) : null,
          updatedAt: task?.updatedAt || task?.lastReviewedAt || task?.startedAt || task?.created || task?.completed || null,
        });
      }
    }
    Object.values(counts).forEach((entry) => {
      entry.taskPreview = (entry.taskPreview || [])
        .filter((task) => task.id)
        .sort((left, right) => taskPreviewScore(right) - taskPreviewScore(left))
        .slice(0, 4);
    });
  } catch {}
  return counts;
}

function buildLegacyTeamStructurePayload({
  openclawAgents,
  now,
  modelCatalog,
  overrides,
  fallbackAgentName,
  fallbackModelKey,
}) {
  const legacyRoles = [
    { key: 'trade', label: 'Trade', emoji: '📈' },
    { key: 'growth', label: 'Growth', emoji: '🚀' },
    { key: 'risk', label: 'Risk', emoji: '🛡️' },
    { key: 'ops', label: 'Ops', emoji: '⚙️' },
    { key: 'macro', label: 'Macro', emoji: '📊' },
    { key: 'execution', label: 'Execution', emoji: '🧩' },
    { key: 'research', label: 'Research', emoji: '🔍' },
  ];

  const members = Array.isArray(openclawAgents) ? openclawAgents.map((agent) => {
    const { modelKey, modelLabel } = resolveAgentModel(agent, overrides, modelCatalog);
    const responsibilities = Array.isArray(agent?.tasks) && agent.tasks.length ? agent.tasks.slice(0, 2) : ['Task orchestration', 'Execution support'];
    return {
      id: String(agent.id || agent.identityId || '').trim(),
      name: agent.identityName || agent.name || agent.id || 'agent',
      emoji: agent.identityEmoji || '🤖',
      model: modelLabel,
      modelKey,
      workspace: agent.workspace || null,
      role: inferAgentRole(agent),
      responsibilities,
    };
  }) : [];

  if (members.length === 0) {
    members.push({
      id: 'main',
      name: fallbackAgentName,
      emoji: '🤖',
      model: prettyModelName(fallbackModelKey),
      modelKey: fallbackModelKey,
      workspace: null,
      role: 'General',
      responsibilities: ['Main orchestration'],
    });
  }

  const lead = members.find((member) => member.id === 'main' || member.id === 'default') || members[0];
  const groupsMap = new Map();
  for (const member of members) {
    const roleName = member.role || 'General';
    if (!groupsMap.has(roleName)) groupsMap.set(roleName, []);
    groupsMap.get(roleName).push(member);
  }

  const roleGroups = Array.from(groupsMap.entries())
    .map(([role, membersInGroup]) => ({ role, members: membersInGroup }))
    .sort((left, right) => right.members.length - left.members.length);

  const existingRoles = new Set(roleGroups.map((group) => group.role.toLowerCase()));
  const missingSuggested = legacyRoles
    .filter((role) => !existingRoles.has(role.label.toLowerCase()))
    .map((role) => ({ id: `suggest-${role.key}`, role: role.label, name: `${role.label} Agent`, emoji: role.emoji }));

  return {
    lead: {
      id: lead.id,
      name: lead.name,
      emoji: lead.emoji,
      model: lead.model,
      modelKey: lead.modelKey,
    },
    roleGroups,
    missingSuggested,
    totalAgents: members.length,
    updatedAt: now.toISOString(),
    mode: 'legacy',
  };
}

function buildTeamStructurePayload({
  openclawAgents,
  now,
  modelCatalog,
  overrides,
  registryRows,
  fallbackAgentName,
  fallbackModelKey,
}) {
  const runtimeAgents = Array.isArray(openclawAgents) ? openclawAgents : [];
  const runtimeMap = new Map(runtimeAgents.map((agent) => [String(agent.id || agent.identityId || '').trim(), agent]).filter(([id]) => id));
  const membersById = new Map();

  for (const entry of registryRows) {
    if (!entry || typeof entry !== 'object') continue;
    const id = registryAgentId(entry);
    if (!id) continue;
    const identity = registryIdentity(entry);
    const models = registryModelAssignment(entry);
    const task = registryTaskDefinition(entry);
    const runtimeAgent = runtimeMap.get(id) || null;
    const capability = inferCapabilityFromRegistry(entry);
    const meta = capabilityMeta(capability);
    const { modelKey, modelLabel } = resolveAgentModel(runtimeAgent || { id, model: models.primary || models.fallback || entry.primaryModel || entry.fallbackModel }, overrides, modelCatalog);

    membersById.set(id, {
      id,
      name: runtimeAgent?.identityName || identity.name || entry.name || runtimeAgent?.name || id,
      emoji: runtimeAgent?.identityEmoji || '🤖',
      model: modelLabel,
      modelKey,
      workspace: runtimeAgent?.workspace || null,
      role: meta.label,
      capability: meta.label,
      capabilityKey: meta.key,
      responsibilities: Array.isArray(task.responsibilities) ? task.responsibilities.slice(0, 3) : Array.isArray(entry.responsibilities) ? entry.responsibilities.slice(0, 3) : [],
      title: identity.role || entry.role || meta.label,
      registryStatus: registryStatusForMember(entry, runtimeAgent),
      runtimeStatus: runtimeStatusForMember(entry, runtimeAgent),
      source: memberSource(entry, runtimeAgent),
      summary: task.mission || entry.mission || '',
    });
  }

  for (const runtimeAgent of runtimeAgents) {
    const id = String(runtimeAgent.id || runtimeAgent.identityId || '').trim();
    if (!id || membersById.has(id)) continue;
    const capability = inferCapabilityFromRuntime(runtimeAgent);
    const meta = capabilityMeta(capability);
    const { modelKey, modelLabel } = resolveAgentModel(runtimeAgent, overrides, modelCatalog);
    membersById.set(id, {
      id,
      name: runtimeAgent.identityName || runtimeAgent.name || id,
      emoji: runtimeAgent.identityEmoji || '🤖',
      model: modelLabel,
      modelKey,
      workspace: runtimeAgent.workspace || null,
      role: meta.label,
      capability: meta.label,
      capabilityKey: meta.key,
      responsibilities: ['Runtime-visible agent', 'Registry alignment needed'],
      title: 'Unregistered runtime member',
      registryStatus: 'unregistered',
      runtimeStatus: 'active',
      source: 'openclaw',
      summary: 'Visible in OpenClaw runtime but missing from canonical registry.',
    });
  }

  if (membersById.size === 0) {
    membersById.set('main', {
      id: 'main',
      name: fallbackAgentName,
      emoji: '🤖',
      model: prettyModelName(fallbackModelKey),
      modelKey: fallbackModelKey,
      workspace: null,
      role: 'Orchestration',
      capability: 'Orchestration',
      capabilityKey: 'orchestration',
      responsibilities: ['Main orchestration'],
      title: 'Primary agent',
      registryStatus: 'unregistered',
      runtimeStatus: 'inactive',
      source: 'registry',
      summary: 'Fallback team view',
    });
  }

  const members = Array.from(membersById.values());
  const lead = members.find((member) => member.id === 'main' || member.id === 'default') || members[0];
  const groupsMap = new Map();

  for (const member of members) {
    const capabilityKey = member.capabilityKey || 'ops';
    if (!groupsMap.has(capabilityKey)) {
      const meta = capabilityMeta(capabilityKey);
      groupsMap.set(capabilityKey, { role: meta.label, capability: meta.key, emoji: meta.emoji, members: [] });
    }
    groupsMap.get(capabilityKey).members.push(member);
  }

  const roleGroups = Array.from(groupsMap.values())
    .map((group) => ({
      role: group.role,
      capability: group.capability,
      emoji: group.emoji,
      members: group.members.sort((left, right) => {
        const rank = (member) => {
          if (member.registryStatus === 'registered' && member.runtimeStatus === 'active') return 0;
          if (member.registryStatus === 'registered') return 1;
          return 2;
        };
        return rank(left) - rank(right) || left.name.localeCompare(right.name);
      }),
    }))
    .sort((left, right) => {
      const leftRequired = capabilityMeta(left.capability).required ? 0 : 1;
      const rightRequired = capabilityMeta(right.capability).required ? 0 : 1;
      return leftRequired - rightRequired || right.members.length - left.members.length || left.role.localeCompare(right.role);
    });

  const coveredCapabilities = new Set(
    roleGroups
      .filter((group) => group.members.some((member) => member.registryStatus === 'registered'))
      .map((group) => group.capability)
  );
  const missingSuggested = TEAM_CAPABILITIES
    .filter((meta) => meta.required && !coveredCapabilities.has(meta.key))
    .map((meta) => ({
      id: `suggest-${meta.key}`,
      capability: meta.label,
      role: meta.label,
      name: `${meta.label} Lead`,
      emoji: meta.emoji,
      severity: 'high',
      reason: `No active registry owner found for required capability ${meta.label}.`,
    }));

  return {
    lead: {
      id: lead.id,
      name: lead.name,
      emoji: lead.emoji,
      model: lead.model,
      modelKey: lead.modelKey,
    },
    roleGroups,
    missingSuggested,
    totalAgents: members.length,
    updatedAt: now.toISOString(),
    dataSources: {
      registry: 'canonical',
      runtime: runtimeAgents.length ? 'openclaw' : 'none',
    },
  };
}

function createAgentsHelpers({
  openclawExec,
  fetchSessions,
  readJsonFileSafe,
  writeJsonFileAtomic,
  TASKS_FILE,
  mcConfig,
  workspacePath,
  persistMcConfig,
  missionControlConfigPath,
}) {
  const RUNTIME_AGENT_LIST_TIMEOUT_MS = 30000;
  const projectRoot = path.dirname(TASKS_FILE);
  const openclawConfigPath = path.join(process.env.HOME || '/home/ubuntu', '.openclaw/openclaw.json');
  const registryPath = path.join(projectRoot, 'data', 'agent-registry.json');
  const customAgentsFile = path.join(projectRoot, 'agents-custom.json');
  const teamStructureShadowLog = path.join(workspacePath, 'state', 'reports', 'team-structure-shadow.jsonl');
  const fallbackAgentName = detectAgentName(workspacePath);
  const canaryMode = String(mcConfig?.teamStructure?.mode || 'canary').trim().toLowerCase();
  const canaryActive = canaryMode === 'canary';
  const shadowActive = canaryActive || canaryMode === 'shadow';
  let runtimeAgentsCache = null;
  let runtimeAgentsCacheTime = 0;
  let runtimeAgentsRefresh = null;
  const runtimeAgentsCacheTtl = 60000;
  let modelCatalogCache = null;
  let modelCatalogCacheTime = 0;
  let modelCatalogRefresh = null;
  const modelCatalogCacheTtl = 10 * 60 * 1000;

  function appendTeamStructureShadowLog(entry) {
    try {
      fs.mkdirSync(path.dirname(teamStructureShadowLog), { recursive: true });
      fs.appendFileSync(teamStructureShadowLog, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch {}
  }

  function getAgentModelOverrides() {
    return (mcConfig && mcConfig.agentModelOverrides && typeof mcConfig.agentModelOverrides === 'object')
      ? mcConfig.agentModelOverrides
      : {};
  }

  function readAgentRegistrySafe() {
    try {
      const parsed = readJsonFileSafe(registryPath, []);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function persistConfig() {
    if (typeof persistMcConfig === 'function') {
      persistMcConfig();
      return;
    }
    if (missionControlConfigPath) {
      fs.writeFileSync(missionControlConfigPath, JSON.stringify(mcConfig, null, 2));
    }
  }

  async function refreshRuntimeAgents() {
    if (runtimeAgentsRefresh) return runtimeAgentsRefresh;
    runtimeAgentsRefresh = new Promise((resolve) => {
      setImmediate(async () => {
        try {
      const { stdout } = await openclawExec(['agents', 'list', '--json', '--bindings'], RUNTIME_AGENT_LIST_TIMEOUT_MS);
          const parsed = parseFirstJson(stdout, []);
          runtimeAgentsCache = Array.isArray(parsed) ? parsed : [];
          runtimeAgentsCacheTime = Date.now();
          resolve(runtimeAgentsCache);
    } catch (error) {
      const recovered = parseFirstJson(error?.stdout || '', null);
          if (Array.isArray(recovered) && recovered.length > 0) {
            runtimeAgentsCache = recovered;
            runtimeAgentsCacheTime = Date.now();
          }
          resolve(runtimeAgentsCache || []);
        } finally {
          runtimeAgentsRefresh = null;
        }
      });
    });
    return runtimeAgentsRefresh;
  }

  async function listRuntimeAgents() {
    if (runtimeAgentsCache && Date.now() - runtimeAgentsCacheTime < runtimeAgentsCacheTtl) {
      return runtimeAgentsCache;
    }
    refreshRuntimeAgents();
    return runtimeAgentsCache || [];
  }

  async function refreshModelCatalog() {
    if (modelCatalogRefresh) return modelCatalogRefresh;
    modelCatalogRefresh = new Promise((resolve) => {
      setImmediate(async () => {
        try {
          const catalog = await fetchOpenclawModelCatalog(openclawExec);
          modelCatalogCache = catalog;
          modelCatalogCacheTime = Date.now();
          resolve(catalog);
        } catch {
          resolve(modelCatalogCache || emptyModelCatalog());
        } finally {
          modelCatalogRefresh = null;
        }
      });
    });
    return modelCatalogRefresh;
  }

  async function getModelCatalog() {
    if (modelCatalogCache && Date.now() - modelCatalogCacheTime < modelCatalogCacheTtl) {
      return modelCatalogCache;
    }
    refreshModelCatalog();
    return modelCatalogCache || emptyModelCatalog();
  }

  function readSessionsFileFallback(limit = 200) {
    try {
      const sessionsFile = path.join(process.env.HOME || '/Users/yordamkocatepe', '.openclaw/agents/main/sessions/sessions.json');
      const raw = readJsonFileSafe(sessionsFile, {});
      const rows = Array.isArray(raw)
        ? raw
        : Object.entries(raw || {}).map(([key, value]) => ({ key, ...(value && typeof value === 'object' ? value : {}) }));
      return rows
        .sort((left, right) => new Date(right.updatedAt || right.lastActive || 0).getTime() - new Date(left.updatedAt || left.lastActive || 0).getTime())
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  async function buildTeamStructureResponse(openclawAgents, now = new Date(), modelCatalog = null) {
    const overrides = getAgentModelOverrides();
    const fallbackModelKey = getOpenclawDefaultModelKey(openclawConfigPath);
    const legacyPayload = buildLegacyTeamStructurePayload({
      openclawAgents,
      now,
      modelCatalog,
      overrides,
      fallbackAgentName,
      fallbackModelKey,
    });

    let nextPayload;
    try {
      nextPayload = buildTeamStructurePayload({
        openclawAgents,
        now,
        modelCatalog,
        overrides,
        registryRows: readAgentRegistrySafe(),
        fallbackAgentName,
        fallbackModelKey,
      });
      nextPayload.mode = canaryActive ? 'canary' : 'shadow';
    } catch (error) {
      const fallback = { ...legacyPayload };
      fallback.mode = 'fallback';
      fallback.error = error.message;
      fallback.shadow = {
        enabled: Boolean(shadowActive),
        status: 'new_payload_failed',
      };
      return fallback;
    }

    if (shadowActive) {
      const diff = {
        totalAgentsChanged: legacyPayload.totalAgents !== nextPayload.totalAgents,
        roleGroupsLegacy: legacyPayload.roleGroups.map((group) => group.role),
        roleGroupsNext: nextPayload.roleGroups.map((group) => group.role),
        missingLegacy: legacyPayload.missingSuggested.map((item) => item.role || item.name),
        missingNext: nextPayload.missingSuggested.map((item) => item.role || item.name),
        leadLegacy: legacyPayload.lead?.id || null,
        leadNext: nextPayload.lead?.id || null,
        activeKnownLegacy: legacyPayload.roleGroups.flatMap((group) => group.members.map((member) => member.id)).sort(),
        activeKnownNext: nextPayload.roleGroups.flatMap((group) => group.members.filter((member) => member.runtimeStatus === 'active').map((member) => member.id)).sort(),
      };
      appendTeamStructureShadowLog({
        ts: now.toISOString(),
        mode: canaryActive ? 'canary' : 'shadow',
        diff,
        changed: stableStringify(diff.roleGroupsLegacy) !== stableStringify(diff.roleGroupsNext)
          || stableStringify(diff.missingLegacy) !== stableStringify(diff.missingNext)
          || diff.leadLegacy !== diff.leadNext
          || diff.totalAgentsChanged,
      });
    }

    const payload = canaryActive ? nextPayload : legacyPayload;
    payload.shadow = {
      enabled: Boolean(shadowActive),
      canary: Boolean(canaryActive),
    };
    if (canaryActive) {
      payload.shadow.legacySnapshot = {
        totalAgents: legacyPayload.totalAgents,
        roleGroups: legacyPayload.roleGroups.map((group) => group.role),
        missingSuggested: legacyPayload.missingSuggested.map((item) => item.role || item.name),
      };
    }
    return payload;
  }

  return {
    projectRoot,
    customAgentsFile,
    fallbackAgentName,
    getAgentModelOverrides,
    listRuntimeAgents,
    persistConfig,
    buildTeamStructureResponse,
    fetchModelCatalog: getModelCatalog,
    fetchSessions,
    readSessionsFileFallback,
    readTaskCountsByAssignee: () => readTaskCountsByAssignee(TASKS_FILE),
    readAgentRegistry: readAgentRegistrySafe,
    readCustomAgents: () => readJsonFileSafe(customAgentsFile, []),
    writeCustomAgents: (agents) => writeJsonFileAtomic(customAgentsFile, agents),
  };
}

function buildAgentsRouter({
  openclawExec,
  fetchSessions,
  readJsonFileSafe,
  writeJsonFileAtomic,
  TASKS_FILE,
  mcConfig,
  workspacePath,
  persistMcConfig,
  missionControlConfigPath,
}) {
  const router = express.Router();
  const helpers = createAgentsHelpers({
    openclawExec,
    fetchSessions,
    readJsonFileSafe,
    writeJsonFileAtomic,
    TASKS_FILE,
    mcConfig,
    workspacePath,
    persistMcConfig,
    missionControlConfigPath,
  });

  router.get('/api/agents', async (req, res) => {
    try {
      const openclawAgents = await helpers.listRuntimeAgents();
      const customAgents = helpers.readCustomAgents();
      const sessions = helpers.readSessionsFileFallback(200);
      const liveWindowMs = 30 * 60 * 1000;
      const telemetryByAgent = new Map();

      for (const session of sessions) {
        const key = String(session?.key || '');
        const match = key.match(/^agent:([^:]+):/);
        const agentId = match?.[1] || (key.includes(':main:main') ? 'main' : '');
        if (!agentId) continue;

        const current = telemetryByAgent.get(agentId) || {
          totalTokens: 0,
          sessionCount: 0,
          lastActive: null,
          status: 'idle',
        };

        const updatedAt = session?.updatedAt ? new Date(session.updatedAt).toISOString() : null;
        const updatedMs = updatedAt ? new Date(updatedAt).getTime() : 0;
        const live = updatedMs > 0 && (Date.now() - updatedMs) < liveWindowMs;

        current.totalTokens += Number(session?.totalTokens || 0);
        current.sessionCount += 1;
        if (!current.lastActive || (updatedAt && updatedAt > current.lastActive)) current.lastActive = updatedAt;
        if (live) current.status = 'active';
        else if (current.status !== 'active' && updatedAt) current.status = 'idle';
        telemetryByAgent.set(agentId, current);
      }

      const overrides = helpers.getAgentModelOverrides();
      const modelCatalog = await helpers.fetchModelCatalog();
      const agents = openclawAgents.map((agent) => {
        const { modelKey, modelLabel } = resolveAgentModel(agent, overrides, modelCatalog);
        const telemetry = telemetryByAgent.get(String(agent.id || '').trim()) || null;
        return {
          id: agent.id,
          name: agent.identityName || agent.name || agent.id,
          role: agent.isDefault ? 'Commander' : inferAgentRole(agent),
          avatar: agent.identityEmoji || '🤖',
          status: telemetry?.status || 'idle',
          model: modelLabel,
          modelKey,
          description: agent.isDefault
            ? 'Primary AI agent. Manages all operations, communications, and development tasks.'
            : `Agent: ${agent.id}`,
          lastActive: telemetry?.lastActive || null,
          totalTokens: telemetry?.totalTokens || 0,
          sessionCount: telemetry?.sessionCount || 0,
          sessionKey: `agent:${agent.id}:main`,
          isDefault: !!agent.isDefault,
          workspace: agent.workspace,
        };
      });

      const existingIds = new Set(agents.map((agent) => String(agent.id || '').trim()));
      for (const custom of Array.isArray(customAgents) ? customAgents : []) {
        const id = String(custom?.id || '').trim();
        if (!id || existingIds.has(id)) continue;
        agents.push({
          id,
          name: custom.name || id,
          role: 'Custom',
          avatar: '🧩',
          status: 'idle',
          model: prettyModelName(custom.model || ''),
          modelKey: custom.model || '',
          description: custom.description || 'Custom Mission Control agent',
          lastActive: custom.created || null,
          totalTokens: 0,
          sessionCount: 0,
          sessionKey: `agent:${id}:main`,
          isDefault: false,
          workspace: null,
        });
      }

      if (agents.length === 0) {
        const fallbackModel = getOpenclawDefaultModelKey(path.join(process.env.HOME || '/home/ubuntu', '.openclaw/openclaw.json'));
        agents.push({
          id: 'main',
          name: helpers.fallbackAgentName,
          role: 'Commander',
          avatar: '🤖',
          status: 'active',
          model: prettyModelName(fallbackModel),
          modelKey: fallbackModel,
          description: 'Primary AI agent (agent list unavailable)',
          lastActive: new Date().toISOString(),
          totalTokens: 0,
          sessionCount: 0,
          sessionKey: 'agent:main:main',
          isDefault: true,
        });
      }

      return res.json({ agents, conversations: [] });
    } catch (error) {
      console.error('[Agents API]', error.message);
      return res.json({
        agents: [
          { id: 'main', name: helpers.fallbackAgentName, role: 'Commander', avatar: '🤖', status: 'active', model: prettyModelName(''), description: 'Primary agent (error)', lastActive: new Date().toISOString(), totalTokens: 0 },
        ],
        conversations: [],
        error: error.message,
      });
    }
  });

  router.post('/api/agents/create', (req, res) => {
    try {
      const { name, description, model, systemPrompt, skills } = req.body;
      if (!name || !model) {
        return res.status(400).json({ error: 'name and model are required' });
      }

      const agents = helpers.readCustomAgents();
      const agent = {
        id: `custom-${Date.now()}`,
        name,
        description: description || '',
        model,
        systemPrompt: systemPrompt || '',
        skills: skills || [],
        created: new Date().toISOString(),
        status: 'active',
      };

      agents.push(agent);
      helpers.writeCustomAgents(agents);
      return res.json({ ok: true, agent });
    } catch (error) {
      console.error('[Create Agent]', error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/team/structure', async (req, res) => {
    try {
      const openclawAgents = await helpers.listRuntimeAgents();
      const modelCatalog = await helpers.fetchModelCatalog();
      return res.json(await helpers.buildTeamStructureResponse(openclawAgents, new Date(), modelCatalog));
    } catch (error) {
      console.error('[Team structure API]', error.message);
      return res.status(500).json({
        lead: null,
        roleGroups: [],
        missingSuggested: [],
        totalAgents: 0,
        updatedAt: new Date().toISOString(),
        error: error.message,
      });
    }
  });

  router.post('/api/team/structure/bootstrap', async (req, res) => {
    try {
      const modelCatalog = await helpers.fetchModelCatalog();
      const payload = await helpers.buildTeamStructureResponse([], new Date(), modelCatalog);
      const suggestions = Array.isArray(payload?.missingSuggested) ? payload.missingSuggested : [];
      return res.json({
        ok: true,
        mode: 'suggest-only',
        generated: suggestions,
        message: suggestions.length
          ? 'Role suggestions generated. No agents were created automatically.'
          : 'No missing canonical capabilities detected.',
      });
    } catch (error) {
      console.error('[Team structure bootstrap]', error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  router.get('/api/office/telemetry', async (req, res) => {
    try {
      const sessions = helpers.readSessionsFileFallback(200);
      const taskCounts = helpers.readTaskCountsByAssignee();
      const registryRows = helpers.readAgentRegistry();
      const customAgents = helpers.readCustomAgents();
      const agentSessions = new Map();

      for (const session of sessions || []) {
        const key = String(session.key || '');
        const agentId = key.includes(':') ? key.split(':')[1] : key.split('-')[0];
        if (!agentId) continue;
        const existing = agentSessions.get(agentId) || { count: 0, lastActive: '', latestSessionKey: null };
        const timestamp = new Date(session.updatedAt || session.lastActive || '').getTime() || Date.now();
        const existingTs = existing.lastActive ? new Date(existing.lastActive).getTime() : 0;
        agentSessions.set(agentId, {
          count: existing.count + 1,
          lastActive: (!existing.lastActive || timestamp > existingTs) ? (session.updatedAt || session.lastActive || new Date().toISOString()) : existing.lastActive,
          latestSessionKey: (!existing.latestSessionKey || timestamp >= existingTs) ? key : existing.latestSessionKey,
        });
      }

      const overrides = helpers.getAgentModelOverrides();
      const runtimeAgents = await helpers.listRuntimeAgents();
      const runtimeAgentMap = new Map(
        (Array.isArray(runtimeAgents) ? runtimeAgents : [])
          .map((agent) => [String(agent.id || agent.identityId || '').trim(), agent])
          .filter(([id]) => id)
      );
      const registryMap = new Map(
        (Array.isArray(registryRows) ? registryRows : [])
          .map((entry) => [registryAgentId(entry), entry])
          .filter(([id]) => id)
      );
      const customMap = new Map(
        (Array.isArray(customAgents) ? customAgents : [])
          .map((agent) => [String(agent?.id || '').trim(), agent])
          .filter(([id]) => id)
      );
      const deskIds = new Set([
        ...registryMap.keys(),
        ...runtimeAgentMap.keys(),
        ...Object.keys(taskCounts || {}),
        ...agentSessions.keys(),
        ...customMap.keys(),
      ]);

      const desks = Array.from(deskIds).map((id) => {
        const runtimeAgent = runtimeAgentMap.get(id) || null;
        const registryEntry = registryMap.get(id) || null;
        const customAgent = customMap.get(id) || null;
        const registryIdentityMeta = registryEntry ? registryIdentity(registryEntry) : {};
        const registryModelMeta = registryEntry ? registryModelAssignment(registryEntry) : {};
        const counts = taskCounts[id] || { open: 0, running: 0, blocked: 0, done: 0, taskPreview: [] };
        const sessionInfo = agentSessions.get(id) || { count: 0, lastActive: '', latestSessionKey: null };
        const openTasks = Number(counts.open || 0);
        const inProgressTaskCount = Number(counts.running || 0);
        const blockedTaskCount = Number(counts.blocked || 0);
        const sessionCount = Number(sessionInfo.count || 0);
        const lastActivityAt = sessionInfo.lastActive ? new Date(sessionInfo.lastActive).toISOString() : null;
        const lastActivityText = lastActivityAt ? 'Last activity logged' : 'no signal';
        const lastActivityMs = lastActivityAt ? new Date(lastActivityAt).getTime() : 0;
        let liveState = 'offline';
        if (sessionCount > 0) {
          liveState = (Date.now() - lastActivityMs <= 4 * 60 * 1000) ? 'live' : 'warm';
        } else if (inProgressTaskCount > 0 || openTasks > 0) {
          liveState = 'idle';
        }

        const overrideRecord = typeof overrides === 'object' ? (overrides[id] || {}) : {};
        const modelKey = String(
          overrideRecord?.model
          || runtimeAgent?.model
          || registryModelMeta?.primary
          || registryModelMeta?.fallback
          || customAgent?.model
          || ''
        ).trim();

        const inferredCapability = registryEntry ? inferCapabilityFromRegistry(registryEntry) : inferCapabilityFromRuntime(runtimeAgent);
        const role =
          (runtimeAgent ? inferAgentRole(runtimeAgent) : '')
          || registryIdentityMeta?.role
          || capabilityMeta(inferredCapability).label
          || 'Ops';

        return {
          id,
          name: runtimeAgent?.identityName || runtimeAgent?.name || registryIdentityMeta?.name || customAgent?.name || id,
          role,
          emoji: runtimeAgent?.identityEmoji || '🤖',
          model: prettyModelName(modelKey),
          liveState,
          activeTaskCount: openTasks,
          inProgressTaskCount,
          sessionCount,
          lastActivityAt,
          lastActivityText,
          dbStatus: sessionCount > 0 ? 'session-active' : (inProgressTaskCount > 0 ? 'task-active' : null),
          memoryHash: null,
          pathSummary: counts.paths || { direct: 0, taskPath: 0, automation: 0 },
          lastExecutionPath: counts.lastExecutionPath || null,
          blockedTaskCount,
          latestSessionKey: sessionInfo.latestSessionKey || null,
          taskPreview: Array.isArray(counts.taskPreview) ? counts.taskPreview : [],
        };
      });

      const summary = {
        agents: desks.length,
        live: desks.filter((desk) => desk.liveState === 'live').length,
        warm: desks.filter((desk) => desk.liveState === 'warm').length,
        idle: desks.filter((desk) => desk.liveState === 'idle').length,
        offline: desks.filter((desk) => desk.liveState === 'offline').length,
        openTasks: desks.reduce((acc, desk) => acc + (desk.activeTaskCount || 0), 0),
      };

      return res.json({ generatedAt: new Date().toISOString(), summary, desks });
    } catch (error) {
      console.error('[Office telemetry API]', error.message);
      return res.status(500).json({
        generatedAt: new Date().toISOString(),
        summary: { agents: 0, live: 0, warm: 0, idle: 0, offline: 0, openTasks: 0 },
        desks: [],
        error: error.message,
      });
    }
  });

  router.post('/api/agents/:agentId/model', (req, res) => {
    try {
      const { agentId } = req.params;
      const { model } = req.body || {};
      if (!agentId || typeof model !== 'string' || !model.trim()) {
        return res.status(400).json({ error: 'agentId and model required' });
      }
      if (!mcConfig.agentModelOverrides || typeof mcConfig.agentModelOverrides !== 'object') {
        mcConfig.agentModelOverrides = {};
      }
      mcConfig.agentModelOverrides[agentId] = { model: model.trim() };
      helpers.persistConfig();
      return res.json({ ok: true, agentId, model: model.trim() });
    } catch (error) {
      console.error('[Agent model override API]', error.message);
      return res.status(500).json({ error: error.message });
    }
  });

  return router;
}

module.exports = {
  buildAgentsRouter,
};
