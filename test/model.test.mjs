import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoData } from '../server/demo.mjs';
import { buildFinopsModel } from '../server/finops.mjs';
import { attributeUseCases } from '../server/usecases.mjs';
import { buildView } from '../web/src/scope.js';
import { count, money, rate, tokens } from '../web/src/format.js';

const now = new Date('2026-06-30T12:00:00Z');
const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.000001, `${a} != ${b}`);

test('demo is deterministic, labelled synthetic, and reconciles its aggregates', () => {
  const d = createDemoData({ now });
  assert.deepEqual(d, createDemoData({ now }));
  assert.equal(d.mode, 'demo');
  assert.match(d.subscription.name, /ficticios/);
  assert.equal(d.timeline.length, 30);
  close(d.totals.cost, sum(d.resources, 'cost'));
  close(d.totals.cost, sum(d.groups, 'cost'));
  close(d.totals.cost, sum(d.meters, 'cost'));
  close(d.totals.cost, sum(d.timeline, 'cost'));
  close(d.totals.tokenCost, sum(d.deployments, 'cost'));
  close(d.totals.calls, sum(d.timeline, 'calls'));
  for (const c of d.useCases.rows) {
    close(c.cost, sum(c.deploymentRows, 'cost'));
    close(c.cost, sum(c.agentRows, 'cost'));
    assert.equal(c.calls, sum(c.agentRows, 'calls'));
    assert.equal(c.tokens, sum(c.agentRows, 'tokens'));
  }
});

test('unassigned group costs remain visible and identical meters do not merge across accounts', () => {
  const d = buildFinopsModel({ costRows: [
    { ResourceId: '/providers/example/subscription-charge', ResourceGroupName: '', Cost: 5, Meter: 'Shared meter' },
    { ResourceId: '/resourceGroups/demo/providers/example/resource-a', ResourceGroupName: 'demo', Cost: 7, Meter: 'Shared meter' },
  ] });
  assert.equal(d.groups.find((g) => g.name === 'unassigned').cost, 5);
  assert.equal(d.meters.length, 2);
  assert.equal(new Set(d.meters.map((m) => m.id)).size, 2);
  close(d.totals.cost, sum(d.groups, 'cost'));
});

test('deployment attribution uses consistent token denominators, not a conflicting TotalTokens metric', () => {
  const account = { id: '/accounts/demo', name: 'demo', resourceGroup: 'demo' };
  const d = buildFinopsModel({
    accounts: [account],
    deployments: [{ id: '/accounts/demo/deployments/chat', name: 'chat', model: 'gpt-4.1', accountId: account.id, accountName: account.name }],
    costRows: [{ ResourceId: account.id, Meter: 'gpt 4.1 Inp glbl Tokens', Cost: 8 }],
    metrics: [{ accountId: account.id, series: [
      { deployment: 'chat', field: 'inputTokens', points: [{ t: now.toISOString(), v: 100 }] },
      { deployment: 'chat', field: 'outputTokens', points: [{ t: now.toISOString(), v: 100 }] },
      { deployment: 'chat', field: 'totalTokens', points: [{ t: now.toISOString(), v: 900 }] },
    ] }],
  });
  assert.equal(d.deployments[0].cost, 8);
  assert.equal(d.deployments[0].confidence, 'derived');
});

test('resource and deployment cuts keep costs and records scoped by account', () => {
  const d = createDemoData({ now });
  const account = d.accounts.find((a) => a.name === 'ai-support-demo');
  const view = buildView(d, 'estate', { resource: account.id });
  assert.ok(view.deployments.every((dep) => dep.accountId === account.id));
  assert.ok(view.allMeters.every((m) => m.resourceId === account.id));
  close(view.spend, account.cost);
  const dep = view.deployments[0];
  const cut = buildView(d, 'estate', { deployment: dep.id });
  assert.equal(cut.deployments.length, 1);
  close(cut.spend, dep.cost);
  assert.ok(cut.agents.every((a) => a.deploymentName === dep.name));
});

test('project and agent cuts show related deployments rather than the whole account', () => {
  const d = createDemoData({ now });
  const a = d.agents.find((agent) => agent.name === 'support-retrieval');
  const view = buildView(d, 'foundry', { account: a.accountId, project: a.projectId, agent: a.id });
  assert.deepEqual(view.agents.map((ag) => ag.id), [a.id]);
  assert.deepEqual(view.deployments.map((dep) => dep.name), [a.deploymentName]);
  close(view.spend, view.deployments[0].cost);
});

test('meter selections do not fabricate per-meter requests or rates', () => {
  const d = createDemoData({ now });
  const meter = d.meters.find((m) => m.model);
  const view = buildView(d, 'estate', { meter: meter.id });
  close(view.spend, meter.cost);
  assert.equal(view.meters.length, 1);
  assert.equal(view.calls, null);
  assert.equal(view.costPerCall, null);
  assert.equal(view.costPer1k, null);
  assert.equal(view.deployments.length, 0);
  for (const format of [count, money, rate, tokens]) assert.equal(format(null), '—');
});

test('telemetry does not silently change subscription-level cost quotations', () => {
  const d = createDemoData({ now });
  assert.deepEqual(buildView(d, 'telemetry', { app: 'synthetic-app' }), buildView(d, 'estate', {}));
});

test('business cuts do not quote a whole account or cross-match another account by deployment name', () => {
  const d = createDemoData({ now });
  const c = d.useCases.rows[0];
  const view = buildView(d, 'usecase', { usecase: c.id });
  close(view.spend, c.cost);
  assert.ok(view.agents.every((a) => a.accountName === c.account));
  assert.ok(view.allMeters.every((m) => m.account === c.account));
  const missing = attributeUseCases({
    useCases: [{ ...c, account: 'different-account', agents: [], operations: [] }],
    gateways: [], deployments: d.deployments,
  });
  assert.equal(missing.totals.cost, 0);
});

test('duplicate business membership is rejected instead of double billing', () => {
  const d = createDemoData({ now });
  const c = d.useCases.rows[0];
  assert.throws(() => attributeUseCases({
    useCases: [c, { ...c, id: 'another-case' }], gateways: [], deployments: d.deployments,
  }), /repetido/);
});
