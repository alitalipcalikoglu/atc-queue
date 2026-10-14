import { ApiKeyAuth as CoreApiKeyAuth } from '@atc-web/atc-service-core/auth';
import { QueueError } from '../domain/errors.js';

/** @typedef {import('../types.js').ApiKey} ApiKey */

/**
 * Bearer API keys with four roles and optional queue scoping. `read` browses and reads stats,
 * `write` is the data plane (enqueue, pull, ack, nack, extend), `readwrite` both, `admin`
 * everything including queue settings, purge, redrive and deletes.
 */
export class ApiKeyAuth {
  static GRANTS = Object.freeze({ read: ['read', 'readwrite', 'admin'], write: ['write', 'readwrite', 'admin'], admin: ['admin'] });

  /** @param {ApiKey[]} apiKeys */
  constructor(apiKeys) {
    this.core = new CoreApiKeyAuth(apiKeys.map((k) => ({ ...k, scopes: k.queues })));
  }

  get hook() {
    return this.core.hook;
  }

  /** @param {'read'|'write'|'admin'} need */
  static require(need) {
    return CoreApiKeyAuth.require(need, {
      roleOf: (request) => /** @type {any} */ (request).apiKey?.role,
      makeError: (n) => new QueueError('FORBIDDEN', `this API key has no ${n} access`),
      grants: ApiKeyAuth.GRANTS,
    });
  }

  /** A key scoped to some queues may not touch others. @param {any} key @param {string} queue */
  static assertQueue(key, queue) {
    CoreApiKeyAuth.assertScope(key, queue, (name) => new QueueError('FORBIDDEN', `this API key has no access to queue "${name}"`));
  }
}
