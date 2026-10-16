import { ConfigError, EnvReader, parseApiKeys, parseAudit } from '@atc-web/atc-service-core/config';
import { EventPublisher } from './events/event-publisher.js';

/** @typedef {import('./types.js').ApiKey} ApiKey */
/** @typedef {import('./types.js').KeyRole} KeyRole */

export { ConfigError };

/** Validated service configuration. Build with {@link Config.fromEnv}. */
export class Config {
  static MIN_SECRET_LENGTH = 32;
  static QUEUE_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

  /** @param {import('./types.js').ConfigValues} v */
  constructor(v) {
    this.port = v.port;
    this.host = v.host;
    this.logLevel = v.logLevel;
    this.trustProxy = v.trustProxy;
    this.tls = v.tls;
    this.audit = v.audit;
    this.webhookOut = v.webhookOut;
    this.bodyLimit = v.bodyLimit;
    this.dbPath = v.dbPath;
    this.dbBackupDir = v.dbBackupDir;
    this.apiKeys = v.apiKeys;
    this.rateLimitMax = v.rateLimitMax;
    this.limits = Object.freeze({ ...v.limits });
    this.push = v.push;
    Object.freeze(this);
  }

  /** @param {NodeJS.ProcessEnv} [env] @returns {Config} */
  static fromEnv(env = process.env) {
    const r = new EnvReader(env);
    const certPath = r.optional('TLS_CERT_PATH');
    const keyPath = r.optional('TLS_KEY_PATH');
    if (Boolean(certPath) !== Boolean(keyPath)) throw new ConfigError('TLS_CERT_PATH and TLS_KEY_PATH must be set together');
    const maxMessageBytes = r.integer('MAX_MESSAGE_BYTES', 262_144, { min: 256, max: 16_777_216 });
    return new Config({
      port: r.integer('PORT', 3016, { min: 0, max: 65535 }),
      host: r.optional('HOST') || '0.0.0.0',
      logLevel: r.optional('LOG_LEVEL') || 'info',
      trustProxy: r.boolean('TRUST_PROXY', false),
      tls: certPath ? { certPath, keyPath } : null,
      audit: parseAudit(r),
      webhookOut: EventPublisher.parseEnv(r, ConfigError),
      // A batch of the largest messages must fit, plus JSON overhead.
      bodyLimit: r.integer('BODY_LIMIT', Math.max(1_048_576, maxMessageBytes * 2), { min: 16_384 }),
      dbPath: r.optional('DB_PATH') || './data/queue.db',
      dbBackupDir: r.optional('DB_BACKUP_DIR') || undefined,
      apiKeys: Config.#parseApiKeys(r.required('QUEUE_API_KEYS')),
      rateLimitMax: r.integer('RATE_LIMIT_MAX', 6_000, { min: 1 }),
      limits: {
        maxMessageBytes,
        maxQueueDepth: r.integer('MAX_QUEUE_DEPTH', 100_000, { min: 1 }),
        maxBatch: r.integer('MAX_BATCH', 100, { min: 1, max: 1_000 }),
        maxWaitSec: r.integer('MAX_WAIT_SEC', 20, { min: 0, max: 25 }),
        maxQueues: r.integer('MAX_QUEUES', 500, { min: 1 }),
        deadRetentionDays: r.integer('DEAD_RETENTION_DAYS', 14, { min: 1 }),
        reapMs: r.integer('REAP_MS', 1_000, { min: 100 }),
      },
      push: Config.#push(r),
    });
  }

  /**
   * Push delivery: on when `PUSH_SECRETS_KEY` is set (it encrypts the per-queue signing secrets at rest).
   * @param {EnvReader} r @returns {import('./types.js').PushConfig|null}
   */
  static #push(r) {
    const hex = r.optional('PUSH_SECRETS_KEY');
    if (!hex) return null;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new ConfigError('PUSH_SECRETS_KEY must be 64 hex characters (32 bytes); generate with: openssl rand -hex 32');
    const allowPrivate = r.boolean('PUSH_ALLOW_PRIVATE', false);
    const allowedHosts = r.list('PUSH_ALLOWED_HOSTS', '').map((h) => h.toLowerCase());
    // Private targets only for named hosts: never "any internal address".
    if (allowPrivate && allowedHosts.length === 0) throw new ConfigError('PUSH_ALLOWED_HOSTS is required when PUSH_ALLOW_PRIVATE is true');
    return {
      secretsKey: Buffer.from(hex, 'hex'),
      allowHttp: r.boolean('PUSH_ALLOW_HTTP', false),
      allowPrivate,
      allowedHosts,
      timeoutMs: r.integer('PUSH_TIMEOUT_MS', 10_000, { min: 500, max: 120_000 }),
      intervalMs: r.integer('PUSH_INTERVAL_MS', 500, { min: 50, max: 60_000 }),
    };
  }

  /**
   * `id:secret[:role[:queue+queue]]`. Role defaults to `readwrite`; queues to all.
   * @param {string} raw @returns {ApiKey[]}
   */
  static #parseApiKeys(raw) {
    return parseApiKeys(raw, 'QUEUE_API_KEYS', { roles: ['read', 'write', 'readwrite', 'admin'], scopePattern: Config.QUEUE_PATTERN, scopeNoun: 'queue', minSecretLength: Config.MIN_SECRET_LENGTH, roleErrorMessage: () => 'must be read, write, readwrite or admin' })
      .map(({ id, secret, role, scopes }) => ({ id, secret, role: /** @type {KeyRole} */ (role), queues: scopes }));
  }
}
