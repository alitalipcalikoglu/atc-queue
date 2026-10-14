import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, ConfigError } from '../src/config.js';
import { testEnv } from './helpers.js';

test('Config: defaults, roles, queue scopes', () => {
  const c = Config.fromEnv(testEnv({ PORT: '' }));
  assert.equal(c.port, 3016);
  assert.deepEqual(c.apiKeys.map((k) => [k.id, k.role, k.queues]), [['console', 'admin', null], ['app', 'readwrite', null], ['dash', 'read', null], ['mailer', 'write', ['emails']]]);
  assert.deepEqual([c.limits.maxMessageBytes, c.limits.maxBatch, c.limits.maxWaitSec, c.limits.deadRetentionDays], [262144, 100, 20, 14]);
  assert.ok(c.bodyLimit >= c.limits.maxMessageBytes * 2);
});

test('Config: rejects bad input', () => {
  const bad = (/** @type {Record<string,string>} */ o, /** @type {RegExp} */ re) => assert.throws(() => Config.fromEnv(testEnv(o)), (e) => e instanceof ConfigError && re.test(e.message));
  bad({ QUEUE_API_KEYS: '' }, /QUEUE_API_KEYS is required/);
  bad({ QUEUE_API_KEYS: `a:${'a'.repeat(40)}:owner` }, /read, write, readwrite or admin/);
  bad({ QUEUE_API_KEYS: `a:${'a'.repeat(40)}:write:Bad Queue` }, /invalid queue/);
  bad({ MAX_WAIT_SEC: '60' }, /MAX_WAIT_SEC/);
  bad({ TLS_KEY_PATH: '/k.pem' }, /must be set together/);
});
