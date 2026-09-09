/**
 * Azure API client layer.
 *
 * Everything that talks to Azure lives here. Two hard constraints shape this file:
 *  1. Cost Management allows roughly 4 requests/minute per scope and answers 429 well
 *     before that in practice, so every cost call goes through a serialized queue.
 *  2. Azure Monitor caps a single request at 20 metric names and rejects splits that
 *     exceed its series budget, so metric calls are chunked and degraded gracefully.
 */

import { AzureCliCredential } from '@azure/identity';

const ARM = 'https://management.azure.com';
const SCOPE_ARM = 'https://management.azure.com/.default';
const SCOPE_AI = 'https://ai.azure.com/.default';

const API = {
  cost: '2023-11-01',
  metrics: '2019-07-01',
  cognitive: '2025-06-01',
  resources: '2021-04-01',
  agents: '2025-05-15-preview',
  appInsights: '2020-02-02',
  workspaces: '2023-09-01',
};

const credential = new AzureCliCredential(
  process.env.AZURE_TENANT_ID ? { tenantId: process.env.AZURE_TENANT_ID } : {},
);
const tokenCache = new Map();

async function getToken(scope) {
  const hit = tokenCache.get(scope);
  // Refresh two minutes early so a long sync never dies mid-flight on an expiring token.
  if (hit && hit.expiresOnTimestamp - Date.now() > 120_000) return hit.token;
  const res = await credential.getToken(scope);
  if (!res) throw new Error(`Could not acquire an Azure token for ${scope}. Run: az login`);
  tokenCache.set(scope, { token: res.token, expiresOnTimestamp: res.expiresOnTimestamp });
  return res.token;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Serializes calls and enforces a floor on the gap between them. Cost Management
 * throttles per scope, so parallelism there is actively harmful.
 */
function createLimiter(minIntervalMs) {
  let chain = Promise.resolve();
  let last = 0;
  return (fn) => {
    const run = chain.then(async () => {
      const wait = last + minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        last = Date.now();
      }
    });
    // Keep the chain alive even when a link rejects.
    chain = run.then(() => {}, () => {});
    return run;
  };
}

const costLimiter = createLimiter(16_000);
const metricsLimiter = createLimiter(120);

class AzureError extends Error {
  constructor(message, status, body, url) {
    super(message);
    this.name = 'AzureError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export async function request(url, { method = 'GET', body, scope = SCOPE_ARM, retries = 6, label = '' } = {}) {
  let attempt = 0;
  let backoff = 4000;

  for (;;) {
    const token = await getToken(scope);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          // Cost Management partitions its quota by client, so identify ourselves.
          ClientType: 'foundry-finops-dashboard',
          'x-ms-client-application-name': 'foundry-finops-dashboard',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (networkError) {
      // Transient DNS/socket failures are common on corporate networks.
      if (attempt++ >= retries) throw new AzureError(`Network failure calling ${label || url}: ${networkError.message}`, 0, null, url);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }

    if (res.status === 204) return null;

    if (res.ok) {
      const text = await res.text();
      if (!text) return null;
      // APIM returns policy documents as raw XML; a JSON parse would throw on a
      // request that in fact succeeded.
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text };
      }
    }

    const text = await res.text().catch(() => '');

    const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
    if (retryable && attempt++ < retries) {
      const headerWait =
        Number(res.headers.get('retry-after')) ||
        Number(res.headers.get('x-ms-ratelimit-microsoft.costmanagement-entity-retry-after')) ||
        0;
      const wait = headerWait > 0 ? headerWait * 1000 : backoff;
      await sleep(wait);
      backoff = Math.min(backoff * 2, 90_000);
      continue;
    }

    throw new AzureError(
      `Azure returned ${res.status} for ${label || url}: ${text.slice(0, 400)}`,
      res.status,
      text,
      url,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Identity / context
 * ------------------------------------------------------------------ */

export async function getSubscription(subscriptionId) {
  return request(`${ARM}/subscriptions/${subscriptionId}?api-version=${API.resources}`, {
    label: 'subscription',
  });
}

/** Every subscription the signed-in identity can read, for the dashboard's switcher. */
export async function listSubscriptions() {
  const out = [];
  let url = `${ARM}/subscriptions?api-version=${API.resources}`;
  while (url) {
    const page = await request(url, { label: 'subscriptions' });
    out.push(...(page?.value ?? []));
    url = page?.nextLink ?? null;
  }
  return out
    .map((s) => ({
      id: s.subscriptionId,
      name: s.displayName,
      state: s.state,
      tenantId: s.tenantId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listResourceGroups(subscriptionId) {
  const out = [];
  let url = `${ARM}/subscriptions/${subscriptionId}/resourcegroups?api-version=${API.resources}`;
  while (url) {
    const page = await request(url, { label: 'resourceGroups' });
    out.push(...(page?.value ?? []));
    url = page?.nextLink ?? null;
  }
  return out.map((rg) => ({
    id: rg.id,
    name: rg.name,
    location: rg.location,
    tags: rg.tags ?? {},
  }));
}

/* ------------------------------------------------------------------ *
 * Observability inventory: App Insights components and their workspaces
 * ------------------------------------------------------------------ */

export async function listAppInsights(subscriptionId) {
  const out = [];
  let url = `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.Insights/components?api-version=${API.appInsights}`;
  while (url) {
    const page = await request(url, { label: 'appInsights' });
    out.push(...(page?.value ?? []));
    url = page?.nextLink ?? null;
  }
  return out.map((c) => ({
    id: c.id,
    name: c.name,
    resourceGroup: resourceGroupFromId(c.id),
    appId: c.properties?.AppId ?? null,
    // Classic components store telemetry privately; only workspace-backed ones are queryable by KQL.
    workspaceResourceId: c.properties?.WorkspaceResourceId ?? null,
    ingestionMode: c.properties?.IngestionMode ?? null,
  }));
}

export async function listWorkspaces(subscriptionId) {
  const out = [];
  let url = `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.OperationalInsights/workspaces?api-version=${API.workspaces}`;
  while (url) {
    const page = await request(url, { label: 'workspaces' });
    out.push(...(page?.value ?? []));
    url = page?.nextLink ?? null;
  }
  return out.map((w) => ({
    id: w.id,
    name: w.name,
    resourceGroup: resourceGroupFromId(w.id),
    // The KQL endpoint is addressed by the workspace GUID, not by its ARM id.
    customerId: w.properties?.customerId ?? null,
    retentionInDays: w.properties?.retentionInDays ?? null,
  })).filter((w) => w.customerId);
}

/* ------------------------------------------------------------------ *
 * AI inventory: accounts, deployments, projects
 * ------------------------------------------------------------------ */

const FOUNDRY_KINDS = new Set(['AIServices', 'OpenAI', 'CognitiveServices']);

export async function listAiAccounts(subscriptionId) {
  const out = [];
  let url = `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/accounts?api-version=${API.cognitive}`;
  while (url) {
    const page = await request(url, { label: 'cognitiveAccounts' });
    out.push(...(page?.value ?? []));
    url = page?.nextLink ?? null;
  }
  return out.map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    location: a.location,
    sku: a.sku?.name ?? null,
    resourceGroup: resourceGroupFromId(a.id),
    endpoint: a.properties?.endpoint ?? null,
    // Foundry-native accounts expose a project-aware endpoint we need for the agents API.
    aiServicesEndpoint: a.properties?.endpoints?.['AI Foundry API'] ?? a.properties?.endpoints?.['AIServices'] ?? null,
    isFoundry: FOUNDRY_KINDS.has(a.kind),
    tags: a.tags ?? {},
  }));
}

export async function listDeployments(account) {
  try {
    const page = await request(`${ARM}${account.id}/deployments?api-version=${API.cognitive}`, {
      label: `deployments:${account.name}`,
      retries: 2,
    });
    return (page?.value ?? []).map((d) => ({
      id: d.id,
      name: d.name,
      accountId: account.id,
      accountName: account.name,
      resourceGroup: account.resourceGroup,
      model: d.properties?.model?.name ?? null,
      modelVersion: d.properties?.model?.version ?? null,
      modelFormat: d.properties?.model?.format ?? null,
      skuName: d.sku?.name ?? d.properties?.sku?.name ?? null,
      capacity: d.sku?.capacity ?? d.properties?.sku?.capacity ?? null,
      provisioningState: d.properties?.provisioningState ?? null,
    }));
  } catch (err) {
    // A single unreadable account must not sink the whole inventory sync.
    return { error: err.message, accountId: account.id };
  }
}

export async function listProjects(account) {
  try {
    const page = await request(`${ARM}${account.id}/projects?api-version=${API.cognitive}`, {
      label: `projects:${account.name}`,
      retries: 1,
    });
    return (page?.value ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      accountId: account.id,
      accountName: account.name,
      resourceGroup: account.resourceGroup,
      displayName: p.properties?.displayName ?? p.name,
      description: p.properties?.description ?? null,
      endpoint: p.properties?.endpoints?.['AI Foundry API'] ?? null,
      isDefault: Boolean(p.properties?.isDefault),
    }));
  } catch {
    // Accounts predating the Foundry project model simply have no projects sub-resource.
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * Foundry Agents (data plane)
 * ------------------------------------------------------------------ */

function projectEndpoint(account, project) {
  if (project.endpoint) return project.endpoint.replace(/\/$/, '');
  const host = (account.aiServicesEndpoint || account.endpoint || '')
    .replace(/\/$/, '')
    .replace('.cognitiveservices.azure.com', '.services.ai.azure.com');
  if (!host) return null;
  return `${host}/api/projects/${project.name}`;
}

export async function listAgents(account, project) {
  const base = projectEndpoint(account, project);
  if (!base) return [];
  try {
    const data = await request(`${base}/assistants?api-version=${API.agents}`, {
      scope: SCOPE_AI,
      label: `agents:${project.name}`,
      retries: 1,
    });
    return (data?.data ?? []).map((a) => ({
      id: a.id,
      name: a.name ?? a.id,
      projectId: project.id,
      projectName: project.name,
      accountId: account.id,
      accountName: account.name,
      resourceGroup: account.resourceGroup,
      model: a.model ?? null,
      description: a.description ?? null,
      instructionsLength: (a.instructions ?? '').length,
      tools: (a.tools ?? []).map((t) => t.type).filter(Boolean),
      createdAt: a.created_at ? new Date(a.created_at * 1000).toISOString() : null,
    }));
  } catch (err) {
    return { error: err.message, projectId: project.id, projectName: project.name };
  }
}

/* ------------------------------------------------------------------ *
 * Cost Management
 * ------------------------------------------------------------------ */

/**
 * Runs a Cost Management query and flattens the column/row shape into objects.
 * All calls funnel through costLimiter because this API throttles aggressively.
 */
export async function queryCost(subscriptionId, { from, to, granularity = 'None', grouping = [], filter = null }) {
  const body = {
    type: 'ActualCost',
    timeframe: 'Custom',
    timePeriod: { from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` },
    dataset: {
      granularity,
      aggregation: {
        totalCost: { name: 'Cost', function: 'Sum' },
        totalCostUSD: { name: 'CostUSD', function: 'Sum' },
      },
      ...(grouping.length ? { grouping } : {}),
      ...(filter ? { filter } : {}),
    },
  };

  const rows = [];
  let url = `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${API.cost}`;
  let payload = body;

  while (url) {
    const page = await costLimiter(() =>
      request(url, { method: 'POST', body: payload, label: 'costQuery', retries: 8 }),
    );
    if (!page) break;

    const columns = (page.properties?.columns ?? []).map((c) => c.name);
    for (const row of page.properties?.rows ?? []) {
      const obj = {};
      columns.forEach((c, i) => {
        obj[c] = row[i];
      });
      rows.push(obj);
    }

    url = page.properties?.nextLink ?? null;
    // Continuation links already embed the query, so the body must not be resent.
    payload = url ? undefined : payload;
    if (url && !payload) payload = body;
  }

  return rows;
}

/* ------------------------------------------------------------------ *
 * Azure Monitor metrics
 * ------------------------------------------------------------------ */

/**
 * Canonical field each Azure metric feeds, in priority order.
 *
 * The fleet is heterogeneous: modern `AIServices` accounts expose the "Models - Usage"
 * metrics (InputTokens/OutputTokens/TotalTokens/ModelRequests) while older `OpenAI`
 * accounts expose the original Azure OpenAI set. Requesting a metric an account does
 * not publish fails the whole request with a 400, so we read the account's metric
 * definitions first and only ask for what exists.
 */
const METRIC_PLAN = [
  { field: 'inputTokens', candidates: ['InputTokens', 'ProcessedPromptTokens'] },
  { field: 'outputTokens', candidates: ['OutputTokens', 'GeneratedTokens'] },
  { field: 'totalTokens', candidates: ['TotalTokens', 'TokenTransaction'] },
  { field: 'calls', candidates: ['ModelRequests', 'AzureOpenAIRequests'] },
];

const SPLIT_DIMENSIONS = ['ModelDeploymentName', 'ModelName', 'DeploymentName'];

const definitionCache = new Map();

/** Reads the metric definitions an account actually publishes. */
export async function listMetricDefinitions(account) {
  if (definitionCache.has(account.id)) return definitionCache.get(account.id);
  try {
    const data = await metricsLimiter(() =>
      request(
        `${ARM}${account.id}/providers/Microsoft.Insights/metricDefinitions?api-version=2018-01-01`,
        { label: `metricDefs:${account.name}`, retries: 2 },
      ),
    );
    const defs = new Map();
    for (const d of data?.value ?? []) {
      const name = d.name?.value ?? d.name;
      if (!name) continue;
      defs.set(name, {
        name,
        dimensions: (d.dimensions ?? []).map((x) => x.value ?? x.name ?? x),
        unit: d.unit,
        primaryAggregation: d.primaryAggregationType,
      });
    }
    definitionCache.set(account.id, defs);
    return defs;
  } catch {
    definitionCache.set(account.id, new Map());
    return new Map();
  }
}

/**
 * Fetches token and request metrics for one account, split by model deployment.
 * Metric names are resolved per account so a heterogeneous fleet does not 400.
 */
export async function fetchAccountMetrics(account, { from, to, interval = 'P1D' }) {
  const defs = await listMetricDefinitions(account);
  const result = {
    accountId: account.id,
    accountName: account.name,
    series: [],
    errors: [],
    resolved: {},
  };

  if (defs.size === 0) {
    result.errors.push({ message: 'No metric definitions published for this account.' });
    return result;
  }

  // Pick one concrete metric per canonical field, plus a dimension we can split on.
  const selected = [];
  for (const { field, candidates } of METRIC_PLAN) {
    const hit = candidates.find((c) => defs.has(c));
    if (!hit) continue;
    const dimension = SPLIT_DIMENSIONS.find((d) => defs.get(hit).dimensions.includes(d)) ?? null;
    selected.push({ field, metric: hit, dimension });
    result.resolved[field] = hit;
  }

  if (!selected.length) {
    result.errors.push({ message: `Account publishes no token or request metrics (${defs.size} metrics available).` });
    return result;
  }

  const base = `${ARM}${account.id}/providers/Microsoft.Insights/metrics`;
  const timespan = `${from}T00:00:00Z/${to}T23:59:59Z`;

  // Group by dimension so metrics sharing a split can travel in one request.
  const byDimension = new Map();
  for (const s of selected) {
    const key = s.dimension ?? '__none__';
    if (!byDimension.has(key)) byDimension.set(key, []);
    byDimension.get(key).push(s);
  }

  for (const [dimension, group] of byDimension) {
    // Azure Monitor rejects percent-encoded commas in `metricnames`, so the query
    // string is assembled by hand: metric names keep literal commas while the filter
    // is encoded normally.
    const query = [
      `api-version=${API.metrics}`,
      `metricnames=${group.map((g) => g.metric).join(',')}`,
      `timespan=${encodeURIComponent(timespan)}`,
      `interval=${interval}`,
      'aggregation=Total',
      `metricnamespace=${encodeURIComponent('Microsoft.CognitiveServices/accounts')}`,
    ];
    if (dimension !== '__none__') {
      query.push(`$filter=${encodeURIComponent(`${dimension} eq '*'`)}`);
      query.push('top=200');
    }

    try {
      const data = await metricsLimiter(() =>
        request(`${base}?${query.join('&')}`, { label: `metrics:${account.name}`, retries: 3 }),
      );
      const fieldFor = new Map(group.map((g) => [g.metric, g.field]));

      for (const metric of data?.value ?? []) {
        const metricName = metric.name?.value ?? metric.name;
        const field = fieldFor.get(metricName);
        if (!field) continue;

        for (const ts of metric.timeseries ?? []) {
          const meta = ts.metadatavalues ?? [];
          const deployment =
            meta.find((m) => SPLIT_DIMENSIONS.some(
              (d) => d.toLowerCase() === String(m.name?.value ?? m.name).toLowerCase(),
            ))?.value ?? 'unattributed';

          const points = (ts.data ?? [])
            .filter((p) => typeof p.total === 'number' && p.total > 0)
            .map((p) => ({ t: p.timeStamp, v: p.total }));
          if (!points.length) continue;

          result.series.push({ metric: metricName, field, deployment, points });
        }
      }
    } catch (err) {
      result.errors.push({ metrics: group.map((g) => g.metric), message: err.message });
    }
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

export function resourceGroupFromId(id = '') {
  const m = /\/resourceGroups\/([^/]+)/i.exec(id);
  return m ? m[1] : null;
}

export { AzureError, getToken, SCOPE_ARM, SCOPE_AI };
