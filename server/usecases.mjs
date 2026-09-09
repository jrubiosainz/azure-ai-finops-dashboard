/**
 * Use-case attribution.
 *
 * Azure bills resources and meters, not agents. Model deployments are child
 * resources without Azure resource tags. So Cost Management can
 * never answer "what does this use case cost" on its own.
 *
 * API Management can. A use case is declared there as a tag; the deployments it
 * consumes are native tagged operations, and the agents — which are not APIM
 * entities — are published in a named-value registry. Reading both back gives a
 * membership list, and the gateway's own reports give the call counts, so the
 * dashboard can re-bucket cost across accounts and resource groups by use case.
 */

import { request } from './azure.mjs';

const ARM = 'https://management.azure.com';
const API_V = '2024-05-01';

/** Named value that carries the agent half of the membership list. */
const REGISTRY = 'casos-de-uso';

const lower = (v) => String(v ?? '').toLowerCase();
const leaf = (id = '') => String(id).split('/').filter(Boolean).pop() ?? '';

async function listServices(subscriptionId, onWarn) {
  try {
    const res = await request(
      `${ARM}/subscriptions/${subscriptionId}/providers/Microsoft.ApiManagement/service?api-version=${API_V}`,
      { label: 'apim/list' },
    );
    return (res?.value ?? []).map((s) => ({
      id: s.id,
      name: s.name,
      resourceGroup: (/\/resourceGroups\/([^/]+)/i.exec(s.id) ?? [])[1] ?? '',
      sku: s.sku?.name ?? '',
      gateway: s.properties?.gatewayUrl ?? '',
      location: s.location ?? '',
    }));
  } catch (e) {
    onWarn(`apim: no se pudieron listar las pasarelas: ${e.message}`);
    return [];
  }
}

/** The registry is authoritative for names, owners and agents. */
async function readRegistry(service, onWarn) {
  try {
    const nv = await request(
      `${ARM}${service.id}/namedValues/${REGISTRY}?api-version=${API_V}`,
      { label: `apim/${service.name}/registry` },
    );
    const parsed = JSON.parse(nv?.properties?.value ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.status !== 404) onWarn(`apim/${service.name}/registry: ${error.message}`);
    return [];
  }
}

/** Tag links are the native, verifiable half: what the gateway itself believes. */
async function readTagLinks(service, tagId, onWarn) {
  const one = async (kind, field) => {
    try {
      const res = await request(
        `${ARM}${service.id}/tags/${encodeURIComponent(tagId)}/${kind}?api-version=${API_V}`,
        { label: `apim/${tagId}/${kind}` },
      );
      return (res?.value ?? []).map((l) => leaf(l.properties?.[field] ?? l.id));
    } catch (error) {
      onWarn(`apim/${service.name}/${tagId}/${kind}: ${error.message}`);
      return [];
    }
  };
  const [apis, operations, products] = await Promise.all([
    one('apiLinks', 'apiId'),
    one('operationLinks', 'operationId'),
    one('productLinks', 'productId'),
  ]);
  return { apis, operations, products };
}

/**
 * The gateway counts every call it brokered, whether or not the caller was
 * instrumented — which makes it a firmer floor than Application Insights.
 *
 * Both report shapes return ids as full ARM-style paths
 * (`/apis/caso-de-uso-1/operations/cdu1-chat-chat`), so every key is reduced to
 * its leaf before it is matched against a tag link.
 */
async function readReports(service, { from, to }, onWarn) {
  const filter =
    `timestamp ge datetime'${from}T00:00:00Z' and timestamp le datetime'${to}T23:59:59Z'`;

  const fetchReport = async (kind) => {
    try {
      const res = await request(
        `${ARM}${service.id}/reports/${kind}?api-version=${API_V}&$filter=${encodeURIComponent(filter)}`,
        { label: `apim/${service.name}/${kind}` },
      );
      return res?.value ?? [];
    } catch (e) {
      onWarn(`apim: no se pudo leer el informe ${kind}: ${e.message}`);
      return [];
    }
  };

  const [ops, apis] = await Promise.all([fetchReport('byOperation'), fetchReport('byApi')]);

  const stats = (r) => ({
    calls: r.callCountTotal ?? 0,
    ok: r.callCountSuccess ?? 0,
    failed: (r.callCountFailed ?? 0) + (r.callCountBlocked ?? 0),
    durationMs: r.apiTimeAvg ?? 0,
  });

  return {
    byOperation: new Map(ops.filter((r) => r.operationId).map((r) => [leaf(r.operationId), stats(r)])),
    byApi: new Map(apis.filter((r) => r.apiId).map((r) => [leaf(r.apiId), stats(r)])),
  };
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

/**
 * @returns {Promise<{gateways: object[], useCases: object[]}>} membership only —
 * cost and tokens are folded in later, where the model figures already live.
 */
export async function collectUseCases(subscriptionId, range, onWarn = () => {}) {
  const services = await listServices(subscriptionId, onWarn);
  const gateways = [];
  const useCases = [];

  for (const service of services) {
    const registry = await readRegistry(service, onWarn);
    if (!registry.length) continue;

    const report = await readReports(service, range, onWarn);
    gateways.push({
      name: service.name,
      resourceGroup: service.resourceGroup,
      sku: service.sku,
      gateway: service.gateway,
      location: service.location,
      useCases: registry.length,
    });

    for (const entry of registry) {
      if (!entry.id || !entry.account || !Array.isArray(entry.deployments) || !Array.isArray(entry.agents) ||
          !entry.deployments.every((d) => typeof d === 'string') || !entry.agents.every((a) => typeof a === 'string')) {
        onWarn(`apim/${service.name}: registro invalido; consulta docs/azure-setup.md.`);
        continue;
      }
      const links = await readTagLinks(service, entry.id, onWarn);

      // An operation id is `${deployment}-${verb}`; the report keys on it, so calls
      // land on the deployment that actually served them.
      const operations = links.operations.map((opId) => {
        const stats = report.byOperation.get(opId) ?? { calls: 0, ok: 0, failed: 0, durationMs: 0 };
        const deployment =
          (entry.deployments ?? []).find((d) => opId.startsWith(`${d}-`)) ?? opId;
        return { id: opId, deployment, ...stats };
      });

      // The API roll-up is the authority for the use-case total: it also counts calls
      // that never matched a tagged operation, which an operation sum would silently drop.
      const apiStats = links.apis.reduce(
        (acc, apiId) => {
          const s = report.byApi.get(apiId);
          if (!s) return acc;
          return {
            calls: acc.calls + s.calls,
            failed: acc.failed + s.failed,
            durationMs: Math.max(acc.durationMs, s.durationMs),
          };
        },
        { calls: 0, failed: 0, durationMs: 0 },
      );
      const operationCalls = operations.reduce((s, o) => s + o.calls, 0);

      useCases.push({
        id: entry.id,
        display: entry.display ?? entry.id,
        description: entry.description ?? '',
        owner: entry.owner ?? '',
        account: entry.account ?? '',
        resourceGroup: entry.resourceGroup ?? '',
        gateway: service.name,
        gatewayUrl: service.gateway,
        agents: entry.agents ?? [],
        deployments: entry.deployments ?? [],
        apis: links.apis,
        products: links.products,
        operations,
        gatewayCalls: Math.max(apiStats.calls, operationCalls),
        gatewayFailed: Math.max(apiStats.failed, operations.reduce((s, o) => s + o.failed, 0)),
        gatewayDurationMs: apiStats.durationMs,
      });
    }
  }

  return { gateways, useCases };
}

/* ------------------------------------------------------------------ *
 * Joining to money
 * ------------------------------------------------------------------ */

/**
 * Folds the FinOps model's derived per-deployment cost into the use cases, so a
 * tag declared in the gateway carries a number that reconciles with the bill.
 */
export function attributeUseCases({ useCases, gateways, deployments = [], agents = [] }) {
  const byDeployment = new Map();
  for (const d of deployments) {
    byDeployment.set(lower(`${d.accountName}/${d.name}`), d);
  }

  const owners = new Set();
  const caseIds = new Set();
  for (const uc of useCases) {
    if (caseIds.has(uc.id)) throw new Error(`Caso de uso duplicado: ${uc.id}. Usa identificadores unicos.`);
    caseIds.add(uc.id);
    for (const name of uc.deployments) {
      const key = lower(`${uc.account}/${name}`);
      if (owners.has(key)) throw new Error(`Despliegue repetido entre casos de uso: ${key}. No se sumara dos veces.`);
      owners.add(key);
    }
  }

  const rows = useCases.map((uc) => {
    const agentFor = (name) => {
      const matches = agents.filter((a) => lower(a.accountName) === lower(uc.account) && lower(a.name) === lower(name));
      return matches.length === 1 ? matches[0] : null;
    };
    const members = [];
    let cost = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let meteredCalls = 0;

    for (const name of uc.deployments) {
      const d = byDeployment.get(lower(`${uc.account}/${name}`));
      const op = uc.operations.find((o) => o.deployment === name);
      const row = {
        name,
        model: d?.model ?? '',
        modelKey: d?.modelKey ?? '',
        account: d?.accountName ?? uc.account,
        resourceGroup: d?.resourceGroup ?? uc.resourceGroup,
        cost: d?.cost ?? 0,
        calls: d?.calls ?? 0,
        gatewayCalls: op?.calls ?? 0,
        gatewayFailed: op?.failed ?? 0,
        durationMs: op?.durationMs ?? 0,
        inputTokens: d?.inputTokens ?? 0,
        outputTokens: d?.outputTokens ?? 0,
        confidence: d?.confidence ?? 'declarado',
        billed: Boolean(d && d.cost > 0),
      };
      cost += row.cost;
      inputTokens += row.inputTokens;
      outputTokens += row.outputTokens;
      meteredCalls += row.calls;
      members.push(row);
    }

    // Azure bills the deployment, so an agent has no invoice of its own. A use case
    // declares which deployment each agent runs on, which is enough to hand the agent a
    // defensible share: the deployment's figures split evenly across the agents that
    // declare it. Without this the agent rail reads as empty, which is worse than an
    // explicit, labelled apportionment.
    const declaring = new Map();
    for (const name of uc.agents) {
      const a = agentFor(name);
      const target = a?.model ?? '';
      if (!target) continue;
      if (!declaring.has(target)) declaring.set(target, []);
      declaring.get(target).push(name);
    }
    const shareOf = (deploymentName) => declaring.get(deploymentName)?.length ?? 0;
    const rankOf = (deploymentName, name) =>
      declaring.get(deploymentName)?.indexOf(name) ?? -1;

    // Calls and tokens are counts, so rounding each share independently would make the
    // agent column sum to something other than the deployment it came from — the first
    // thing a FinOps reviewer checks. Hand out the floor to everyone and give the
    // remainder to the first agents in the list, which sums back exactly.
    const wholeShare = (total, peers, rank) => {
      if (!peers || rank < 0) return 0;
      return Math.floor(total / peers) + (rank < total % peers ? 1 : 0);
    };

    const agentRows = uc.agents.map((name) => {
      const a = agentFor(name);
      const target = a?.model ?? '';
      const d = members.find((m) => m.name === target);
      const peers = shareOf(target);
      const rank = rankOf(target, name);
      const split = d && peers ? 1 / peers : 0;
      return {
        name,
        model: target,
        project: a?.projectName ?? '',
        account: a?.accountName ?? uc.account,
        calls: d ? wholeShare(d.gatewayCalls || d.calls, peers, rank) : 0,
        cost: (d?.cost ?? 0) * split,
        tokens: d ? wholeShare(d.inputTokens + d.outputTokens, peers, rank) : 0,
        deployment: target,
        peers,
        basis: d ? 'repartido' : 'sin despliegue unico',
        registered: Boolean(a),
      };
    });

    const tokens = inputTokens + outputTokens;
    return {
      ...uc,
      deploymentRows: members,
      agentRows,
      cost,
      inputTokens,
      outputTokens,
      tokens,
      meteredCalls,
      calls: uc.gatewayCalls || meteredCalls,
      costPerCall: uc.gatewayCalls ? cost / uc.gatewayCalls : meteredCalls ? cost / meteredCalls : 0,
      costPer1kTokens: tokens ? (cost / tokens) * 1000 : 0,
      agentCount: agentRows.length,
      deploymentCount: members.length,
      registeredAgents: agentRows.filter((a) => a.registered).length,
      billedDeployments: members.filter((d) => d.billed).length,
    };
  });

  rows.sort((a, b) => b.cost - a.cost || b.calls - a.calls);

  const totals = rows.reduce(
    (acc, r) => ({
      cost: acc.cost + r.cost,
      calls: acc.calls + r.calls,
      gatewayCalls: acc.gatewayCalls + r.gatewayCalls,
      meteredCalls: acc.meteredCalls + r.meteredCalls,
      tokens: acc.tokens + r.tokens,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
      agents: acc.agents + r.agentCount,
      deployments: acc.deployments + r.deploymentCount,
    }),
    {
      cost: 0,
      calls: 0,
      gatewayCalls: 0,
      meteredCalls: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      agents: 0,
      deployments: 0,
    },
  );

  return { gateways, rows, totals };
}
