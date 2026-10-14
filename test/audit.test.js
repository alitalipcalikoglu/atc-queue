import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { ADMIN_KEY, RW_KEY, bearer, buildApp } from './helpers.js';

const silent = { warn() {}, error() {} };

test('API: queue management and dead-letter operations are audit events; the data plane is not', async (t) => {
  const audit = new AuditClient({ target: { url: 'http://audit.test', apiKey: 'a'.repeat(40) }, logger: silent, fetch: async () => new Response('{}', { status: 200 }) });
  const { app } = await buildApp(undefined, { audit });
  t.after(() => app.close());
  const a = { ...bearer(ADMIN_KEY), 'user-agent': 'test-agent' };
  await app.inject({ method: 'PUT', url: '/v1/queues/jobs', headers: a, payload: { maxAttempts: 1 } });
  const id = JSON.parse((await app.inject({ method: 'POST', url: '/v1/queues/jobs/messages', headers: bearer(RW_KEY), payload: { body: 1 } })).body).message.id;
  const [m] = JSON.parse((await app.inject({ method: 'POST', url: '/v1/queues/jobs/pull', headers: bearer(RW_KEY), payload: {} })).body).messages;
  await app.inject({ method: 'POST', url: `/v1/queues/jobs/messages/${id}/nack`, headers: bearer(RW_KEY), payload: { leaseToken: m.leaseToken } });
  await app.inject({ method: 'POST', url: '/v1/queues/jobs/redrive', headers: a, payload: { all: true } });
  await app.inject({ method: 'DELETE', url: `/v1/queues/jobs/messages/${id}`, headers: a });
  await app.inject({ method: 'POST', url: '/v1/queues/jobs/purge', headers: a, payload: { state: 'all' } });
  await app.inject({ method: 'DELETE', url: '/v1/queues/jobs', headers: a });
  assert.deepEqual(audit.buffer.map((e) => e.action), ['atc-queue.queue.upsert', 'atc-queue.message.redrive', 'atc-queue.message.delete', 'atc-queue.queue.purge', 'atc-queue.queue.delete']);
  const [upsert, redrive, del, purge] = audit.buffer;
  assert.deepEqual([upsert.actor, upsert.target, upsert.meta], [{ type: 'apikey', id: 'console' }, { type: 'queue', id: 'jobs' }, { created: true, settings: { maxAttempts: 1 } }]);
  assert.deepEqual([redrive.meta, del.target, del.meta, purge.meta], [{ redriven: 1 }, { type: 'message', id }, { queue: 'jobs' }, { state: 'all', removed: 0 }]);
  const n = audit.buffer.length;
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/queues/x', headers: bearer(RW_KEY), payload: {} })).statusCode, 403);
  assert.deepEqual([audit.buffer.length, audit.buffer.at(-1)?.outcome], [n + 1, 'denied']);
});
