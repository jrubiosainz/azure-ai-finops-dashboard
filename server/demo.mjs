import { buildFinopsModel } from './finops.mjs';
import { defaultRange } from './sync.mjs';
import { summarizeTelemetry } from './telemetry.mjs';
import { attributeUseCases } from './usecases.mjs';

// Entirely synthetic fixtures; never copied or anonymized from an Azure subscription.
const DEMO_SUBSCRIPTION = '00000000-0000-4000-8000-000000000001';
const prefix = `/subscriptions/${DEMO_SUBSCRIPTION}`;
const resourceId = (group, type, name) => `${prefix}/resourceGroups/${group}/providers/${type}/${name}`;

function dailyParts(total, dates) {
  const weights = dates.map((_, i) => 10 + (i % 7) * 2 + (i === Math.floor(dates.length / 2) ? 20 : 0));
  const weight = weights.reduce((s, n) => s + n, 0);
  let remaining = total;
  return dates.map((date, i) => {
    const value = i === dates.length - 1 ? remaining : Math.floor(total * weights[i] / weight);
    remaining -= value;
    return { t: `${date}T00:00:00Z`, v: value };
  });
}

export function createDemoData({ days = 30, now = new Date() } = {}) {
  const range = defaultRange(days, now);
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(new Date(`${range.from}T00:00:00Z`).getTime() + i * 86_400_000).toISOString().slice(0, 10));
  const groups = ['support', 'documents', 'lab'].map((name) => ({
    name: `rg-${name}-demo`, location: 'westeurope', tags: { environment: 'synthetic-demo' },
  }));
  const accounts = groups.map((g, i) => ({
    id: resourceId(g.name, 'Microsoft.CognitiveServices/accounts', `ai-${['support', 'documents', 'lab'][i]}-demo`),
    name: `ai-${['support', 'documents', 'lab'][i]}-demo`,
    resourceGroup: g.name, location: g.location, kind: 'AIServices', isFoundry: true,
  }));
  const specs = [
    { account: 0, name: 'support-chat', model: 'gpt-4.1-mini', calls: 18000, input: 10000000, output: 2000000, inputCost: 40, outputCost: 48 },
    { account: 0, name: 'support-embedding', model: 'text-embedding-3-small', calls: 9000, input: 6000000, output: 0, inputCost: 6, outputCost: 0 },
    { account: 1, name: 'document-extraction', model: 'gpt-4.1', calls: 6000, input: 8000000, output: 1000000, inputCost: 80, outputCost: 40 },
    { account: 1, name: 'document-review', model: 'gpt-4.1', calls: 3000, input: 4000000, output: 500000, inputCost: 40, outputCost: 20 },
    { account: 2, name: 'lab-chat', model: 'gpt-4.1-mini', calls: 1000, input: 1000000, output: 250000, inputCost: 4, outputCost: 6 },
    { account: 2, name: 'lab-evaluation', model: 'gpt-4.1', calls: 200, input: 500000, output: 200000, inputCost: 5, outputCost: 8 },
  ];
  const deployments = specs.map((s) => {
    const a = accounts[s.account];
    return {
      id: `${a.id}/deployments/${s.name}`, name: s.name, model: s.model,
      accountId: a.id, accountName: a.name, resourceGroup: a.resourceGroup, skuName: 'GlobalStandard',
    };
  });
  const metrics = accounts.map((a, i) => ({
    accountId: a.id,
    series: specs.filter((s) => s.account === i).flatMap((s) =>
      [['inputTokens', s.input], ['outputTokens', s.output], ['totalTokens', s.input + s.output], ['calls', s.calls]]
        .map(([field, total]) => ({ deployment: s.name, field, points: dailyParts(total, dates) }))),
  }));
  const costRows = specs.flatMap((s) => {
    const a = accounts[s.account];
    return [['Inp', s.inputCost], ['Outp', s.outputCost]].filter(([, cost]) => cost > 0).map(([direction, cost]) => ({
      ResourceId: a.id, ResourceGroupName: a.resourceGroup, ServiceName: 'Foundry Models',
      Meter: `${s.model} ${direction} glbl Tokens`, Cost: cost, Currency: 'USD',
    }));
  });
  for (const [account, service, type, name, meter, cost] of [
    [0, 'Foundry Tools', 'Microsoft.CognitiveServices/accounts', accounts[0].name, 'Hosted vCPU Usage', 60],
    [1, 'Foundry Tools', 'Microsoft.CognitiveServices/accounts', accounts[1].name, 'Hosted vCPU Usage', 30],
    [0, 'Azure Cognitive Search', 'Microsoft.Search/searchServices', 'search-support-demo', 'Standard Search Unit', 420],
    [1, 'Azure App Service', 'Microsoft.Web/sites', 'app-documents-demo', 'App Service Compute', 180],
    [2, 'Log Analytics', 'Microsoft.OperationalInsights/workspaces', 'logs-lab-demo', 'Data Ingestion', 72],
    [1, 'Storage', 'Microsoft.Storage/storageAccounts', 'demostorage', 'Data Stored', 48],
  ]) {
    const a = accounts[account];
    costRows.push({
      ResourceId: resourceId(a.resourceGroup, type, name), ResourceGroupName: a.resourceGroup,
      ServiceName: service, Meter: meter, Cost: cost, Currency: 'USD',
    });
  }
  const projects = accounts.map((a, i) => ({
    id: `${a.id}/projects/${['customer-support', 'document-processing', 'experiments'][i]}`,
    name: ['customer-support', 'document-processing', 'experiments'][i],
    accountId: a.id, accountName: a.name, resourceGroup: a.resourceGroup,
  }));
  const assignments = [
    ['support-triage', 0], ['support-escalation', 0], ['support-retrieval', 1],
    ['document-extractor', 2], ['document-reviewer', 3],
    ['lab-assistant', 4], ['lab-evaluator', 5],
  ];
  const agents = assignments.map(([name, spec], i) => {
    const d = deployments[spec];
    const p = projects[specs[spec].account];
    return {
      id: `asst_demo_${i + 1}`, name, model: d.name, projectId: p.id, projectName: p.name,
      accountId: d.accountId, accountName: d.accountName, resourceGroup: d.resourceGroup,
    };
  });
  const costDaily = costRows.flatMap((row) =>
    dailyParts(Math.round(row.Cost * 10000), dates).map((point) => ({
      UsageDate: point.t.slice(0, 10), ServiceName: row.ServiceName, Cost: point.v / 10000,
    })));
  const model = buildFinopsModel({
    costRows, costDaily, accounts, deployments, projects, agents, metrics,
    resourceGroups: groups, currency: 'USD',
  });
  const calls = Array.from({ length: 120 }, (_, i) => {
    const agent = agents[i % agents.length];
    const usage = i % 3 === 0;
    return {
      at: `${dates[i % dates.length]}T${String(9 + i % 8).padStart(2, '0')}:15:00Z`,
      app: `app-${agent.projectName}`, agentName: agent.name, agentId: agent.id,
      projectId: agent.projectId, model: deployments.find((d) => d.name === agent.model).model,
      operation: usage ? 'chat' : 'invoke_agent', inputTokens: usage ? 1200 + i * 10 : 0,
      outputTokens: usage ? 250 + i * 2 : 0, cachedTokens: 0, durationMs: 250 + i * 17,
      ok: i % 19 !== 0, maskedIp: true, ip: null, user: null, session: null,
      conversationId: `demo-conversation-${Math.floor(i / 3)}`, operationId: `demo-span-${i}`, source: 'span',
    };
  });
  const telemetry = summarizeTelemetry({
    calls, componentCount: 3, workspaceCount: 3,
    scanned: groups.map((g, i) => ({
      workspace: `logs-${i + 1}-demo`, rows: 1000, calls: 40, resourceGroup: g.name, error: null,
    })),
  }, { meteredCalls: model.totals.calls });
  const gateways = [{ name: 'apim-demo', gateway: 'https://gateway.example.invalid', location: 'westeurope' }];
  const useCases = attributeUseCases({
    gateways, deployments: model.deployments, agents: model.agents,
    useCases: [
      { id: 'customer-support', display: 'Atencion al cliente', owner: 'Operaciones', account: 0, specs: [0, 1],
        description: 'Demostracion ficticia: clasificacion, respuesta y recuperacion de conocimiento.' },
      { id: 'document-analysis', display: 'Analisis documental', owner: 'Back office', account: 1, specs: [2, 3],
        description: 'Demostracion ficticia: extraccion y revision de documentos.' },
    ].map((u) => {
      const members = u.specs.map((i) => specs[i]);
      const a = accounts[u.account];
      return {
        id: u.id, display: u.display, description: u.description, owner: u.owner,
        account: a.name, resourceGroup: a.resourceGroup, gateway: 'apim-demo',
        gatewayUrl: gateways[0].gateway, products: [u.id], deployments: members.map((s) => s.name),
        agents: agents.filter((ag) => ag.accountName === a.name).map((ag) => ag.name),
        gatewayCalls: members.reduce((n, s) => n + s.calls, 0), gatewayFailed: 0, gatewayDurationMs: 840 + u.account * 700,
        operations: members.map((s) => ({ id: `${s.name}-invoke`, deployment: s.name, calls: s.calls, failed: 0 })),
      };
    }),
  });
  return {
    ...model,
    mode: 'demo',
    subscription: { id: DEMO_SUBSCRIPTION, name: 'DEMO - Contoso AI | Datos ficticios', state: 'Synthetic' },
    range, generatedAt: new Date(now).toISOString(), durationMs: 0, warnings: [],
    totals: {
      ...model.totals,
      tokenCost: model.meters.filter((m) => ['tokens', 'images', 'embeddings'].includes(m.kind)).reduce((s, m) => s + m.cost, 0),
    },
    counts: {
      resourceGroups: groups.length, accounts: accounts.length, deployments: deployments.length,
      projects: projects.length, agents: agents.length, useCases: useCases.rows.length, costRows: costRows.length,
    },
    telemetry, useCases,
  };
}
