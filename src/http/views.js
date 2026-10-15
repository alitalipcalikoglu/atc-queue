/** Response shapes. */
export class Views {
  /** @param {number|null} t */
  static iso(t) {
    return t === null || t === undefined ? null : new Date(Number(t)).toISOString();
  }

  /** @param {import('../types.js').QueueRow} q */
  static queue(q) {
    return { name: q.name, description: q.description, visibilitySec: Number(q.visibility_sec), maxAttempts: Number(q.max_attempts), backoffBaseSec: Number(q.backoff_base_sec), backoffMaxSec: Number(q.backoff_max_sec), paused: q.paused === 1, push: q.push_url ? { url: q.push_url, concurrency: Number(q.push_concurrency) } : null, createdBy: q.created_by, createdAt: Views.iso(q.created_at), updatedAt: Views.iso(q.updated_at) };
  }

  /** @param {import('../types.js').MessageRow} m @param {number} now @param {{ token?: boolean }} [o] */
  static message(m, now, o = {}) {
    const state = m.state === 'ready' && m.available_at > now ? 'delayed' : m.state;
    return {
      id: m.id, queue: m.queue, body: JSON.parse(m.body), priority: Number(m.priority), dedupeKey: m.dedupe_key, state, attempts: Number(m.attempts),
      availableAt: Views.iso(m.available_at), leaseUntil: Views.iso(m.lease_until), lastError: m.last_error, enqueuedBy: m.enqueued_by, enqueuedAt: Views.iso(m.enqueued_at), deadAt: Views.iso(m.dead_at),
      ...(o.token ? { leaseToken: m.lease_token } : {}),
    };
  }
}
