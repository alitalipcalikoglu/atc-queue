import { CallError, HttpCaller, Signer } from '@atc-web/atc-service-core/http';
import { QueueError } from './errors.js';

/** @typedef {import('../types.js').QueueRow} QueueRow */
/** @typedef {import('../types.js').MessageRow} MessageRow */

/**
 * Push delivery: for every unpaused queue with a `push_url`, due messages are leased like a pull
 * and POSTed one by one, at most `push_concurrency` per queue at once. A 2xx answer acks the
 * message; anything else (or a timeout) nacks it, so the queue's backoff, `maxAttempts` and dead
 * letters apply exactly as for pulled messages. The body is signed with the queue's secret
 * (`x-queue-signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">`, the webhook-out format);
 * the target is SSRF-checked and its address pinned on every delivery.
 */
export class Pusher {
  static SIGNATURE_HEADER = 'x-queue-signature';
  static USER_AGENT = 'atc-queue/1.0';

  /**
   * @param {object} deps
   * @param {import('./queue-service.js').QueueService} deps.service
   * @param {import('@atc-web/atc-service-core/http').NetGuard} deps.guard
   * @param {import('@atc-web/atc-service-core/secrets').SecretBox} deps.box
   * @param {{ timeoutMs: number, intervalMs: number }} deps.options
   * @param {{ warn: (obj: object, msg: string) => void }} deps.log
   * @param {(target: import('@atc-web/atc-service-core/http').VettedTarget, body: string, headers: Record<string, string>, timeoutMs: number) => Promise<unknown>} [deps.send]  For tests.
   */
  constructor({ service, guard, box, options, log, send = (t, body, headers, ms) => HttpCaller.send(t, 'POST', headers, body, ms, 'push target') }) {
    this.service = service;
    this.guard = guard;
    this.box = box;
    this.options = options;
    this.log = log;
    this.send = send;
    /** @type {Map<string, number>} deliveries in flight per queue */
    this.inFlight = new Map();
    /** @type {Set<Promise<void>>} */
    this.pending = new Set();
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    this.stopped = true;
    this.counters = { delivered: 0, failed: 0 };
    this.onWake = (/** @type {string} */ queue) => { const q = this.service.store.queue(queue); if (q?.push_url && !q.paused) this.#fill(q); };
  }

  start() {
    this.stopped = false;
    this.timer = setInterval(() => this.tick(), this.options.intervalMs);
    this.timer.unref();
    this.service.enqueued.on('queue', this.onWake);
    this.tick();
    return this;
  }

  /** Stop taking messages and wait for deliveries in flight (bounded by PUSH_TIMEOUT_MS). */
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.service.enqueued.off('queue', this.onWake);
    await Promise.allSettled([...this.pending]);
  }

  /** One scan over every push queue. */
  tick() {
    if (this.stopped) return;
    for (const q of this.service.store.pushQueues()) this.#fill(q);
  }

  /** @param {QueueRow} q */
  #fill(q) {
    if (this.stopped) return;
    const free = q.push_concurrency - (this.inFlight.get(q.name) ?? 0);
    if (free <= 0) return;
    const now = this.service.now();
    if (!this.service.store.hasDue(q.name, now)) return;
    // The lease outlives the delivery timeout, so a slow target never sees the same message twice at once.
    const leaseMs = Math.max(q.visibility_sec * 1000, this.options.timeoutMs + 5_000);
    const got = this.service.db.transaction(() => this.service.store.claim(q.name, now, free, leaseMs));
    if (!got.length) return;
    this.service.store.bump(q.name, 'delivered', got.length);
    for (const m of got) {
      this.inFlight.set(q.name, (this.inFlight.get(q.name) ?? 0) + 1);
      const p = this.#deliver(q, m).finally(() => {
        this.inFlight.set(q.name, (this.inFlight.get(q.name) ?? 1) - 1);
        this.pending.delete(p);
        const fresh = this.service.store.queue(q.name);
        if (fresh?.push_url && !fresh.paused) this.#fill(fresh);
      });
      this.pending.add(p);
    }
  }

  /** @param {QueueRow} q @param {MessageRow} m */
  async #deliver(q, m) {
    const body = JSON.stringify({ id: m.id, queue: q.name, attempt: Number(m.attempts), priority: Number(m.priority), enqueuedAt: new Date(m.enqueued_at).toISOString(), body: JSON.parse(m.body) });
    const token = /** @type {string} */ (m.lease_token);
    try {
      const target = await this.guard.resolve(/** @type {string} */ (q.push_url));
      const secret = this.box.open(/** @type {string} */ (q.push_secret));
      await this.send(target, body, {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
        'user-agent': Pusher.USER_AGENT,
        'x-queue-name': q.name,
        'x-queue-message-id': m.id,
        'x-queue-attempt': String(m.attempts),
        [Pusher.SIGNATURE_HEADER]: Signer.sign(body, Math.floor(this.service.now() / 1000), [secret]),
      }, this.options.timeoutMs);
      this.counters.delivered++;
      this.#settle(() => this.service.ack(q.name, m.id, token));
    } catch (err) {
      this.counters.failed++;
      const e = /** @type {CallError & { code?: string }} */ (err);
      const reason = (e.httpStatus ? `HTTP ${e.httpStatus}: ` : '') + (e.message ?? String(err));
      this.log.warn({ queue: q.name, messageId: m.id, attempt: m.attempts, err: reason }, 'push delivery failed');
      this.#settle(() => this.service.nack(q.name, m.id, token, { error: reason }));
    }
  }

  /** The lease may be gone (queue purged or deleted meanwhile); that is not an error here. @param {() => unknown} fn */
  #settle(fn) {
    try {
      fn();
    } catch (err) {
      if (!(err instanceof QueueError && (err.code === 'LEASE_LOST' || err.code === 'MESSAGE_NOT_FOUND' || err.code === 'QUEUE_NOT_FOUND'))) throw err;
    }
  }
}
