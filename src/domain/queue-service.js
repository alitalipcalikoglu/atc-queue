import { EventEmitter } from 'node:events';
import { QueueError } from './errors.js';
import { QueueStore } from '../store/queue-store.js';

/** @typedef {import('../types.js').QueueRow} QueueRow */
/** @typedef {import('../types.js').MessageRow} MessageRow */

/**
 * Queue semantics: at-least-once delivery with visibility leases. A pulled message is invisible
 * until its lease ends; `ack` deletes it, `nack` (or an expired lease) makes it visible again after
 * a backoff, and after `max_attempts` deliveries it becomes a dead letter that stays until redriven,
 * deleted, purged or expired.
 */
export class QueueService {
  static NAME = /^[a-z][a-z0-9._-]{0,63}$/;
  static DEFAULTS = { visibilitySec: 30, maxAttempts: 5, backoffBaseSec: 5, backoffMaxSec: 900 };
  static POLL_MS = 200;

  /**
   * @param {object} deps
   * @param {import('../db.js').Database} deps.db
   * @param {QueueStore} deps.store
   * @param {import('../types.js').Limits} deps.limits
   * @param {() => number} [deps.now]
   */
  constructor({ db, store, limits, now = Date.now }) {
    this.db = db;
    this.store = store;
    this.limits = limits;
    this.now = now;
    /** Wakes long-polls on shutdown. */
    this.stopping = new AbortController();
    /** Emits the queue name when messages arrive, so a long-poll in this process does not wait out its poll interval. */
    this.wake = new EventEmitter().setMaxListeners(0);
  }

  /** @param {string} name @returns {QueueRow} */
  queue(name) {
    const q = this.store.queue(name);
    if (!q) throw new QueueError('QUEUE_NOT_FOUND', `queue "${name}" does not exist`);
    return q;
  }

  /**
   * Create or update a queue's settings; omitted fields keep their value (or the default).
   * @param {string} name
   * @param {{ description?: string, visibilitySec?: number, maxAttempts?: number, backoffBaseSec?: number, backoffMaxSec?: number, paused?: boolean }} input
   * @param {string} actor
   * @returns {{ queue: QueueRow, created: boolean }}
   */
  putQueue(name, input, actor) {
    if (!QueueService.NAME.test(name)) throw new QueueError('INVALID_ARGUMENT', 'queue name must match [a-z][a-z0-9._-]{0,63}');
    return this.db.transaction(() => {
      const cur = this.store.queue(name);
      if (!cur && this.store.queueCount() >= this.limits.maxQueues) throw new QueueError('LIMIT_EXCEEDED', `at most ${this.limits.maxQueues} queues`);
      const d = QueueService.DEFAULTS;
      const now = this.now();
      const row = {
        name,
        description: input.description ?? cur?.description ?? '',
        visibility_sec: input.visibilitySec ?? cur?.visibility_sec ?? d.visibilitySec,
        max_attempts: input.maxAttempts ?? cur?.max_attempts ?? d.maxAttempts,
        backoff_base_sec: input.backoffBaseSec ?? cur?.backoff_base_sec ?? d.backoffBaseSec,
        backoff_max_sec: input.backoffMaxSec ?? cur?.backoff_max_sec ?? d.backoffMaxSec,
        paused: input.paused === undefined ? (cur?.paused ?? 0) : input.paused ? 1 : 0,
        created_by: cur?.created_by ?? actor, created_at: cur?.created_at ?? now, updated_at: now,
      };
      if (row.backoff_max_sec < row.backoff_base_sec) throw new QueueError('INVALID_ARGUMENT', 'backoffMaxSec must be >= backoffBaseSec');
      this.store.upsertQueue(row);
      return { queue: this.queue(name), created: !cur };
    });
  }

  /** Refuses a queue that still holds messages unless `force`. @param {string} name @param {boolean} force */
  deleteQueue(name, force) {
    this.db.transaction(() => {
      this.queue(name);
      const depth = this.store.depth(name);
      if (depth && !force) throw new QueueError('QUEUE_NOT_EMPTY', `queue "${name}" holds ${depth} messages; purge it or pass force=true`, { depth });
      this.store.deleteQueue(name);
    });
  }

  /**
   * @param {string} queue
   * @param {{ body: unknown, delaySec?: number, priority?: number, dedupeKey?: string }[]} items
   * @param {string} actor
   * @returns {{ message: MessageRow, deduplicated: boolean }[]}
   */
  enqueue(queue, items, actor) {
    if (items.length > this.limits.maxBatch) throw new QueueError('LIMIT_EXCEEDED', `at most ${this.limits.maxBatch} messages per request`);
    const encoded = items.map((m) => {
      const body = JSON.stringify(m.body ?? null);
      if (Buffer.byteLength(body) > this.limits.maxMessageBytes) throw new QueueError('MESSAGE_TOO_LARGE', `message body exceeds MAX_MESSAGE_BYTES (${this.limits.maxMessageBytes})`);
      return { ...m, body };
    });
    const out = this.db.transaction(() => {
      this.queue(queue);
      if (this.store.depth(queue) + items.length > this.limits.maxQueueDepth) throw new QueueError('QUEUE_FULL', `queue "${queue}" would exceed MAX_QUEUE_DEPTH (${this.limits.maxQueueDepth})`);
      const now = this.now();
      return encoded.map((m) => {
        const { row, deduplicated } = this.store.insert({ queue, body: m.body, priority: m.priority ?? 0, dedupeKey: m.dedupeKey ?? null, availableAt: now + (m.delaySec ?? 0) * 1000, by: actor }, now);
        return { message: row, deduplicated };
      });
    });
    this.wake.emit(queue);
    return out;
  }

  /**
   * Lease up to `max` due messages, waiting up to `waitSec` for the first one.
   * @param {string} queue
   * @param {{ max?: number, visibilitySec?: number, waitSec?: number }} o
   * @param {AbortSignal} [signal]  The request's own signal (client went away).
   * @returns {Promise<MessageRow[]>}
   */
  async pull(queue, { max = 1, visibilitySec, waitSec = 0 }, signal) {
    const q = this.queue(queue);
    if (max > this.limits.maxBatch) throw new QueueError('LIMIT_EXCEEDED', `at most ${this.limits.maxBatch} messages per pull`);
    const deadline = this.now() + Math.min(waitSec, this.limits.maxWaitSec) * 1000;
    const leaseMs = (visibilitySec ?? q.visibility_sec) * 1000;
    for (;;) {
      const current = this.queue(queue);
      // Peek without the write lock first: N idle consumers polling an empty queue must not queue up for it.
      const got = current.paused || !this.store.hasDue(queue, this.now()) ? [] : this.db.transaction(() => this.store.claim(queue, this.now(), max, leaseMs));
      if (got.length) { this.store.bump(queue, 'delivered', got.length); return got; }
      if (this.now() >= deadline || signal?.aborted || this.stopping.signal.aborted) return [];
      await this.#idle(queue, AbortSignal.any([this.stopping.signal, ...(signal ? [signal] : [])]));
    }
  }

  /** Wait up to POLL_MS, or until something is enqueued into `queue` in this process. @param {string} queue @param {AbortSignal} signal */
  #idle(queue, signal) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.wake.off(queue, done); signal.removeEventListener('abort', done); resolve(undefined); };
      const timer = setTimeout(done, QueueService.POLL_MS);
      this.wake.once(queue, done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /** @param {string} queue @param {string} id @param {string} token */
  ack(queue, id, token) {
    this.queue(queue);
    if (!this.store.ack(queue, id, token)) throw this.#lost(queue, id);
    this.store.bump(queue, 'acked', 1);
  }

  /** @param {string} queue @param {string} id @param {string} token @param {number} visibilitySec */
  extend(queue, id, token, visibilitySec) {
    this.queue(queue);
    const until = this.now() + visibilitySec * 1000;
    if (!this.store.extend(queue, id, token, until)) throw this.#lost(queue, id);
    return until;
  }

  /**
   * Give a message back. It is retried after `delaySec` (or the queue's backoff), or becomes a
   * dead letter when its attempts are used up or `dead` is set.
   * @param {string} queue @param {string} id @param {string} token
   * @param {{ delaySec?: number, error?: string, dead?: boolean }} o
   * @returns {'retry'|'dead'}
   */
  nack(queue, id, token, { delaySec, error, dead = false }) {
    return this.db.transaction(() => {
      const q = this.queue(queue);
      const m = this.store.get(queue, id);
      if (!m || m.state !== 'leased' || m.lease_token !== token) throw this.#lost(queue, id);
      const now = this.now();
      const err = error ? error.slice(0, 1000) : null;
      if (dead || m.attempts >= q.max_attempts) {
        this.store.bury(queue, id, token, now, err);
        this.store.bump(queue, 'dead', 1);
        return 'dead';
      }
      this.store.retry(queue, id, token, now + (delaySec !== undefined ? delaySec * 1000 : QueueStore.backoffMs(m.attempts, q.backoff_base_sec, q.backoff_max_sec)), err);
      this.store.bump(queue, 'nacked', 1);
      return 'retry';
    });
  }

  /** @param {string} queue @param {string} id */
  #lost(queue, id) {
    return this.store.get(queue, id)
      ? new QueueError('LEASE_LOST', 'the lease token is not current (expired, already acked or held by someone else)')
      : new QueueError('MESSAGE_NOT_FOUND', `message ${id} is not in "${queue}" (acked, deleted or purged)`);
  }

  /** @param {string} queue @param {string} id */
  message(queue, id) {
    this.queue(queue);
    const m = this.store.get(queue, id);
    if (!m) throw new QueueError('MESSAGE_NOT_FOUND', `message ${id} is not in "${queue}"`);
    return m;
  }

  /** A leased message cannot be deleted (its consumer owns it until the lease ends). @param {string} queue @param {string} id */
  deleteMessage(queue, id) {
    const m = this.message(queue, id);
    if (m.state === 'leased') throw new QueueError('INVALID_STATE', 'the message is leased; wait for ack, nack or lease expiry');
    this.store.deleteMessage(queue, id);
  }

  /** @param {string} queue @param {string[]|null} ids */
  redrive(queue, ids) {
    this.queue(queue);
    return this.db.transaction(() => this.store.redrive(queue, ids, this.now()));
  }

  /**
   * `all` also removes leased messages; their consumers' acks then answer MESSAGE_NOT_FOUND.
   * @param {string} queue @param {'ready'|'dead'|'all'} which
   */
  purge(queue, which) {
    this.queue(queue);
    return this.store.purge(queue, which);
  }

  /** Expired leases back to ready (or dead); dead letters past retention removed. */
  maintain() {
    const now = this.now();
    const leases = this.store.reclaim(now);
    const expired = this.store.purgeDead(now - this.limits.deadRetentionDays * 86_400_000);
    return { ...leases, expired };
  }

  /** Every queue with depth by state, oldest due age and lifetime counters. */
  stats() {
    const summary = this.store.summary(this.now());
    const items = this.store.queues().map((q) => ({ queue: q, ...(/** @type {any} */ (summary.get(q.name))) }));
    const sum = (/** @type {'ready'|'delayed'|'leased'|'dead'} */ k) => items.reduce((a, i) => a + i[k], 0);
    return { queues: items.length, ready: sum('ready'), delayed: sum('delayed'), leased: sum('leased'), dead: sum('dead'), items };
  }
}
