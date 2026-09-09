const lower = (v) => String(v ?? '').toLowerCase();
const eq = (a, b) => lower(a) === lower(b);
const sum = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
const memberKey = (account, name) => `${lower(account)}/${lower(name)}`;
const inference = (m) => ['tokens', 'images', 'embeddings'].includes(m.kind);

export function buildView(data, axis, selection) {
  // Telemetry describes a retained sample, not a separately billed slice.
  const path = axis === 'telemetry' ? {} : selection;
  const group = axis === 'estate' ? path.group : null;
  const resource = axis === 'estate' ? path.resource : axis === 'foundry' ? path.account : null;
  const resourceMatch = (id, name) => !resource || eq(id, resource) || eq(name, resource);
  const caseRows = axis === 'usecase'
    ? (data.useCases?.rows ?? []).filter((r) => !path.usecase || r.id === path.usecase)
    : null;
  const caseDeployments = caseRows && new Set(caseRows.flatMap((r) =>
    r.deploymentRows.map((d) => memberKey(d.account, d.name))));
  const caseAgents = caseRows && new Set(caseRows.flatMap((r) =>
    r.agentRows.map((a) => memberKey(a.account, a.name))));
  const byDeploymentOnly = axis === 'usecase' || Boolean(path.deployment || path.model || path.project || path.agent);
  const meterOnly = axis === 'estate' && Boolean(path.meter);
  const hasAgentSelection = Boolean(path.project || path.agent);

  let agents = data.agents.filter((a) =>
    (!group || eq(a.resourceGroup, group)) &&
    resourceMatch(a.accountId, a.accountName) &&
    (!path.project || eq(a.projectId, path.project) || eq(a.projectName, path.project)) &&
    (!path.agent || (axis === 'foundry' ? a.id === path.agent
      : a.name === path.agent || memberKey(a.accountName, a.name) === path.agent)) &&
    (!caseAgents || caseAgents.has(memberKey(a.accountName, a.name))));
  const declared = new Set(agents.map((a) => memberKey(a.accountName, a.deploymentName)));

  const deployments = data.deployments.filter((d) =>
    (!group || eq(d.resourceGroup, group)) &&
    resourceMatch(d.accountId, d.accountName) &&
    (!path.deployment || d.id === path.deployment || d.name === path.deployment ||
      memberKey(d.accountName, d.name) === path.deployment) &&
    (!path.model || eq(d.modelKey, path.model) || eq(d.model, path.model)) &&
    (!caseDeployments || caseDeployments.has(memberKey(d.accountName, d.name))) &&
    (!hasAgentSelection || declared.has(memberKey(d.accountName, d.name))));
  if (path.deployment || path.model) {
    const selected = new Set(deployments.map((d) => memberKey(d.accountName, d.name)));
    agents = agents.filter((a) => selected.has(memberKey(a.accountName, a.deploymentName)));
  }
  const accounts = data.accounts.filter((a) =>
    (!group || eq(a.resourceGroup, group)) && resourceMatch(a.id, a.name));
  const projects = data.projects.filter((p) =>
    (!group || eq(p.resourceGroup, group)) && resourceMatch(p.accountId, p.accountName) &&
    (!path.project || p.id === path.project || p.name === path.project));
  const resources = data.resources.filter((r) =>
    (!group || eq(r.resourceGroup, group)) && resourceMatch(r.id, r.name));
  const allMeters = data.meters.filter((m) =>
    (!group || eq(m.resourceGroup, group)) &&
    resourceMatch(m.resourceId, m.account) &&
    (!path.meter || (m.id ?? m.name) === path.meter) &&
    (!byDeploymentOnly || deployments.some((d) =>
      eq(d.accountName, m.account) && eq(d.modelKey, m.model))));
  const meters = allMeters.filter((m) => meterOnly || m.model != null);

  const narrowed = Object.keys(path).length > 0;
  const tokenSpend = meterOnly ? sum(allMeters.filter(inference), 'cost')
    : byDeploymentOnly ? sum(deployments, 'cost')
      : narrowed ? sum(allMeters.filter(inference), 'cost') : data.totals.tokenCost;
  const spend = meterOnly ? sum(allMeters, 'cost')
    : byDeploymentOnly ? tokenSpend : narrowed ? sum(resources, 'cost') : data.totals.cost;
  const aiSpend = meterOnly ? sum(allMeters.filter((m) => m.isAi), 'cost')
    : byDeploymentOnly ? tokenSpend
      : narrowed ? sum(resources.filter((r) => r.isAi || r.isFoundry), 'cost') : data.totals.aiCost;
  const calls = meterOnly ? null : sum(deployments, 'calls');
  const inTok = meterOnly ? null : sum(deployments, 'inputTokens');
  const outTok = meterOnly ? null : sum(deployments, 'outputTokens');
  const allTok = meterOnly ? null : inTok + outTok;
  const names = new Set();
  let duplicateAgents = 0;
  for (const a of agents) {
    const name = `${a.projectId}/${a.name}`;
    if (names.has(name)) duplicateAgents++;
    names.add(name);
  }
  const open = meterOnly ? allMeters[0]?.name
    : path.deployment ? deployments[0]?.name
      : path.agent ? agents[0]?.name
        : path.model ? path.model
          : path.project ? projects[0]?.name
            : resource ? resources[0]?.name ?? accounts[0]?.name
              : group ?? (path.usecase ? caseRows?.[0]?.display : null);
  return {
    currency: data.currency ?? 'USD', open, byDeploymentOnly, meterOnly,
    subscriptionAiShare: data.totals.aiCost > 0 ? tokenSpend / data.totals.aiCost : 0,
    accounts, projects, resources, allMeters, meters,
    deployments: meterOnly ? [] : deployments,
    agents: meterOnly ? [] : agents,
    duplicateAgents, spend, aiSpend, tokenSpend, calls, inTok, outTok, allTok,
    costPerCall: calls > 0 ? tokenSpend / calls : null,
    costPer1k: allTok > 0 ? tokenSpend / allTok * 1000 : null,
    inputShare: allTok > 0 ? inTok / allTok : 0,
  };
}
