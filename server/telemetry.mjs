/**
 * Per-call GenAI telemetry.
 *
 * Azure Monitor metrics answer "how many tokens did this deployment burn". They cannot
 * answer "which agent burned them, in which conversation, and how long did it take".
 * That answer only exists in Application Insights, where an instrumented caller emits
 * OpenTelemetry GenAI spans.
 *
 * This module finds every workspace-backed Application Insights component in the
 * subscription, pulls the GenAI spans out of it, and reports honestly on how much of the
 * estate is actually instrumented — because the coverage gap is itself a FinOps finding.
 */

import { request, listAppInsights, listWorkspaces } from './azure.mjs';

const LA = 'https://api.loganalytics.io/v1';
const SCOPE_LA = 'https://api.loganalytics.io/.default';

/** Azure masks the caller address to this when the SDK never set one. */
const MASKED_IP = '0.0.0.0';

/** A conservative ceiling: a workspace with more spans than this is sampled, not truncated silently. */
const CALL_LIMIT = 4000;

/* ------------------------------------------------------------------ *
 * KQL
 * ------------------------------------------------------------------ */

/**
 * `isfuzzy=true` is load-bearing: most workspaces in a real subscription have never
 * seen an App Insights ingestion and therefore have no AppDependencies table at all.
 * Without it the whole query fails with a semantic error instead of returning nothing.
 */
function callsQuery(from, to) {
  return `
let span = union isfuzzy=true AppDependencies, AppTraces, AppEvents
| where TimeGenerated between (datetime(${from}) .. datetime(${to}))
| where tostring(Properties) has "gen_ai." or tostring(Measurements) has "gen_ai.usage"
| extend P = todynamic(Properties), M = todynamic(Measurements)
| extend
    agentName = tostring(P["gen_ai.agent.name"]),
    agentId   = tostring(P["gen_ai.agent.id"]),
    operation = tostring(P["gen_ai.operation.name"]),
    reqModel  = tostring(P["gen_ai.request.model"]),
    resModel  = tostring(P["gen_ai.response.model"]),
    provider  = tostring(P["gen_ai.provider.name"]),
    projectId = tostring(P["gen_ai.azure_ai_project.id"]),
    convId    = tostring(P["gen_ai.conversation.id"]),
    finish    = tostring(P["gen_ai.response.finish_reasons"]),
    channel   = tostring(P["microsoft.channel.name"]),
    toolName  = tostring(P["gen_ai.tool.name"]),
    inTok     = coalesce(todouble(M["gen_ai.usage.input_tokens"]),  todouble(P["gen_ai.usage.input_tokens"]),  real(0)),
    outTok    = coalesce(todouble(M["gen_ai.usage.output_tokens"]), todouble(P["gen_ai.usage.output_tokens"]), real(0)),
    cacheTok  = coalesce(todouble(M["gen_ai.usage.cached_tokens"]), todouble(P["gen_ai.usage.cached_tokens"]), real(0))
| extend
    name     = column_ifexists("Name", ""),
    duration = coalesce(todouble(column_ifexists("DurationMs", real(0))), real(0)),
    ok       = coalesce(tobool(column_ifexists("Success", true)), true),
    ip       = tostring(column_ifexists("ClientIP", "")),
    user     = tostring(column_ifexists("UserId", "")),
    session  = tostring(column_ifexists("SessionId", "")),
    role     = tostring(column_ifexists("AppRoleName", "")),
    opId     = tostring(column_ifexists("OperationId", ""))
| where isnotempty(operation) or isnotempty(agentName) or inTok > 0 or isnotempty(toolName);
let content = union isfuzzy=true AppGenAIContent
| where TimeGenerated between (datetime(${from}) .. datetime(${to}))
| extend A = todynamic(Attributes)
| project TimeGenerated,
    agentName = tostring(column_ifexists("AgentName", "")),
    agentId   = tostring(column_ifexists("AgentId", "")),
    operation = tostring(A["gen_ai.operation.name"]),
    reqModel  = tostring(column_ifexists("ModelName", "")),
    resModel  = tostring(column_ifexists("ModelName", "")),
    provider  = "", projectId = "", convId = "", finish = "", channel = "",
    toolName  = tostring(A["gen_ai.tool.name"]),
    inTok = real(0), outTok = real(0), cacheTok = real(0),
    name = "", duration = real(0), ok = true, ip = "", user = "", session = "",
    role = tostring(column_ifexists("RoleName", "")), opId = tostring(column_ifexists("TraceId", "")),
    source = "content";
union isfuzzy=true (span | extend source = "span"), content
| project TimeGenerated, agentName, agentId, operation, reqModel, resModel, provider,
          projectId, convId, finish, channel, toolName, inTok, outTok, cacheTok,
          name, duration, ok, ip, user, session, role, opId, source
| order by TimeGenerated desc
| take ${CALL_LIMIT}`;
}

/** Cheap probe: does this workspace hold anything at all in the window? */
function volumeQuery(from, to) {
  return `union isfuzzy=true AppRequests, AppDependencies, AppTraces, AppEvents, AppGenAIContent
| where TimeGenerated between (datetime(${from}) .. datetime(${to}))
| summarize rows = count(), genai = countif(tostring(column_ifexists("Properties","")) has "gen_ai." or Type == "AppGenAIContent")`;
}

async function kql(customerId, query, label) {
  const res = await request(`${LA}/workspaces/${customerId}/query?query=${encodeURIComponent(query)}`, {
    scope: SCOPE_LA,
    retries: 2,
    label,
  });
  const table = res?.tables?.[0];
  if (!table) return [];
  const names = table.columns.map((c) => c.name);
  return (table.rows ?? []).map((row) => Object.fromEntries(names.map((n, i) => [n, row[i]])));
}

/* ------------------------------------------------------------------ *
 * Collection
 * ------------------------------------------------------------------ */

const lower = (v) => String(v ?? '').toLowerCase();

/**
 * @returns per-call GenAI records plus a coverage report over the whole estate.
 */
export async function collectTelemetry(subscriptionId, { from, to }, onWarn = () => {}) {
  const [components, workspaces] = await Promise.all([
    listAppInsights(subscriptionId).catch((e) => {
      onWarn(`No se pudieron listar los componentes de Application Insights: ${e.message}`);
      return [];
    }),
    listWorkspaces(subscriptionId).catch((e) => {
      onWarn(`No se pudieron listar los workspaces de Log Analytics: ${e.message}`);
      return [];
    }),
  ]);

  const byResourceId = new Map(workspaces.map((w) => [lower(w.id), w]));

  // A component is only queryable through the workspace that backs it. Group components
  // by workspace so a workspace shared by four components is queried once.
  const targets = new Map();
  for (const w of workspaces) {
    targets.set(w.customerId, { workspace: w, components: [] });
  }
  for (const c of components) {
    const w = byResourceId.get(lower(c.workspaceResourceId));
    if (!w) continue;
    targets.get(w.customerId)?.components.push(c);
  }

  const from_ = `${from}T00:00:00Z`;
  const to_ = `${to}T23:59:59Z`;

  const scanned = [];
  const calls = [];

  // Log Analytics is generous compared to Cost Management; a shallow fan-out is safe.
  const list = [...targets.values()];
  for (let i = 0; i < list.length; i += 4) {
    await Promise.all(
      list.slice(i, i + 4).map(async ({ workspace, components: comps }) => {
        const entry = {
          workspace: workspace.name,
          resourceGroup: workspace.resourceGroup,
          components: comps.map((c) => c.name),
          rows: 0,
          genaiRows: 0,
          calls: 0,
          error: null,
        };
        scanned.push(entry);

        try {
          const [vol] = await kql(workspace.customerId, volumeQuery(from_, to_), `volume ${workspace.name}`);
          entry.rows = Number(vol?.rows ?? 0);
          entry.genaiRows = Number(vol?.genai ?? 0);
          if (!entry.rows) return;

          const rows = await kql(workspace.customerId, callsQuery(from_, to_), `genai ${workspace.name}`);
          entry.calls = rows.length;

          for (const r of rows) {
            calls.push({
              at: r.TimeGenerated,
              workspace: workspace.name,
              resourceGroup: workspace.resourceGroup,
              app: r.role || comps[0]?.name || workspace.name,
              agentName: r.agentName || null,
              agentId: r.agentId || null,
              operation: r.operation || (r.toolName ? 'execute_tool' : null),
              tool: r.toolName || null,
              model: r.resModel || r.reqModel || null,
              provider: r.provider || null,
              projectId: r.projectId || null,
              conversationId: r.convId || null,
              finish: r.finish || null,
              channel: r.channel || null,
              inputTokens: Number(r.inTok ?? 0),
              outputTokens: Number(r.outTok ?? 0),
              cachedTokens: Number(r.cacheTok ?? 0),
              durationMs: Number(r.duration ?? 0),
              ok: r.ok !== false,
              ip: r.ip && r.ip !== MASKED_IP ? r.ip : null,
              maskedIp: r.ip === MASKED_IP,
              user: r.user || null,
              session: r.session || null,
              operationId: r.opId || null,
              source: r.source,
            });
          }
        } catch (e) {
          entry.error = e.message.slice(0, 160);
          onWarn(`Telemetría no legible en ${workspace.name}: ${entry.error}`);
        }
      }),
    );
  }

  return { calls, scanned, componentCount: components.length, workspaceCount: workspaces.length };
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

function bump(map, key, seed) {
  if (!map.has(key)) map.set(key, seed());
  return map.get(key);
}

const blank = () => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  durationMs: 0,
  timed: 0,
  failures: 0,
  conversations: new Set(),
  models: new Set(),
  operations: new Set(),
});

function seal(v, extra = {}) {
  return {
    calls: v.calls,
    inputTokens: v.inputTokens,
    outputTokens: v.outputTokens,
    cachedTokens: v.cachedTokens,
    totalTokens: v.inputTokens + v.outputTokens,
    avgDurationMs: v.timed ? v.durationMs / v.timed : null,
    failures: v.failures,
    conversations: v.conversations.size,
    models: [...v.models],
    operations: [...v.operations],
    ...extra,
  };
}

/** How much a single span can be used to argue with. Higher sorts to the top of the tape. */
function evidence(c) {
  return (
    (c.inputTokens + c.outputTokens > 0 ? 8 : 0) +
    (c.ok ? 0 : 4) +
    (c.agentName ? 2 : 0) +
    (c.model ? 1 : 0) +
    (c.conversationId ? 1 : 0) +
    (c.durationMs > 0 ? 1 : 0)
  );
}

function accumulate(v, c) {  v.calls += 1;
  v.inputTokens += c.inputTokens;
  v.outputTokens += c.outputTokens;
  v.cachedTokens += c.cachedTokens;
  if (c.durationMs > 0) {
    v.durationMs += c.durationMs;
    v.timed += 1;
  }
  if (!c.ok) v.failures += 1;
  if (c.conversationId) v.conversations.add(c.conversationId);
  if (c.model) v.models.add(c.model);
  if (c.operation) v.operations.add(c.operation);
}

/**
 * Folds raw calls into the axes the board needs, and computes the coverage figures that
 * tell a FinOps reader how much of the bill this telemetry can actually explain.
 */
export function summarizeTelemetry(raw, { meteredCalls = 0 } = {}) {
  const { calls, scanned, componentCount, workspaceCount } = raw;

  const byAgent = new Map();
  const byApp = new Map();
  const byOperation = new Map();
  const byModel = new Map();
  const byDay = new Map();

  const identities = new Set();
  const addresses = new Set();
  const conversations = new Set();
  let masked = 0;
  let withUsage = 0;

  for (const c of calls) {
    if (c.agentName) accumulate(bump(byAgent, c.agentName, blank), c);
    accumulate(bump(byApp, c.app, blank), c);
    if (c.operation) accumulate(bump(byOperation, c.operation, blank), c);
    if (c.model) accumulate(bump(byModel, c.model, blank), c);
    accumulate(bump(byDay, String(c.at).slice(0, 10), blank), c);

    if (c.user) identities.add(c.user);
    if (c.ip) addresses.add(c.ip);
    if (c.maskedIp) masked += 1;
    if (c.conversationId) conversations.add(c.conversationId);
    if (c.inputTokens > 0 || c.outputTokens > 0) withUsage += 1;
  }

  const rank = (map, label) =>
    [...map.entries()]
      .map(([name, v]) => seal(v, { [label]: name }))
      .sort((a, b) => b.calls - a.calls);

  const withData = scanned.filter((s) => s.rows > 0);
  const withGenai = scanned.filter((s) => s.calls > 0);

  return {
    // The tape leads with the calls that actually prove something. A span naming its
    // agent, model and token split is evidence; a bare span is only a timestamp, and
    // burying the former under 2,000 of the latter is how a real finding gets missed.
    calls: calls
      .sort((a, b) => evidence(b) - evidence(a) || String(b.at).localeCompare(String(a.at)))
      .slice(0, 500),
    callCount: calls.length,
    agents: rank(byAgent, 'agent'),
    apps: rank(byApp, 'app'),
    operations: rank(byOperation, 'operation'),
    models: rank(byModel, 'model'),
    timeline: [...byDay.entries()]
      .map(([date, v]) => seal(v, { date }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    conversations: conversations.size,
    coverage: {
      components: componentCount,
      workspaces: workspaceCount,
      workspacesWithData: withData.length,
      workspacesWithGenai: withGenai.length,
      instrumentedCalls: calls.length,
      callsWithUsage: withUsage,
      meteredCalls,
      // The share of billed traffic that per-call telemetry can actually explain.
      usageShare: meteredCalls > 0 ? withUsage / meteredCalls : 0,
      identities: identities.size,
      addresses: addresses.size,
      maskedAddresses: masked,
      scanned: scanned.sort((a, b) => b.calls - a.calls || b.rows - a.rows),
    },
  };
}
