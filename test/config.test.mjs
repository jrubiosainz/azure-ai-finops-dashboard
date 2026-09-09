import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../server/config.mjs';
import { defaultRange } from '../server/sync.mjs';
import { modelCacheKey } from '../server/cache.mjs';

const id = '11111111-1111-4111-8111-111111111111';

test('real mode requires an explicit subscription and rejects invalid IDs', () => {
  assert.throws(() => readConfig({}, []), /AZURE_SUBSCRIPTION_ID/);
  assert.throws(() => readConfig({ AZURE_SUBSCRIPTION_ID: '../another-subscription' }, []), /AZURE_SUBSCRIPTION_ID/);
  assert.equal(readConfig({ AZURE_SUBSCRIPTION_ID: id }, []).subscriptionId, id);
});

test('demo is explicit and requires no Azure configuration', () => {
  assert.equal(readConfig({}, ['--demo']).demo, true);
  assert.equal(readConfig({ FINOPS_DEMO: 'true' }, []).subscriptionId, null);
  assert.equal(readConfig({ FINOPS_DEMO: 'false' }, ['--demo']).demo, true);
  assert.throws(() => readConfig({ FINOPS_DEMO: 'yes' }, []), /FINOPS_DEMO/);
});

test('window and port are bounded and the server always uses loopback', () => {
  const env = { AZURE_SUBSCRIPTION_ID: id };
  for (const value of ['0', '91', '-1', '2.5', 'invalid']) {
    assert.throws(() => readConfig({ ...env, FINOPS_DAYS: value }, []), /FINOPS_DAYS/);
  }
  assert.throws(() => readConfig({ ...env, PORT: '65536' }, []), /PORT/);
  const config = readConfig({ ...env, FINOPS_DAYS: '7', PORT: '5310', HOST: '0.0.0.0' }, []);
  assert.equal(config.days, 7);
  assert.equal(config.port, 5310);
  assert.equal(config.host, '127.0.0.1');
});

test('calendar-day windows include today exactly once and isolate cache keys', () => {
  const now = new Date('2026-06-30T12:00:00Z');
  assert.deepEqual(defaultRange(1, now), { from: '2026-06-30', to: '2026-06-30' });
  assert.deepEqual(defaultRange(30, now), { from: '2026-06-01', to: '2026-06-30' });
  assert.notEqual(modelCacheKey(id, defaultRange(7, now)), modelCacheKey(id, defaultRange(30, now)));
  assert.throws(() => defaultRange(0, now), /ventana/);
});
