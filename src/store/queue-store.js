import { randomUUID } from 'node:crypto';

/** @typedef {import('../db.js').Database} Database */
/** @typedef {import('../types.js').QueueRow} QueueRow */
/** @typedef {import('../types.js').MessageRow} MessageRow */

/**
 * Queues, messages and counters. Claims run in one `BEGIN IMMEDIATE` transaction so two pullers
 * never get the same message; every lease-holder write is fenced on the lease token.
 */
export class QueueStore {
  static Q = 'name, description, visibility_sec, max_attempts, backoff_base_sec, backoff_max_sec, paused, created_by, created_at, updated_at, push_url, push_secret, push_concurrency';
  static M = 'seq, id, queue, body, priority, dedupe_key, state, attempts, available_at, lease_token, lease_until, last_error, enqueued_by, enqueued_at, dead_at';

  /** @param {Database} db */
  constructor(db) {
    this.db = db;
    const { Q, M } = QueueStore;
    const fenced = "WHERE queue = ? AND id = ? AND lease_token = ? AND state = 'leased'";
    this.stmt = {
      upsertQueue: db.prepare(`INSERT INTO queues (${Q}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET description = excluded.description, visibility_sec = excluded.visibility_sec, max_attempts = excluded.max_attempts, backoff_base_sec = excluded.backoff_base_sec, backoff_max_sec = excluded.backoff_max_sec, paused = excluded.paused, updated_at = excluded.updated_at,
          push_url = excluded.push_url, push_secret = excluded.push_secret, push_concurrency = excluded.push_concurrency`),
      pushQueues: db.prepare(`SELECT ${Q} FROM queues WHERE push_url IS NOT NULL AND paused = 0 ORDER BY name`),
      queue: db.prepare(`SELECT ${Q} FROM queues WHERE name = ?`),
      queues: db.prepare(`SELECT ${Q} FROM queues ORDER BY name`),
      queueCount: db.prepare('SELECT COUNT(*) AS n FROM queues'),
      deleteQueue: db.prepare('DELETE FROM queues WHERE name = ?'),
      insert: db.prepare(`INSERT INTO messages (id, queue, body, priority, dedupe_key, state, attempts, available_at, enqueued_by, enqueued_at) VALUES (?, ?, ?, ?, ?, 'ready', 0, ?, ?, ?)`),
      byDedupe: db.prepare(`SELECT ${M} FROM messages WHERE queue = ? AND dedupe_key = ?`),
      get: db.prepare(`SELECT ${M} FROM messages WHERE queue = ? AND id = ?`),
      depth: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE queue = ?'),
      hasDue: db.prepare(`SELECT 1 AS x FROM messages WHERE queue = ? AND state = 'ready' AND available_at <= ? LIMIT 1`),
      due: db.prepare(`SELECT ${M} FROM messages WHERE queue = ? AND state = 'ready' AND available_at <= ? ORDER BY priority DESC, available_at, seq LIMIT ?`),
      lease: db.prepare("UPDATE messages SET state = 'leased', attempts = attempts + 1, lease_token = ?, lease_until = ? WHERE seq = ? AND state = 'ready'"),
      ack: db.prepare(`DELETE FROM messages ${fenced}`),
      extend: db.prepare(`UPDATE messages SET lease_until = ? ${fenced}`),
      retry: db.prepare(`UPDATE messages SET state = 'ready', available_at = ?, lease_token = NULL, lease_until = NULL, last_error = ? ${fenced}`),
      bury: db.prepare(`UPDATE messages SET state = 'dead', dead_at = ?, lease_token = NULL, lease_until = NULL, last_error = ? ${fenced}`),
      expired: db.prepare(`SELECT m.seq, m.queue, m.id, m.attempts, q.max_attempts, q.backoff_base_sec, q.backoff_max_sec FROM messages m JOIN queues q ON q.name = m.queue WHERE m.state = 'leased' AND m.lease_until < ?`),
      expireRetry: db.prepare("UPDATE messages SET state = 'ready', available_at = ?, lease_token = NULL, lease_until = NULL, last_error = 'lease expired' WHERE seq = ? AND state = 'leased'"),
      expireBury: db.prepare("UPDATE messages SET state = 'dead', dead_at = ?, lease_token = NULL, lease_until = NULL, last_error = 'lease expired' WHERE seq = ? AND state = 'leased'"),
      redriveOne: db.prepare("UPDATE messages SET state = 'ready', attempts = 0, available_at = ?, dead_at = NULL, last_error = NULL WHERE queue = ? AND id = ? AND state = 'dead'"),
      redriveAll: db.prepare("UPDATE messages SET state = 'ready', attempts = 0, available_at = ?, dead_at = NULL, last_error = NULL WHERE queue = ? AND state = 'dead'"),
      deleteMessage: db.prepare("DELETE FROM messages WHERE queue = ? AND id = ? AND state <> 'leased'"),
      purgeState: db.prepare('DELETE FROM messages WHERE queue = ? AND state = ?'),
      purgeAll: db.prepare('DELETE FROM messages WHERE queue = ?'),
      purgeDead: db.prepare("DELETE FROM messages WHERE state = 'dead' AND dead_at < ?"),
      bump: db.prepare('INSERT INTO counters (queue, name, value) VALUES (?, ?, ?) ON CONFLICT(queue, name) DO UPDATE SET value = value + excluded.value'),
      counters: db.prepare('SELECT name, value FROM counters WHERE queue = ?'),
      allCounters: db.prepare('SELECT queue, name, value FROM counters'),
      states: db.prepare("SELECT queue, CASE WHEN state = 'ready' AND available_at > ? THEN 'delayed' ELSE state END AS s, COUNT(*) AS n FROM messages GROUP BY queue, s"),
      oldestReady: db.prepare("SELECT queue, MIN(available_at) AS t FROM messages WHERE state = 'ready' AND available_at <= ? GROUP BY queue"),
    };
  }

  /** Time-ordered, unique message id. */
  static newId() {
    return `msg_${Date.now().toString(36)}${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }

  /** @param {QueueRow} q */
  upsertQueue(q) {
    this.stmt.upsertQueue.run(q.name, q.description, q.visibility_sec, q.max_attempts, q.backoff_base_sec, q.backoff_max_sec, q.paused, q.created_by, q.created_at, q.updated_at, q.push_url, q.push_secret, q.push_concurrency);
  }

  /** Unpaused queues in push mode. @returns {QueueRow[]} */
  pushQueues() { return /** @type {QueueRow[]} */ (this.stmt.pushQueues.all()); }

  /** @param {string} name @returns {QueueRow|undefined} */
  queue(name) { return /** @type {QueueRow|undefined} */ (this.stmt.queue.get(name)); }
  /** @returns {QueueRow[]} */
  queues() { return /** @type {QueueRow[]} */ (this.stmt.queues.all()); }
  queueCount() { return Number(/** @type {{ n: number }} */ (this.stmt.queueCount.get()).n); }
  /** @param {string} name */
  deleteQueue(name) { return Number(this.stmt.deleteQueue.run(name).changes) === 1; }
  /** @param {string} queue */
  depth(queue) { return Number(/** @type {{ n: number }} */ (this.stmt.depth.get(queue)).n); }

  /**
   * @param {{ queue: string, body: string, priority: number, dedupeKey: string|null, availableAt: number, by: string }} m
   * @param {number} now
   * @returns {{ row: MessageRow, deduplicated: boolean }}
   */
  insert(m, now) {
    if (m.dedupeKey) {
      const existing = /** @type {MessageRow|undefined} */ (this.stmt.byDedupe.get(m.queue, m.dedupeKey));
      if (existing) return { row: existing, deduplicated: true };
    }
    const id = QueueStore.newId();
    this.stmt.insert.run(id, m.queue, m.body, m.priority, m.dedupeKey, m.availableAt, m.by, now);
    this.bump(m.queue, 'enqueued', 1);
    return { row: /** @type {MessageRow} */ (this.get(m.queue, id)), deduplicated: false };
  }

  /** @param {string} queue @param {string} id @returns {MessageRow|undefined} */
  get(queue, id) { return /** @type {MessageRow|undefined} */ (this.stmt.get.get(queue, id)); }

  /** Read-only peek: is anything ready to lease? Takes no write lock, so idle long-polls stay cheap. @param {string} queue @param {number} now */
  hasDue(queue, now) { return this.stmt.hasDue.get(queue, now) !== undefined; }

  /**
   * Lease up to `limit` due messages. Must run inside a transaction.
   * @param {string} queue @param {number} now @param {number} limit @param {number} leaseMs
   * @returns {MessageRow[]}
   */
  claim(queue, now, limit, leaseMs) {
    /** @type {MessageRow[]} */
    const out = [];
    for (const m of /** @type {MessageRow[]} */ (this.stmt.due.all(queue, now, limit))) {
      const token = randomUUID();
      if (Number(this.stmt.lease.run(token, now + leaseMs, m.seq).changes) === 1) out.push({ ...m, state: 'leased', attempts: m.attempts + 1, lease_token: token, lease_until: now + leaseMs });
    }
    return out;
  }

  /** @param {string} queue @param {string} id @param {string} token */
  ack(queue, id, token) { return Number(this.stmt.ack.run(queue, id, token).changes) === 1; }
  /** @param {string} queue @param {string} id @param {string} token @param {number} until */
  extend(queue, id, token, until) { return Number(this.stmt.extend.run(until, queue, id, token).changes) === 1; }
  /** @param {string} queue @param {string} id @param {string} token @param {number} at @param {string|null} error */
  retry(queue, id, token, at, error) { return Number(this.stmt.retry.run(at, error, queue, id, token).changes) === 1; }
  /** @param {string} queue @param {string} id @param {string} token @param {number} now @param {string|null} error */
  bury(queue, id, token, now, error) { return Number(this.stmt.bury.run(now, error, queue, id, token).changes) === 1; }

  /**
   * Leases that ran out: the delivery counts; back to ready with backoff, or dead when the
   * attempts are used up.
   * @param {number} now
   */
  reclaim(now) {
    return this.db.transaction(() => {
      let retried = 0;
      let buried = 0;
      for (const m of /** @type {{ seq: number, queue: string, attempts: number, max_attempts: number, backoff_base_sec: number, backoff_max_sec: number }[]} */ (this.stmt.expired.all(now))) {
        if (m.attempts >= m.max_attempts) { this.stmt.expireBury.run(now, m.seq); this.bump(m.queue, 'dead', 1); buried++; }
        else { this.stmt.expireRetry.run(now + QueueStore.backoffMs(m.attempts, m.backoff_base_sec, m.backoff_max_sec), m.seq); this.bump(m.queue, 'expired', 1); retried++; }
      }
      return { retried, buried };
    });
  }

  /** Exponential backoff after `attempts` deliveries. @param {number} attempts @param {number} baseSec @param {number} maxSec */
  static backoffMs(attempts, baseSec, maxSec) {
    return Math.min(maxSec, baseSec * 2 ** Math.max(0, attempts - 1)) * 1000;
  }

  /** @param {string} queue @param {string[]|null} ids null = every dead letter @param {number} now */
  redrive(queue, ids, now) {
    const n = ids === null ? Number(this.stmt.redriveAll.run(now, queue).changes) : ids.reduce((a, id) => a + Number(this.stmt.redriveOne.run(now, queue, id).changes), 0);
    if (n) this.bump(queue, 'redriven', n);
    return n;
  }

  /** @param {string} queue @param {string} id */
  deleteMessage(queue, id) { return Number(this.stmt.deleteMessage.run(queue, id).changes) === 1; }

  /** @param {string} queue @param {'ready'|'dead'|'all'} which */
  purge(queue, which) {
    return Number((which === 'all' ? this.stmt.purgeAll.run(queue) : this.stmt.purgeState.run(queue, which)).changes);
  }

  /** @param {number} before */
  purgeDead(before) { return Number(this.stmt.purgeDead.run(before).changes); }

  /**
   * Browse one queue by state, oldest first; `delayed` = ready but not yet due.
   * @param {string} queue
   * @param {{ state?: 'ready'|'delayed'|'leased'|'dead', after?: number, limit: number }} q
   * @param {number} now
   * @returns {MessageRow[]}
   */
  list(queue, { state, after = 0, limit }, now) {
    const where = ['queue = ?', 'seq > ?'];
    /** @type {(string|number)[]} */
    const args = [queue, after];
    if (state === 'delayed') { where.push("state = 'ready' AND available_at > ?"); args.push(now); }
    else if (state === 'ready') { where.push("state = 'ready' AND available_at <= ?"); args.push(now); }
    else if (state) { where.push('state = ?'); args.push(state); }
    args.push(limit);
    return /** @type {MessageRow[]} */ (this.db.prepare(`SELECT ${QueueStore.M} FROM messages WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`).all(...args));
  }

  /** @param {string} queue @param {string} name @param {number} by */
  bump(queue, name, by) { this.stmt.bump.run(queue, name, by); }

  /** @param {string} queue @returns {Record<string, number>} */
  counters(queue) {
    return Object.fromEntries(/** @type {{ name: string, value: number }[]} */ (this.stmt.counters.all(queue)).map((c) => [c.name, Number(c.value)]));
  }

  /**
   * Depth by state per queue, counters and the age of the oldest due message.
   * @param {number} now
   * @returns {Map<string, { ready: number, delayed: number, leased: number, dead: number, oldestReadyMs: number|null, counters: Record<string, number> }>}
   */
  summary(now) {
    /** @type {Map<string, { ready: number, delayed: number, leased: number, dead: number, oldestReadyMs: number|null, counters: Record<string, number> }>} */
    const out = new Map(this.queues().map((q) => [q.name, { ready: 0, delayed: 0, leased: 0, dead: 0, oldestReadyMs: null, counters: {} }]));
    for (const r of /** @type {{ queue: string, s: 'ready'|'delayed'|'leased'|'dead', n: number }[]} */ (this.stmt.states.all(now))) { const q = out.get(r.queue); if (q) q[r.s] = Number(r.n); }
    for (const r of /** @type {{ queue: string, t: number }[]} */ (this.stmt.oldestReady.all(now))) { const q = out.get(r.queue); if (q) q.oldestReadyMs = now - Number(r.t); }
    for (const r of /** @type {{ queue: string, name: string, value: number }[]} */ (this.stmt.allCounters.all())) { const q = out.get(r.queue); if (q) q.counters[r.name] = Number(r.value); }
    return out;
  }
}
