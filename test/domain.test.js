import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueueError } from '../src/domain/errors.js';
import { QueueStore } from '../src/store/queue-store.js';
import { manualClock, testService } from './helpers.js';

/** @param {string} code */
const fails = (code) => (/** @type {unknown} */ e) => e instanceof QueueError && e.code === code;

test('queues: create with defaults, update keeps unspecified fields, validation, limits, delete', () => {
  const { service } = testService({ MAX_QUEUES: '2' });
  const { queue, created } = service.putQueue('emails', { description: 'Outbound mail' }, 'console');
  assert.deepEqual([created, queue.visibility_sec, queue.max_attempts, queue.backoff_base_sec, queue.backoff_max_sec, queue.paused], [true, 30, 5, 5, 900, 0]);
  const again = service.putQueue('emails', { maxAttempts: 3 }, 'x');
  assert.deepEqual([again.created, again.queue.max_attempts, again.queue.description, again.queue.created_by], [false, 3, 'Outbound mail', 'console']);
  assert.throws(() => service.putQueue('Emails', {}, 'x'), fails('INVALID_ARGUMENT'));
  assert.throws(() => service.putQueue('emails', { backoffBaseSec: 100, backoffMaxSec: 10 }, 'x'), fails('INVALID_ARGUMENT'));
  service.putQueue('b', {}, 'x');
  assert.throws(() => service.putQueue('c', {}, 'x'), fails('LIMIT_EXCEEDED'));
  service.enqueue('b', [{ body: 1 }], 'x');
  assert.throws(() => service.deleteQueue('b', false), fails('QUEUE_NOT_EMPTY'));
  service.deleteQueue('b', true);
  assert.throws(() => service.queue('b'), fails('QUEUE_NOT_FOUND'));
});

test('enqueue/pull: priority, then due time, then order; delays; dedupe; size and depth caps', async () => {
  const clock = manualClock();
  const { service } = testService({ MAX_MESSAGE_BYTES: '256', MAX_QUEUE_DEPTH: '6' }, clock.now);
  service.putQueue('jobs', {}, 'x');
  service.enqueue('jobs', [{ body: 'low' }, { body: 'high', priority: 5 }, { body: 'later', delaySec: 60 }, { body: 'mid', priority: 1 }], 'app');
  const [dup] = service.enqueue('jobs', [{ body: 'a', dedupeKey: 'order-1' }], 'app');
  const [dup2] = service.enqueue('jobs', [{ body: 'b', dedupeKey: 'order-1' }], 'app');
  assert.deepEqual([dup.deduplicated, dup2.deduplicated, dup2.message.id, JSON.parse(dup2.message.body)], [false, true, dup.message.id, 'a'], 'same dedupe key returns the first message');
  assert.throws(() => service.enqueue('jobs', [{ body: 'x'.repeat(300) }], 'app'), fails('MESSAGE_TOO_LARGE'));
  service.enqueue('jobs', [{ body: 'six' }], 'app');
  assert.throws(() => service.enqueue('jobs', [{ body: 'seven' }], 'app'), fails('QUEUE_FULL'));
  const got = await service.pull('jobs', { max: 10 });
  assert.deepEqual(got.map((m) => JSON.parse(m.body)), ['high', 'mid', 'low', 'a', 'six'], 'delayed message not delivered yet');
  assert.ok(got.every((m) => m.attempts === 1 && m.lease_token && m.lease_until === clock.t + 30_000));
  assert.deepEqual(await service.pull('jobs', { max: 10 }), [], 'leased messages are invisible');
  clock.advance(60_000);
  service.maintain();
  const next = await service.pull('jobs', { max: 10 });
  assert.ok(next.some((m) => JSON.parse(m.body) === 'later'), 'delay passed');
});

test('ack, extend, nack with backoff, dead-letter after max attempts, lease loss fencing', async () => {
  const clock = manualClock();
  const { service, store } = testService(undefined, clock.now);
  service.putQueue('mail', { maxAttempts: 2, backoffBaseSec: 10, backoffMaxSec: 60 }, 'x');
  const [{ message }] = service.enqueue('mail', [{ body: { to: 'a@b.co' } }], 'app');
  let [m] = await service.pull('mail', {});
  assert.throws(() => service.ack('mail', m.id, '00000000-0000-0000-0000-000000000000'), fails('LEASE_LOST'));
  const until = service.extend('mail', m.id, /** @type {string} */ (m.lease_token), 120);
  assert.equal(until, clock.t + 120_000);
  assert.equal(service.nack('mail', m.id, /** @type {string} */ (m.lease_token), { error: 'smtp 451' }), 'retry');
  let row = /** @type {any} */ (store.get('mail', message.id));
  assert.deepEqual([row.state, row.available_at - clock.t, row.last_error], ['ready', 10_000, 'smtp 451'], 'first backoff = base');
  assert.throws(() => service.ack('mail', m.id, /** @type {string} */ (m.lease_token)), fails('LEASE_LOST'), 'old token is dead after nack');
  clock.advance(10_000);
  [m] = await service.pull('mail', {});
  assert.equal(m.attempts, 2);
  assert.equal(service.nack('mail', m.id, /** @type {string} */ (m.lease_token), {}), 'dead', 'attempts used up');
  assert.equal(store.get('mail', message.id)?.state, 'dead');
  assert.equal(service.redrive('mail', [message.id]), 1);
  row = /** @type {any} */ (store.get('mail', message.id));
  assert.deepEqual([row.state, row.attempts, row.last_error], ['ready', 0, null]);
  [m] = await service.pull('mail', {});
  service.ack('mail', m.id, /** @type {string} */ (m.lease_token));
  assert.equal(store.get('mail', message.id), undefined, 'acked = deleted');
  assert.throws(() => service.ack('mail', m.id, /** @type {string} */ (m.lease_token)), fails('MESSAGE_NOT_FOUND'));
  assert.deepEqual(store.counters('mail'), { enqueued: 1, delivered: 3, nacked: 1, dead: 1, redriven: 1, acked: 1 });
  const [{ message: d }] = service.enqueue('mail', [{ body: 'poison' }], 'app');
  [m] = await service.pull('mail', {});
  assert.equal(service.nack('mail', m.id, /** @type {string} */ (m.lease_token), { dead: true, error: 'bad payload' }), 'dead', 'consumer can dead-letter at once');
  assert.equal(store.get('mail', d.id)?.last_error, 'bad payload');
});

test('expired leases are redelivered with backoff, then dead-lettered; old consumers are fenced', async () => {
  const clock = manualClock();
  const { service, store } = testService(undefined, clock.now);
  service.putQueue('jobs', { maxAttempts: 2, visibilitySec: 5, backoffBaseSec: 0 }, 'x');
  const [{ message }] = service.enqueue('jobs', [{ body: 1 }], 'app');
  const [first] = await service.pull('jobs', {});
  clock.advance(6_000);
  assert.deepEqual(service.maintain(), { retried: 1, buried: 0, expired: 0 });
  assert.throws(() => service.ack('jobs', first.id, /** @type {string} */ (first.lease_token)), fails('LEASE_LOST'), 'consumer that lost its lease cannot ack');
  const [second] = await service.pull('jobs', {});
  assert.equal(second.attempts, 2);
  clock.advance(6_000);
  assert.deepEqual(service.maintain(), { retried: 0, buried: 1, expired: 0 });
  assert.equal(store.get('jobs', message.id)?.state, 'dead');
  assert.equal(service.redrive('jobs', null), 1, 'redrive all');
});

test('long-poll waits for a message, pause holds deliveries, purge, delete, dead retention', async () => {
  const { service, store } = testService({ DEAD_RETENTION_DAYS: '1' });
  service.putQueue('jobs', {}, 'x');
  setTimeout(() => service.enqueue('jobs', [{ body: 'late' }], 'app'), 300);
  const t0 = Date.now();
  const got = await service.pull('jobs', { waitSec: 3 });
  assert.equal(got.length, 1);
  assert.ok(Date.now() - t0 >= 250 && Date.now() - t0 < 2_000);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const t1 = Date.now();
  assert.deepEqual(await service.pull('jobs', { waitSec: 5 }, ac.signal), []);
  assert.ok(Date.now() - t1 < 1_000, 'client disconnect ends the long-poll');
  service.putQueue('jobs', { paused: true }, 'x');
  service.enqueue('jobs', [{ body: 'held' }], 'app');
  assert.deepEqual(await service.pull('jobs', {}), []);
  service.putQueue('jobs', { paused: false }, 'x');
  const [h] = await service.pull('jobs', {});
  assert.throws(() => service.deleteMessage('jobs', h.id), fails('INVALID_STATE'), 'leased messages cannot be deleted');
  service.nack('jobs', h.id, /** @type {string} */ (h.lease_token), { dead: true });
  const [{ message: r }] = service.enqueue('jobs', [{ body: 'r' }], 'app');
  service.deleteMessage('jobs', r.id);
  assert.equal(service.purge('jobs', 'dead'), 1);
  service.enqueue('jobs', [{ body: 1 }, { body: 2 }], 'app');
  assert.equal(service.purge('jobs', 'all'), 3, 'including the leased one from the first pull');
  assert.equal(QueueStore.backoffMs(4, 5, 900), 40_000);
  assert.equal(QueueStore.backoffMs(20, 5, 900), 900_000);
  void store;
});
