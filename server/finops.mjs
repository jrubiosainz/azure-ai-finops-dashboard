/**
 * FinOps attribution engine.
 *
 * Azure exposes the pieces of the AI cost story in three separate places and none of
 * them join up on their own:
 *
 *   - Cost Management knows money, broken down by meter, but has no concept of a model
 *     deployment, a Foundry project or an agent.
 *   - Azure Monitor knows tokens and request counts per model deployment, but knows
 *     nothing about money.
 *   - The Foundry data plane knows agents and which deployment each one targets, but
 *     knows nothing about either money or aggregate usage.
 *
 * This module joins all three and derives an effective blended rate per model and
 * direction from real billed cost divided by real metered tokens. That matters for
 * FinOps: a rate taken from the public price list is a guess, whereas cost/tokens is
 * what the organisation actually paid.
 *
 * Every figure produced here carries a `confidence` marker so the dashboard can be
 * honest about provenance:
 *   billed   — came straight from Cost Management
 *   metered  — came straight from Azure Monitor
 *   derived  — billed divided by metered (an effective rate)
 *   modelled — an allocation we inferred because Azure exposes no direct attribution
 */

/* ------------------------------------------------------------------ *
 * Meter parsing
 * ------------------------------------------------------------------ */

/*
 * Azure bills AI usage through heavily abbreviated meter names. Real examples from a
 * live subscription:
 *
 *   "5.6 sol ShortCo Cd Wr Std Gl 1M Tokens"   -> gpt-5.6-sol, cache write
 *   "5.6 luna ShortCo Cd Inp Std DZ 1M Tokens" -> gpt-5.6-luna, cached input, data zone
 *   "gpt 4.1 Outp glbl Tokens"                 -> gpt-4.1, output, global
 *   "GPT 5.1 cd inp Gl 1M Tokens"              -> gpt-5.1, cached input
 *   "Image 2 img opt Gl 1M Tokens"             -> gpt-image-2, output, image modality
 *   "text-embedding-3-small-glbl Tokens"       -> text-embedding-3-small
 *   "Hosted vCPU Usage"                        -> Agent Service hosted compute
 *
 * The abbreviations are positional rather than delimited, so the parser strips known
 * qualifier tokens from the tail and treats whatever survives as the model name.
 */

// Deployment-shape and context qualifiers that sit between the model and the direction.
const QUALIFIERS = [
  'global', 'globl', 'glbl', 'gl', 'regional', 'reg', 'data zone', 'datazone', 'dz',
  'shortco', 'longco', 'short context', 'long context', 'batch', 'btch', 'provisioned',
  'managed', 'standard', 'std', 'spillover', 'zone', 'srvrls', 'serverless',
];

// Order matters: cache variants must be tested before the plain input/output words.
const DIRECTION_PATTERNS = [
  { dir: 'cacheWrite', re: /\b(cd|cache|cached)\s+wr(ite)?\b|\bcache\s*write\b/i },
  { dir: 'cachedInput', re: /\b(cd|cach(ed)?)\s+(inp(ut)?|prompt)\b|\bcached\s*prompt\b/i },
  { dir: 'output', re: /\b(output|outp|opt|completion|completions|generated|gen)\b/i },
  { dir: 'input', re: /\b(input|inp|prompt|prompts)\b/i },
];

// Words that never form part of a model identifier. `text`/`image` are deliberately
// absent: they are real parts of model names ("text-embedding-3-small", "Image 2").
const NOISE = new RegExp(
  String.raw`\b(tokens?|units?|hours?|requests?|characters?|seconds?|usage|1m|per|and` +
    String.raw`|cd|wr|cach(ed)?|write|input|inp|output|outp|opt|prompt|prompts` +
    String.raw`|completion|completions|generated|gen|txt|img)\b`,
  'gi',
);

/** Turns a billing-meter model fragment into a canonical model identifier. */
function canonicalModelName(fragment, fullName) {
  let m = String(fragment).trim().toLowerCase().replace(/\s{2,}/g, ' ');
  if (!m) return null;

  // "Image 2" and friends are GPT image models; the "gpt" prefix is dropped in billing.
  if (/^image\s*[\d.]+/.test(m)) m = `gpt-image-${m.replace(/^image\s*/, '')}`;
  // Bare version numbers such as "5.6 sol" or "5.4 mini" are GPT models.
  else if (/^\d+(\.\d+)?(\s|$)/.test(m)) m = `gpt-${m}`;
  else if (/^gpt\s/.test(m)) m = m.replace(/^gpt\s+/, 'gpt-');

  m = m.replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  if (!m || m.length < 2) return String(fullName).trim().toLowerCase() || null;
  return m;
}

/**
 * Splits a billing meter name into the model it refers to, the token direction it
 * represents, the workload kind and the deployment shape it was billed under.
 */
export function parseMeter(meterName = '', meterSubCategory = '') {
  const name = String(meterName).trim();
  if (!name) return { model: null, direction: 'other', kind: 'other', shape: null, isToken: false };

  let direction = 'other';
  for (const { dir, re } of DIRECTION_PATTERNS) {
    if (re.test(name)) {
      direction = dir;
      break;
    }
  }

  // "img opt" / "txt inp" describe the modality that was billed, not the model.
  const modality = /\bimg\b/i.test(name) ? 'image' : /\btxt\b/i.test(name) ? 'text' : null;

  let shape = null;
  if (/\bdz\b|data\s*zone/i.test(name)) shape = 'DataZone';
  else if (/\bgl\b|glbl|global/i.test(name)) shape = 'Global';
  else if (/\breg\b|regional/i.test(name)) shape = 'Regional';
  if (/\bbatch\b|\bbtch\b/i.test(name)) shape = shape ? `${shape} Batch` : 'Batch';

  const isToken = /\btokens?\b/i.test(name);

  let kind;
  if (/compute unit|provisioned managed|\bptu\b/i.test(name)) kind = 'provisioned';
  else if (/hosted (vcpu|memory|storage)|container|vcpu|memory usage/i.test(name)) kind = 'compute';
  else if (/fine[\s-]?tun/i.test(name)) kind = 'finetuning';
  else if (/embedding/i.test(name)) kind = 'embeddings';
  else if (/\bimage\b|\bimg\b|dall[\s-]?e/i.test(name)) kind = 'images';
  else if (/audio|speech|whisper|realtime|transcri/i.test(name)) kind = 'audio';
  else if (isToken) kind = 'tokens';
  else kind = 'other';

  // Hosted compute and similar infrastructure meters carry no model at all.
  if (kind === 'compute' || (!isToken && kind === 'other')) {
    return { model: null, direction: 'other', kind, shape, modality, isToken: false };
  }

  let fragment = name.replace(NOISE, ' ');
  for (const q of QUALIFIERS) {
    fragment = fragment.replace(new RegExp(`\\b${q.replace(/ /g, '\\s+')}\\b`, 'gi'), ' ');
  }
  // Embedding meters glue the qualifier on with a hyphen: "…-3-small-glbl".
  fragment = fragment.replace(/-(glbl|gl|dz|reg|std)\b/gi, '').replace(/\s{2,}/g, ' ').trim();

  let model = canonicalModelName(fragment, meterSubCategory || name);
  if (!model) model = String(meterSubCategory || '').trim().toLowerCase() || null;

  return { model, direction, kind, shape, modality, isToken };
}

/** Normalises model identifiers so metric, deployment and meter spellings line up. */
export function normalizeModel(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/^azure-/, '')
    // Strip dated version suffixes ("-2024-08-06") and explicit "-v2" markers only.
    // A bare trailing number is part of the name itself: gpt-image-2, gpt-4.1.
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-v\d+$/, '')
    .replace(/[^a-z0-9.-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

/* ------------------------------------------------------------------ *
 * Aggregation helpers
 * ------------------------------------------------------------------ */

function addTo(map, key, patch) {
  if (!key) return null;
  const cur = map.get(key) ?? {};
  for (const [k, v] of Object.entries(patch)) {
    cur[k] = typeof v === 'number' ? (cur[k] ?? 0) + v : v ?? cur[k];
  }
  map.set(key, cur);
  return cur;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/* ------------------------------------------------------------------ *
 * Core build
 * ------------------------------------------------------------------ */

/**
 * Joins cost rows, metric series and Foundry inventory into a single analysable model.
 *
 * @param {object} input
 * @param {Array}  input.costRows      Flattened Cost Management rows.
 * @param {Array}  input.costDaily     Daily-granularity cost rows for the trend chart.
 * @param {Array}  input.accounts      Cognitive Services accounts.
 * @param {Array}  input.deployments   Model deployments across all accounts.
 * @param {Array}  input.projects      Foundry projects.
 * @param {Array}  input.agents        Foundry agents.
 * @param {Array}  input.metrics       Per-account Azure Monitor results.
 * @param {Array}  input.resourceGroups
 */
export function buildFinopsModel({
  costRows = [],
  costDaily = [],
  accounts = [],
  deployments = [],
  projects = [],
  agents = [],
  metrics = [],
  resourceGroups = [],
  currency = 'EUR',
}) {
  const accountById = new Map(accounts.map((a) => [a.id.toLowerCase(), a]));
  const accountByName = new Map(accounts.map((a) => [a.name.toLowerCase(), a]));

  /* ---------- 1. Cost aggregation ---------- */

  const byResourceGroup = new Map();
  const byResource = new Map();
  const byService = new Map();
  const byMeter = new Map();
  // account id -> normalized model -> { input, output, other } cost
  const costByAccountModel = new Map();

  let totalCost = 0;
  let totalCostUSD = 0;
  let aiCost = 0;

  const AI_SERVICES = /openai|cognitive|machine learning|ai services|foundry|azure ai/i;

  for (const row of costRows) {
    const cost = num(row.totalCost ?? row.Cost ?? row.PreTaxCost);
    const costUSD = num(row.totalCostUSD ?? row.CostUSD);
    const rg = String(row.ResourceGroupName ?? row.ResourceGroup ?? '').trim() || 'unassigned';
    const resourceId = row.ResourceId ?? null;
    const service = row.ServiceName ?? row.MeterCategory ?? 'Other';
    const meterName = row.MeterName ?? row.Meter ?? '';
    const meterSub = row.MeterSubCategory ?? '';

    totalCost += cost;
    totalCostUSD += costUSD;

    const isAi =
      AI_SERVICES.test(service) ||
      AI_SERVICES.test(meterName) ||
      /\/providers\/microsoft\.search\/searchservices\//i.test(resourceId ?? '') ||
      (resourceId ? accountById.has(resourceId.toLowerCase()) : false);
    if (isAi) aiCost += cost;

    addTo(byResourceGroup, rg.toLowerCase(), { name: rg, cost, costUSD, aiCost: isAi ? cost : 0 });
    addTo(byService, service, { name: service, cost, costUSD, isAi });

    if (resourceId) {
      const acct = accountById.get(resourceId.toLowerCase());
      addTo(byResource, resourceId.toLowerCase(), {
        id: resourceId,
        name: resourceId.split('/').pop(),
        type: (resourceId.split('/providers/')[1] ?? '').split('/').slice(0, 2).join('/'),
        resourceGroup: rg,
        cost,
        costUSD,
        isAi,
        isFoundry: Boolean(acct),
        kind: acct?.kind ?? null,
        location: acct?.location ?? null,
      });
    }

    if (meterName) {
      const parsed = parseMeter(meterName, meterSub);
      const meterId = `${String(resourceId ?? '').toLowerCase()}::${meterName}`;
      addTo(byMeter, meterId, {
        id: meterId,
        resourceId,
        isAi,
        name: meterName,
        service,
        cost,
        costUSD,
        model: parsed.model,
        direction: parsed.direction,
        kind: parsed.kind,
        shape: parsed.shape,
        resourceGroup: rg,
        account: resourceId ? resourceId.split('/').pop() : null,
      });

      // Track cost per account+model so an effective rate can be derived later.
      if (resourceId && parsed.model) {
        const acctKey = resourceId.toLowerCase();
        if (!costByAccountModel.has(acctKey)) costByAccountModel.set(acctKey, new Map());
        const inner = costByAccountModel.get(acctKey);
        const modelKey = normalizeModel(parsed.model);
        const cur = inner.get(modelKey) ?? {
          input: 0, output: 0, cachedInput: 0, cacheWrite: 0, other: 0, total: 0,
        };
        const bucket = cur[parsed.direction] === undefined ? 'other' : parsed.direction;
        cur[bucket] += cost;
        cur.total += cost;
        inner.set(modelKey, cur);
      }
    }
  }

  /* ---------- 2. Metric aggregation ---------- */

  // The Azure client resolves each metric to a canonical field because metric names
  // differ between modern AIServices accounts and legacy OpenAI accounts.
  const METRIC_TO_FIELD = {
    InputTokens: 'inputTokens',
    ProcessedPromptTokens: 'inputTokens',
    OutputTokens: 'outputTokens',
    GeneratedTokens: 'outputTokens',
    TotalTokens: 'totalTokens',
    TokenTransaction: 'totalTokens',
    ModelRequests: 'calls',
    AzureOpenAIRequests: 'calls',
  };

  // account id -> deployment name -> usage
  const usageByAccountDeployment = new Map();
  const dailyUsage = new Map();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCalls = 0;

  for (const acctMetrics of metrics) {
    const acctKey = String(acctMetrics.accountId ?? '').toLowerCase();
    if (!usageByAccountDeployment.has(acctKey)) usageByAccountDeployment.set(acctKey, new Map());
    const inner = usageByAccountDeployment.get(acctKey);

    for (const series of acctMetrics.series ?? []) {
      const field = series.field ?? METRIC_TO_FIELD[series.metric];
      if (!field) continue;
      const sum = series.points.reduce((s, p) => s + num(p.v), 0);

      const cur = inner.get(series.deployment) ?? {
        deployment: series.deployment,
        inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0,
      };
      cur[field] += sum;
      inner.set(series.deployment, cur);

      if (field === 'inputTokens') totalInputTokens += sum;
      if (field === 'outputTokens') totalOutputTokens += sum;
      if (field === 'calls') totalCalls += sum;

      for (const p of series.points) {
        const day = String(p.t).slice(0, 10);
        addTo(dailyUsage, day, { date: day, [field]: num(p.v) });
      }
    }
  }

  /* ---------- 3. Deployment enrichment + effective rates ---------- */

  const deploymentIndex = new Map();
  for (const d of deployments) {
    deploymentIndex.set(`${d.accountId.toLowerCase()}::${d.name}`, d);
  }

  // Tokens per account+model, so cost for that model can be spread over its deployments.
  const tokensByAccountModel = new Map();
  for (const [acctKey, deps] of usageByAccountDeployment) {
    for (const [depName, usage] of deps) {
      const dep = deploymentIndex.get(`${acctKey}::${depName}`);
      const modelKey = normalizeModel(dep?.model ?? depName);
      if (!tokensByAccountModel.has(acctKey)) tokensByAccountModel.set(acctKey, new Map());
      const inner = tokensByAccountModel.get(acctKey);
      const cur = inner.get(modelKey) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
      cur.inputTokens += usage.inputTokens;
      cur.outputTokens += usage.outputTokens;
      // Input+output is the figure that reconciles with billing meters; the standalone
      // TotalTokens metric counts some modalities differently.
      cur.totalTokens += usage.inputTokens + usage.outputTokens || usage.totalTokens;
      cur.calls += usage.calls;
      inner.set(modelKey, cur);
    }
  }

  /**
   * Effective rate per 1k tokens, derived from what was actually billed.
   * Falls back to splitting undirected cost by token share when the meter did not
   * distinguish input from output.
   */
  function ratesFor(acctKey, modelKey) {
    const cost = costByAccountModel.get(acctKey)?.get(modelKey);
    const tok = tokensByAccountModel.get(acctKey)?.get(modelKey);
    if (!cost || !tok) return null;

    let inputCost = cost.input + cost.cachedInput + cost.cacheWrite;
    let outputCost = cost.output;

    if (cost.other > 0) {
      const totalTok = tok.inputTokens + tok.outputTokens;
      if (totalTok > 0) {
        inputCost += (cost.other * tok.inputTokens) / totalTok;
        outputCost += (cost.other * tok.outputTokens) / totalTok;
      } else {
        inputCost += cost.other;
      }
    }

    return {
      inputPer1k: tok.inputTokens > 0 ? (inputCost / tok.inputTokens) * 1000 : null,
      outputPer1k: tok.outputTokens > 0 ? (outputCost / tok.outputTokens) * 1000 : null,
      inputCost,
      outputCost,
      totalCost: cost.total,
      inputTokens: tok.inputTokens,
      outputTokens: tok.outputTokens,
      calls: tok.calls,
      costPerCall: tok.calls > 0 ? cost.total / tok.calls : null,
    };
  }

  const enrichedDeployments = deployments.map((d) => {
    const acctKey = d.accountId.toLowerCase();
    const usage = usageByAccountDeployment.get(acctKey)?.get(d.name) ?? {
      inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0,
    };
    const modelKey = normalizeModel(d.model ?? d.name);
    const rate = ratesFor(acctKey, modelKey);

    // Split the model's billed cost across its deployments by token share.
    const modelTokens = tokensByAccountModel.get(acctKey)?.get(modelKey);
    const share =
      modelTokens && modelTokens.totalTokens > 0
        ? (usage.inputTokens + usage.outputTokens || usage.totalTokens) /
          (modelTokens.totalTokens || modelTokens.inputTokens + modelTokens.outputTokens || 1)
        : modelTokens
          ? 0
          : 0;

    const modelCost = costByAccountModel.get(acctKey)?.get(modelKey)?.total ?? 0;
    const cost = modelCost * (share || 0);

    return {
      ...d,
      modelKey,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens || usage.totalTokens,
      calls: usage.calls,
      cost,
      costPerCall: usage.calls > 0 ? cost / usage.calls : null,
      inputRatePer1k: rate?.inputPer1k ?? null,
      outputRatePer1k: rate?.outputPer1k ?? null,
      confidence: modelCost > 0 && (usage.inputTokens + usage.outputTokens || usage.totalTokens) > 0
        ? 'derived' : usage.calls > 0 ? 'metered' : 'none',
    };
  });

  /* ---------- 4. Model roll-up ---------- */

  const byModel = new Map();
  for (const d of enrichedDeployments) {
    const key = d.modelKey || 'unknown';
    const cur = byModel.get(key) ?? {
      model: d.model ?? d.name,
      modelKey: key,
      deployments: 0, accounts: new Set(), resourceGroups: new Set(),
      inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, cost: 0,
      skus: new Set(),
    };
    cur.deployments += 1;
    cur.accounts.add(d.accountName);
    cur.resourceGroups.add(d.resourceGroup);
    if (d.skuName) cur.skus.add(d.skuName);
    cur.inputTokens += d.inputTokens;
    cur.outputTokens += d.outputTokens;
    cur.totalTokens += d.totalTokens;
    cur.calls += d.calls;
    cur.cost += d.cost;
    byModel.set(key, cur);
  }

  // Fold in billed models that have no matching deployment, so nothing is lost.
  for (const [acctKey, models] of costByAccountModel) {
    for (const [modelKey, cost] of models) {
      if (byModel.has(modelKey)) continue;
      const acct = accountById.get(acctKey);
      byModel.set(modelKey, {
        model: modelKey,
        modelKey,
        deployments: 0,
        accounts: new Set(acct ? [acct.name] : []),
        resourceGroups: new Set(acct ? [acct.resourceGroup] : []),
        skus: new Set(),
        inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0,
        cost: cost.total,
        billedOnly: true,
      });
    }
  }

  const models = [...byModel.values()]
    .map((m) => ({
      ...m,
      accounts: [...m.accounts],
      resourceGroups: [...m.resourceGroups],
      skus: [...m.skus],
      costPerCall: m.calls > 0 ? m.cost / m.calls : null,
      inputRatePer1k: m.inputTokens > 0 ? (m.cost * inputShare(m) / m.inputTokens) * 1000 : null,
      outputRatePer1k: m.outputTokens > 0 ? (m.cost * (1 - inputShare(m)) / m.outputTokens) * 1000 : null,
    }))
    .sort((a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens);

  /* ---------- 5. Project + agent attribution ---------- */

  const projectsByAccount = new Map();
  for (const p of projects) {
    const k = p.accountId.toLowerCase();
    if (!projectsByAccount.has(k)) projectsByAccount.set(k, []);
    projectsByAccount.get(k).push(p);
  }

  // Agents target a deployment by name; group them so a shared deployment's cost can
  // be split across the agents that actually use it.
  const agentsByDeployment = new Map();
  for (const a of agents) {
    const key = `${a.accountId.toLowerCase()}::${a.model ?? 'unknown'}`;
    if (!agentsByDeployment.has(key)) agentsByDeployment.set(key, []);
    agentsByDeployment.get(key).push(a);
  }

  const enrichedAgents = agents.map((a) => {
    const acctKey = a.accountId.toLowerCase();
    const dep = enrichedDeployments.find(
      (d) => d.accountId.toLowerCase() === acctKey && d.name === a.model,
    );
    const peers = agentsByDeployment.get(`${acctKey}::${a.model ?? 'unknown'}`) ?? [a];
    const shareOfDeployment = peers.length > 0 ? 1 / peers.length : 1;

    return {
      ...a,
      deploymentName: dep?.name ?? a.model ?? null,
      modelName: dep?.model ?? a.model ?? null,
      skuName: dep?.skuName ?? null,
      sharesDeploymentWith: peers.length - 1,
      // Azure exposes no per-agent usage dimension, so this is an explicit allocation.
      estimatedCalls: dep ? dep.calls * shareOfDeployment : 0,
      estimatedInputTokens: dep ? dep.inputTokens * shareOfDeployment : 0,
      estimatedOutputTokens: dep ? dep.outputTokens * shareOfDeployment : 0,
      estimatedCost: dep ? dep.cost * shareOfDeployment : 0,
      estimatedCostPerCall: dep?.costPerCall ?? null,
      deploymentCalls: dep?.calls ?? 0,
      deploymentCost: dep?.cost ?? 0,
      confidence: dep ? 'modelled' : 'none',
    };
  });

  const enrichedProjects = projects.map((p) => {
    const projAgents = enrichedAgents.filter((a) => a.projectId === p.id);
    const acct = accountById.get(p.accountId.toLowerCase());
    const acctDeployments = enrichedDeployments.filter(
      (d) => d.accountId.toLowerCase() === p.accountId.toLowerCase(),
    );
    const siblingProjects = projectsByAccount.get(p.accountId.toLowerCase()) ?? [p];

    // Cost lives on the account, so a project's share is proportional to how many of
    // the account's agents belong to it.
    const accountAgents = enrichedAgents.filter(
      (a) => a.accountId.toLowerCase() === p.accountId.toLowerCase(),
    );
    const share =
      accountAgents.length > 0
        ? projAgents.length / accountAgents.length
        : 1 / Math.max(siblingProjects.length, 1);

    const accountCost = acctDeployments.reduce((s, d) => s + d.cost, 0);
    const accountCalls = acctDeployments.reduce((s, d) => s + d.calls, 0);
    const accountInput = acctDeployments.reduce((s, d) => s + d.inputTokens, 0);
    const accountOutput = acctDeployments.reduce((s, d) => s + d.outputTokens, 0);

    return {
      ...p,
      location: acct?.location ?? null,
      agentCount: projAgents.length,
      estimatedCost: accountCost * share,
      estimatedCalls: accountCalls * share,
      estimatedInputTokens: accountInput * share,
      estimatedOutputTokens: accountOutput * share,
      confidence: accountAgents.length > 0 ? 'modelled' : 'none',
    };
  });

  /* ---------- 6. Account roll-up ---------- */

  const enrichedAccounts = accounts.map((a) => {
    const key = a.id.toLowerCase();
    const deps = enrichedDeployments.filter((d) => d.accountId.toLowerCase() === key);
    const billed = byResource.get(key);
    return {
      ...a,
      deploymentCount: deps.length,
      projectCount: (projectsByAccount.get(key) ?? []).length,
      agentCount: enrichedAgents.filter((ag) => ag.accountId.toLowerCase() === key).length,
      cost: billed?.cost ?? deps.reduce((s, d) => s + d.cost, 0),
      inputTokens: deps.reduce((s, d) => s + d.inputTokens, 0),
      outputTokens: deps.reduce((s, d) => s + d.outputTokens, 0),
      calls: deps.reduce((s, d) => s + d.calls, 0),
    };
  }).sort((a, b) => b.cost - a.cost);

  /* ---------- 7. Resource-group roll-up ---------- */

  const rgMeta = new Map(resourceGroups.map((r) => [r.name.toLowerCase(), r]));
  const groups = [...byResourceGroup.values()]
    .map((g) => {
      const meta = rgMeta.get(g.name.toLowerCase());
      const accts = enrichedAccounts.filter(
        (a) => (a.resourceGroup ?? '').toLowerCase() === g.name.toLowerCase(),
      );
      return {
        ...g,
        location: meta?.location ?? null,
        tags: meta?.tags ?? {},
        accountCount: accts.length,
        calls: accts.reduce((s, a) => s + a.calls, 0),
        inputTokens: accts.reduce((s, a) => s + a.inputTokens, 0),
        outputTokens: accts.reduce((s, a) => s + a.outputTokens, 0),
      };
    })
    .sort((a, b) => b.cost - a.cost);

  /* ---------- 8. Daily trend ---------- */

  const dailyCost = new Map();
  for (const row of costDaily) {
    const raw = row.UsageDate ?? row.Date;
    if (!raw) continue;
    const s = String(raw);
    const date = s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10);
    const service = row.ServiceName ?? 'Other';
    const isAi = AI_SERVICES.test(service);
    addTo(dailyCost, date, {
      date,
      cost: num(row.totalCost ?? row.Cost),
      aiCost: isAi ? num(row.totalCost ?? row.Cost) : 0,
    });
  }

  const timeline = [...new Set([...dailyCost.keys(), ...dailyUsage.keys()])]
    .sort()
    .map((date) => ({
      date,
      cost: dailyCost.get(date)?.cost ?? 0,
      aiCost: dailyCost.get(date)?.aiCost ?? 0,
      inputTokens: dailyUsage.get(date)?.inputTokens ?? 0,
      outputTokens: dailyUsage.get(date)?.outputTokens ?? 0,
      calls: dailyUsage.get(date)?.calls ?? 0,
    }));

  /* ---------- 9. Totals ---------- */

  const totalTokens = totalInputTokens + totalOutputTokens;
  const attributedAiCost = enrichedDeployments.reduce((s, d) => s + d.cost, 0);

  return {
    currency,
    totals: {
      cost: totalCost,
      costUSD: totalCostUSD,
      aiCost,
      attributedAiCost,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens,
      calls: totalCalls,
      costPerCall: totalCalls > 0 ? attributedAiCost / totalCalls : null,
      costPer1kTokens: totalTokens > 0 ? (attributedAiCost / totalTokens) * 1000 : null,
      inputTokenShare: totalTokens > 0 ? totalInputTokens / totalTokens : 0,
      resourceGroups: groups.length,
      accounts: enrichedAccounts.length,
      deployments: enrichedDeployments.length,
      projects: enrichedProjects.length,
      agents: enrichedAgents.length,
      models: models.length,
    },
    groups,
    resources: [...byResource.values()].sort((a, b) => b.cost - a.cost),
    services: [...byService.values()].sort((a, b) => b.cost - a.cost),
    meters: [...byMeter.values()].sort((a, b) => b.cost - a.cost),
    accounts: enrichedAccounts,
    deployments: enrichedDeployments.sort((a, b) => b.cost - a.cost || b.calls - a.calls),
    models,
    projects: enrichedProjects.sort((a, b) => b.estimatedCost - a.estimatedCost),
    agents: enrichedAgents.sort((a, b) => b.estimatedCost - a.estimatedCost),
    timeline,
  };
}

/** Share of a model's cost attributable to input tokens, used for headline rates. */
function inputShare(m) {
  const total = m.inputTokens + m.outputTokens;
  if (total === 0) return 0.5;
  // Output tokens are materially more expensive across every current model family,
  // so weight them rather than splitting the cost purely by volume.
  const weighted = m.inputTokens + m.outputTokens * 4;
  return weighted > 0 ? m.inputTokens / weighted : 0.5;
}
