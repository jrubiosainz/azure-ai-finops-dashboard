/**
 * Sync orchestrator.
 *
 * Pulls every input the dashboard needs from Azure, joins them through the FinOps
 * engine and writes the result to the disk cache. Cost Management queries are kept to
 * the minimum possible number because that API throttles at a few calls per minute.
 */

import {
  getSubscription, listResourceGroups, listAiAccounts, listDeployments,
  listProjects, listAgents, queryCost, fetchAccountMetrics,
} from './azure.mjs';
import { pathToFileURL } from 'node:url';
import { buildFinopsModel } from './finops.mjs';
import { collectTelemetry, summarizeTelemetry } from './telemetry.mjs';
import { collectUseCases, attributeUseCases } from './usecases.mjs';
import { writeCache, modelCacheKey } from './cache.mjs';
import { readConfig, subscriptionId as validateSubscriptionId } from './config.mjs';

/** Runs tasks with bounded concurrency so we never stampede ARM. */
async function pool(items, limit, worker) {
  const results = [];
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

export function defaultRange(days = 30, now = new Date()) {
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error('La ventana debe contener entre 1 y 90 dias.');
  }
  const to = new Date(now);
  const from = new Date(to.getTime() - (days - 1) * 86_400_000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

export async function runSync({ subscriptionId, from, to, onProgress = () => {} } = {}) {
  const started = Date.now();
  subscriptionId = validateSubscriptionId(subscriptionId);
  const range = from && to ? { from, to } : defaultRange(30);
  const warnings = [];
  const step = (phase, detail) => onProgress({ phase, detail });

  step('subscription', 'Reading subscription metadata');
  const [subscription, resourceGroups, accounts] = await Promise.all([
    getSubscription(subscriptionId),
    listResourceGroups(subscriptionId),
    listAiAccounts(subscriptionId),
  ]);

  step('inventory', `Enumerating deployments for ${accounts.length} AI accounts`);
  const deploymentResults = await pool(accounts, 8, (a) => listDeployments(a));
  const deployments = [];
  for (const r of deploymentResults) {
    if (Array.isArray(r)) deployments.push(...r);
    else if (r?.error) warnings.push(`deployments ${r.accountId?.split('/').pop()}: ${r.error}`);
  }

  step('projects', 'Enumerating Foundry projects');
  const projectResults = await pool(accounts.filter((a) => a.isFoundry), 8, (a) => listProjects(a));
  const projects = projectResults.flat().filter(Boolean);

  step('agents', `Enumerating agents across ${projects.length} projects`);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  const agentResults = await pool(projects, 6, (p) => listAgents(accountsById.get(p.accountId), p));
  const agents = [];
  for (const r of agentResults) {
    if (Array.isArray(r)) agents.push(...r);
    else if (r?.error) warnings.push(`agents ${r.projectName}: ${r.error}`);
  }

  step('metrics', `Reading Azure Monitor metrics for ${accounts.length} accounts`);
  const metrics = await pool(accounts, 5, (a) =>
    fetchAccountMetrics(a, range).catch((e) => {
      warnings.push(`metrics ${a.name}: ${e.message}`);
      return { accountId: a.id, accountName: a.name, series: [], errors: [] };
    }),
  );
  for (const m of metrics) {
    for (const e of m.errors ?? []) warnings.push(`metrics ${m.accountName}: ${e.message}`);
  }

  // Cost Management is the bottleneck: three queries, serialized, ~16s apart. Log
  // Analytics has an entirely separate quota, so per-call telemetry rides along for free
  // instead of adding its ~100s to the wall clock.
  step('cost', 'Querying Cost Management (resource groups and services)');
  const telemetryPromise = collectTelemetry(subscriptionId, range, (w) => warnings.push(w)).catch((e) => {
    warnings.push(`telemetry: ${e.message}`);
    return { calls: [], scanned: [], componentCount: 0, workspaceCount: 0 };
  });

  // The gateway registry is small and lives on a different quota again, so it rides
  // along with the Cost Management wait rather than extending it.
  const useCasePromise = collectUseCases(subscriptionId, range, (w) => warnings.push(w)).catch((e) => {
    warnings.push(`casos de uso: ${e.message}`);
    return { gateways: [], useCases: [] };
  });

  const costByGroup = await queryCost(subscriptionId, {
    ...range,
    granularity: 'None',
    grouping: [
      { type: 'Dimension', name: 'ResourceGroupName' },
      { type: 'Dimension', name: 'ServiceName' },
    ],
  });

  step('cost', 'Querying Cost Management (resources and meters)');
  const costByMeter = await queryCost(subscriptionId, {
    ...range,
    granularity: 'None',
    grouping: [
      { type: 'Dimension', name: 'ResourceId' },
      { type: 'Dimension', name: 'Meter' },
    ],
  });

  step('cost', 'Querying Cost Management (daily trend)');
  const costDaily = await queryCost(subscriptionId, {
    ...range,
    granularity: 'Daily',
    grouping: [{ type: 'Dimension', name: 'ServiceName' }],
  }).catch((e) => {
    warnings.push(`cost/daily: ${e.message}`);
    return [];
  });

  // The meter query carries no resource-group column, so backfill it from the resource id.
  const rgFromId = (id = '') => (/\/resourceGroups\/([^/]+)/i.exec(id) ?? [])[1] ?? 'unassigned';
  const costRows = [
    ...costByGroup,
    ...costByMeter.map((r) => ({ ...r, ResourceGroupName: rgFromId(r.ResourceId) })),
  ];

  // Group rows already account for total spend; meter rows would double-count it.
  const currency = costByGroup[0]?.Currency ?? costByMeter[0]?.Currency ?? 'EUR';

  step('build', 'Joining cost, metrics and inventory');
  const model = buildFinopsModel({
    costRows: costByGroup,
    costMeterRows: costByMeter,
    costDaily,
    accounts,
    deployments,
    projects,
    agents,
    metrics,
    resourceGroups,
    currency,
  });

  // Meter-level rows drive model attribution; feed them through a second pass so the
  // headline totals stay anchored on the non-double-counted group query.
  const meterModel = buildFinopsModel({
    costRows: costByMeter.map((r) => ({ ...r, ResourceGroupName: rgFromId(r.ResourceId) })),
    costDaily: [],
    accounts,
    deployments,
    projects,
    agents,
    metrics,
    resourceGroups,
    currency,
  });

  step('telemetry', 'Leyendo telemetría por llamada de Application Insights');
  const telemetry = summarizeTelemetry(await telemetryPromise, {
    meteredCalls: meterModel.totals.calls,
  });

  step('usecases', 'Leyendo los casos de uso declarados en la pasarela');
  const gatewayRegistry = await useCasePromise;
  let useCases;
  try {
    useCases = attributeUseCases({
      ...gatewayRegistry,
      deployments: meterModel.deployments,
      agents: meterModel.agents,
    });
  } catch (error) {
    warnings.push(`casos de uso: ${error.message}`);
    useCases = attributeUseCases({ useCases: [], gateways: gatewayRegistry.gateways });
  }

  const payload = {
    subscription: subscription
      ? { id: subscription.subscriptionId, name: subscription.displayName, state: subscription.state }
      : { id: subscriptionId, name: subscriptionId, state: 'unknown' },
    range,
    currency,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    warnings,
    counts: {
      resourceGroups: resourceGroups.length,
      accounts: accounts.length,
      deployments: deployments.length,
      projects: projects.length,
      agents: agents.length,
      costRows: costRows.length,
      useCases: useCases.rows.length,
    },
    // Headline spend comes from the clean group query; attribution figures can only be
    // computed from the meter query, so the two passes are merged here.
    totals: {
      ...model.totals,
      attributedAiCost: meterModel.totals.attributedAiCost,
      costPerCall: meterModel.totals.costPerCall,
      costPer1kTokens: meterModel.totals.costPer1kTokens,
      tokenCost: meterModel.meters
        .filter((m) => m.kind === 'tokens' || m.kind === 'images' || m.kind === 'embeddings')
        .reduce((s, m) => s + m.cost, 0),
      computeCost: meterModel.meters
        .filter((m) => m.kind === 'compute' || m.kind === 'provisioned')
        .reduce((s, m) => s + m.cost, 0),
      models: meterModel.totals.models,
    },
    groups: model.groups,
    services: model.services,
    timeline: model.timeline,
    // Resource, meter, model, deployment, project and agent detail come from the
    // meter-level query, which is where model attribution actually lives.
    resources: meterModel.resources,
    meters: meterModel.meters,
    accounts: meterModel.accounts,
    deployments: meterModel.deployments,
    models: meterModel.models,
    projects: meterModel.projects,
    agents: meterModel.agents,
    telemetry,
    useCases,
  };

  const unattributed = payload.totals.tokenCost - payload.totals.attributedAiCost;
  if (Math.abs(unattributed) > 0.01) {
    warnings.push(`Inferencia sin conciliar con despliegues: ${unattributed.toFixed(2)} ${currency}. Revisa inventario, medidores y cobertura de metricas.`);
  }

  await writeCache(modelCacheKey(subscriptionId, range), payload);
  step('done', `Completed in ${Math.round(payload.durationMs / 1000)}s`);
  return payload;
}

// Allow `npm run sync` for a manual refresh outside the server.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  let config;
  try {
    config = readConfig();
    if (config.demo) throw new Error('El modo demo no sincroniza Azure. Ejecuta "npm run demo".');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  runSync({
    subscriptionId: config.subscriptionId,
    ...defaultRange(config.days),
    onProgress: (p) => console.log(`[${p.phase}] ${p.detail}`),
  })
    .then((r) => {
      console.log(`\nDone in ${Math.round(r.durationMs / 1000)}s`);
      console.log(`Cost ${r.totals.cost.toFixed(2)} ${r.currency} | AI ${r.totals.aiCost.toFixed(2)}`);
      console.log(`Calls ${r.totals.calls} | Tokens ${r.totals.totalTokens}`);
      console.log(`Agents ${r.counts.agents} | Projects ${r.counts.projects} | Deployments ${r.counts.deployments}`);
      if (r.warnings.length) console.log(`\nWarnings (${r.warnings.length}):\n- ${r.warnings.slice(0, 15).join('\n- ')}`);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
