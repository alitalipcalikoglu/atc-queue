/**
 * Shared JSDoc typedefs for the queue service. No runtime exports.
 */

/** @typedef {'read'|'write'|'readwrite'|'admin'} KeyRole */

/**
 * @typedef {object} ApiKey
 * @property {string} id
 * @property {string} secret
 * @property {KeyRole} role
 * @property {string[]|null} queues   Queues the key may touch; null = all.
 */

/**
 * @typedef {object} Limits
 * @property {number} maxMessageBytes    JSON-encoded size of one message body.
 * @property {number} maxQueueDepth      Messages (any state) per queue.
 * @property {number} maxBatch           Messages per enqueue batch or pull.
 * @property {number} maxWaitSec         Longest long-poll of a pull.
 * @property {number} maxQueues
 * @property {number} deadRetentionDays  Dead letters are deleted after this.
 * @property {number} reapMs             How often expired leases are reclaimed.
 */

/**
 * @typedef {object} ConfigValues
 * @property {number} port
 * @property {string} host
 * @property {string} logLevel
 * @property {boolean} trustProxy
 * @property {{ certPath: string, keyPath: string }|null} tls
 * @property {{ url: string, apiKey: string }|null} audit
 * @property {{ url: string, apiKey: string, timeoutMs: number }|null} webhookOut  atc-webhook-out target for events; null = off.
 * @property {number} bodyLimit
 * @property {string} dbPath
 * @property {string} [dbBackupDir]
 * @property {ApiKey[]} apiKeys
 * @property {number} rateLimitMax
 * @property {Limits} limits
 * @property {PushConfig|null} push  Push delivery to HTTP endpoints; null = off (PUSH_SECRETS_KEY unset).
 */

/** @typedef {'ready'|'leased'|'dead'} MessageState */

/**
 * @typedef {object} PushConfig
 * @property {Buffer} secretsKey     Encrypts each queue's push signing secret at rest.
 * @property {boolean} allowHttp      Permit http:// push URLs.
 * @property {boolean} allowPrivate   Permit push URLs on private or loopback addresses.
 * @property {string[]} allowedHosts  Host allowlist (exact or parent domain); empty = any public host.
 * @property {number} timeoutMs       Per delivery.
 * @property {number} intervalMs      How often push queues are scanned for due messages.
 */

/**
 * @typedef {object} QueueRow
 * @property {string} name
 * @property {string} description
 * @property {number} visibility_sec   Default lease of a pull.
 * @property {number} max_attempts     Deliveries before a message is dead-lettered.
 * @property {number} backoff_base_sec
 * @property {number} backoff_max_sec
 * @property {number} paused           1 = pulls return nothing (and nothing is pushed).
 * @property {string|null} push_url    Push mode: due messages are POSTed here; pulls are refused.
 * @property {string|null} push_secret Sealed (SecretBox) signing secret.
 * @property {number} push_concurrency Deliveries in flight at once.
 * @property {string} created_by
 * @property {number} created_at
 * @property {number} updated_at
 */

/**
 * @typedef {object} MessageRow
 * @property {string} id
 * @property {string} queue
 * @property {string} body        JSON.
 * @property {number} priority    Higher first.
 * @property {string|null} dedupe_key
 * @property {MessageState} state
 * @property {number} attempts    Deliveries so far.
 * @property {number} available_at
 * @property {string|null} lease_token
 * @property {number|null} lease_until
 * @property {string|null} last_error
 * @property {string} enqueued_by
 * @property {number} enqueued_at
 * @property {number|null} dead_at
 * @property {number} seq
 */

/** @typedef {import('fastify').FastifyBaseLogger} Logger */

export {};
