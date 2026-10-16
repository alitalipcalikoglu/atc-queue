import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { Signer } from '@atc-web/atc-service-core/http';
import { PushGuard } from '../src/net/push-guard.js';
import { SecretBox } from '@atc-web/atc-service-core/secrets';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { Pusher } from '../src/domain/pusher.js';
import { QueueService } from '../src/domain/queue-service.js';
import { QueueApi } from '../src/http/queue-api.js';
import { QueueStore } from '../src/store/queue-store.js';
import { ADMIN_KEY, RW_KEY, bearer, testEnv } from './helpers.js';

const SECRET = 's'.repeat(40);
const KEY_HEX = 'ab'.repeat(32);

/** Receiver: records requests, answers with `status` (a number, or a function of the attempt). */
/** @type {{ seen: { headers: import('node:http').IncomingHttpHeaders, body: string }[], status: number|((n: number) => number), url: string }} */
const receiver = { seen: [], status: 200, url: '' };
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    receiver.seen.push({ headers: req.headers, body });
    const s = typeof receiver.status === 'function' ? receiver.status(receiver.seen.length) : receiver.status;
    res.writeHead(s).end();
  });
});
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
  receiver.url = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}/hook`;
});
after(() => { server.closeAllConnections(); server.close(); });

async function system(env = {}) {
  const config = Config.fromEnv(testEnv({ PUSH_SECRETS_KEY: KEY_HEX, PUSH_ALLOW_HTTP: 'true', PUSH_ALLOW_PRIVATE: 'true', PUSH_ALLOWED_HOSTS: '127.0.0.1', PUSH_TIMEOUT_MS: '2000', ...env }));
  const db = new Database(':memory:');
  const store = new QueueStore(db);
  const p = /** @type {import('../src/types.js').PushConfig} */ (config.push);
  const push = { guard: new PushGuard({ allowHttp: p.allowHttp, allowPrivate: p.allowPrivate, allowedHosts: p.allowedHosts }), box: new SecretBox(p.secretsKey) };
  const service = new QueueService({ db, store, limits: config.limits, push });
  const pusher = new Pusher({ service, guard: push.guard, box: push.box, options: { timeoutMs: p.timeoutMs, intervalMs: 50 }, log: { warn: () => {} } });
  const app = await new QueueApi({ config, service, db, version: '0.0.0', pusher }).build();
  await app.ready();
  return { app, service, store, pusher, db };
}

/** @param {() => boolean} cond */
const until = async (cond) => { for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(cond(), 'condition not reached in time'); };

test('config: push is off without PUSH_SECRETS_KEY; the key must be 32 bytes hex', () => {
  assert.equal(Config.fromEnv(testEnv()).push, null);
  assert.throws(() => Config.fromEnv(testEnv({ PUSH_SECRETS_KEY: 'short' })), /64 hex/);
  const c = Config.fromEnv(testEnv({ PUSH_SECRETS_KEY: KEY_HEX }));
  assert.deepEqual([c.push?.allowHttp, c.push?.allowPrivate, c.push?.timeoutMs], [false, false, 10_000]);
  assert.throws(() => Config.fromEnv(testEnv({ PUSH_SECRETS_KEY: KEY_HEX, PUSH_ALLOW_PRIVATE: 'true' })), /PUSH_ALLOWED_HOSTS is required/);
  assert.deepEqual(Config.fromEnv(testEnv({ PUSH_SECRETS_KEY: KEY_HEX, PUSH_ALLOW_PRIVATE: 'true', PUSH_ALLOWED_HOSTS: 'Workers.Internal' })).push?.allowedHosts, ['workers.internal']);
});

test('PushGuard: allowlist after DNS, link-local and metadata always refused', async () => {
  /** @param {string} address */
  const dns = (address) => async () => [{ address, family: address.includes(':') ? 6 : 4 }];
  const open = { allowHttp: true, allowPrivate: true, allowedHosts: ['workers.internal'] };
  assert.equal((await new PushGuard({ ...open, lookup: dns('10.0.0.5') }).resolve('http://workers.internal/hook')).address, '10.0.0.5', 'listed host on a private address');
  await assert.rejects(new PushGuard({ ...open, lookup: dns('10.0.0.5') }).resolve('http://other.internal/hook'), /not in TARGET_ALLOWED_HOSTS|PUSH_ALLOWED_HOSTS/);
  await assert.rejects(new PushGuard({ ...open, lookup: dns('169.254.169.254') }).resolve('http://workers.internal/x'), /link-local or metadata/, 'a listed name that resolves to metadata');
  await assert.rejects(new PushGuard({ ...open, lookup: dns('169.254.10.1') }).resolve('http://workers.internal/x'), /link-local/);
  await assert.rejects(new PushGuard({ ...open, lookup: dns('fe80::1') }).resolve('http://workers.internal/x'), /link-local/);
  await assert.rejects(new PushGuard({ ...open, allowedHosts: ['169.254.169.254'] }).resolve('http://169.254.169.254/latest/meta-data'), /link-local or metadata/, 'even when listed');
  await assert.rejects(new PushGuard({ allowHttp: false, allowPrivate: false, allowedHosts: [], lookup: dns('10.0.0.5') }).resolve('https://example.com/x'), /non-public/, 'private addresses without PUSH_ALLOW_PRIVATE');
  assert.equal((await new PushGuard({ allowHttp: false, allowPrivate: false, allowedHosts: [], lookup: dns('93.184.216.34') }).resolve('https://example.com/x')).address, '93.184.216.34');
});

test('push: due messages are POSTed signed, 2xx acks, pulls are refused, secret never shown', async () => {
  receiver.seen = [];
  receiver.status = 200;
  const { app, pusher, store } = await system();
  const put = await app.inject({ method: 'PUT', url: '/v1/queues/jobs', headers: bearer(ADMIN_KEY), payload: { push: { url: receiver.url, secret: SECRET, concurrency: 2 } } });
  assert.equal(put.statusCode, 201, put.body);
  assert.deepEqual(put.json().queue.push, { url: receiver.url, concurrency: 2 });
  assert.ok(!put.body.includes(SECRET));
  assert.ok(store.queue('jobs')?.push_secret?.startsWith('v1.'), 'sealed at rest');
  pusher.start();
  await app.inject({ method: 'POST', url: '/v1/queues/jobs/messages', headers: bearer(RW_KEY), payload: { body: { task: 'resize', id: 7 } } });
  await until(() => receiver.seen.length === 1 && store.depth('jobs') === 0);
  const req = receiver.seen[0];
  const payload = JSON.parse(req.body);
  assert.deepEqual([payload.queue, payload.attempt, payload.body], ['jobs', 1, { task: 'resize', id: 7 }]);
  assert.equal(req.headers['x-queue-name'], 'jobs');
  assert.equal(req.headers['x-queue-message-id'], payload.id);
  assert.ok(Signer.verify([SECRET], req.body, String(req.headers['x-queue-signature'])), 'signature verifies with the queue secret');
  const pull = await app.inject({ method: 'POST', url: '/v1/queues/jobs/pull', headers: bearer(RW_KEY), payload: {} });
  assert.equal(pull.statusCode, 409);
  assert.match((await app.inject({ url: '/metrics', headers: bearer(ADMIN_KEY) })).body, /queue_push_deliveries_total\{result="ok"\} 1/);
  await pusher.stop();
  await app.close();
});

test('push: failures nack with backoff, then dead-letter after maxAttempts; back to pull with push: null', async () => {
  receiver.seen = [];
  receiver.status = 500;
  const { app, pusher, store, service } = await system();
  await app.inject({ method: 'PUT', url: '/v1/queues/flaky', headers: bearer(ADMIN_KEY), payload: { maxAttempts: 2, backoffBaseSec: 0, backoffMaxSec: 0, push: { url: receiver.url, secret: SECRET } } });
  pusher.start();
  const sent = (await app.inject({ method: 'POST', url: '/v1/queues/flaky/messages', headers: bearer(RW_KEY), payload: { body: 1 } })).json().message;
  await until(() => service.message('flaky', sent.id).state === 'dead');
  assert.equal(receiver.seen.length, 2);
  assert.match(String(service.message('flaky', sent.id).last_error), /HTTP 500/);
  assert.equal(pusher.counters.failed, 2);
  // Secret kept on update without one; push: null switches back to pulling.
  await app.inject({ method: 'PUT', url: '/v1/queues/flaky', headers: bearer(ADMIN_KEY), payload: { push: { url: receiver.url, concurrency: 3 } } });
  assert.ok(store.queue('flaky')?.push_secret);
  await app.inject({ method: 'PUT', url: '/v1/queues/flaky', headers: bearer(ADMIN_KEY), payload: { push: null } });
  assert.equal(store.queue('flaky')?.push_url, null);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/queues/flaky/pull', headers: bearer(RW_KEY), payload: {} })).statusCode, 200);
  await pusher.stop();
  await app.close();
});

test('push: validation (secret on first set, URL guard, disabled server)', async () => {
  const { app } = await system({ PUSH_ALLOW_HTTP: 'false', PUSH_ALLOWED_HOSTS: '127.0.0.1,example.com' });
  const noSecret = await app.inject({ method: 'PUT', url: '/v1/queues/a', headers: bearer(ADMIN_KEY), payload: { push: { url: 'https://example.com/x' } } });
  assert.equal(noSecret.json().error.code, 'INVALID_ARGUMENT');
  const http = await app.inject({ method: 'PUT', url: '/v1/queues/a', headers: bearer(ADMIN_KEY), payload: { push: { url: 'http://example.com/x', secret: SECRET } } });
  assert.equal(http.json().error.code, 'INVALID_PUSH_URL');
  assert.equal((await app.inject({ method: 'PUT', url: '/v1/queues/a', headers: bearer(ADMIN_KEY), payload: { push: { url: 'https://example.com/x', secret: 'short' } } })).statusCode, 400);
  await app.close();
  const plain = new QueueService({ db: new Database(':memory:'), store: /** @type {any} */ (null), limits: Config.fromEnv(testEnv()).limits });
  plain.store = new QueueStore(plain.db);
  assert.throws(() => plain.putQueue('b', { push: { url: 'https://example.com/x', secret: SECRET } }, 't'), /PUSH_SECRETS_KEY/);
});

test('push: a paused queue is not delivered; the audit trail never carries the secret', async () => {
  receiver.seen = [];
  receiver.status = 200;
  const { app, pusher, store } = await system();
  await app.inject({ method: 'PUT', url: '/v1/queues/held', headers: bearer(ADMIN_KEY), payload: { paused: true, push: { url: receiver.url, secret: SECRET } } });
  pusher.start();
  await app.inject({ method: 'POST', url: '/v1/queues/held/messages', headers: bearer(RW_KEY), payload: { body: 1 } });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(receiver.seen.length, 0);
  await app.inject({ method: 'PUT', url: '/v1/queues/held', headers: bearer(ADMIN_KEY), payload: { paused: false } });
  await until(() => store.depth('held') === 0);
  assert.equal(receiver.seen.length, 1);
  await pusher.stop();
  await app.close();
  assert.deepEqual(QueueApi.redact({ paused: true, push: { url: 'https://x', secret: SECRET } }), { paused: true, push: { url: 'https://x', secret: '[redacted]' } });
  assert.deepEqual(QueueApi.redact({ push: null }), { push: null });
});
