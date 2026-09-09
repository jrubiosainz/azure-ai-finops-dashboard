import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createApp } from '../server/index.mjs';
import { readConfig } from '../server/config.mjs';
import { createDemoData } from '../server/demo.mjs';

async function serve(t, demo, services = {}) {
  const config = readConfig(demo ? {} : { AZURE_SUBSCRIPTION_ID: '11111111-1111-4111-8111-111111111111' }, demo ? ['--demo'] : []);
  const app = await createApp(config, services);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${server.address().port}`;
}

test('demo API serves fictional data without any Azure or cache calls', async (t) => {
  const forbidden = () => { throw new Error('Demo must never access Azure or private caches'); };
  const url = await serve(t, true, { runSync: forbidden, getSubscription: forbidden, readCache: forbidden });
  const health = await (await fetch(`${url}/api/health`)).json();
  assert.equal(health.mode, 'demo');
  assert.equal(health.authenticated, false);
  const response = await fetch(`${url}/api/finops`);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.mode, 'demo');
  assert.match(data.subscription.name, /ficticios/);
  assert.equal(data.deployments.length, 6);
  const refresh = await (await fetch(`${url}/api/refresh`, { method: 'POST' })).json();
  assert.equal(refresh.ok, true);
  assert.equal(refresh.mode, 'demo');
});

test('Azure failures are visible HTTP errors, not empty success-shaped invoices', async (t) => {
  const denied = () => { throw new Error('Azure access denied'); };
  const url = await serve(t, false, { runSync: denied, getSubscription: denied, readCache: async () => null });
  for (const route of ['health', 'finops']) {
    const response = await fetch(`${url}/api/${route}`);
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /access denied/);
  }
  const progress = await (await fetch(`${url}/api/progress`)).json();
  assert.equal(progress.phase, 'failed');
  assert.equal(progress.syncing, false);
});

test('only the configured subscription cache is served, and refresh failures preserve it', async (t) => {
  const fixture = createDemoData();
  const keys = [];
  const url = await serve(t, false, {
    readCache: async (key) => { keys.push(key); return { cachedAt: fixture.generatedAt, data: fixture }; },
    runSync: async () => { throw new Error('Cost query unavailable'); },
  });
  assert.equal((await fetch(`${url}/api/finops?subscription=another-subscription`)).status, 200);
  assert.match(keys[0], /^finops-v2-11111111-1111-4111-8111-111111111111-/);
  assert.equal((await fetch(`${url}/api/refresh`, { method: 'POST' })).status, 502);
  assert.equal((await fetch(`${url}/api/finops`)).status, 200);
});

test('foreign origins, rebinding hosts and unsupported refresh parameters are rejected', async (t) => {
  const url = await serve(t, true);
  assert.equal((await fetch(`${url}/api/finops`, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = request(`${url}/api/finops`, { headers: { Host: 'example.invalid' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
  assert.equal((await fetch(`${url}/api/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: 'unexpected' }),
  })).status, 400);
});
