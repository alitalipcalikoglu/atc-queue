import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Config } from '../src/config.js';
import { Database } from '../src/db.js';
import { QueueService } from '../src/domain/queue-service.js';
import { QueueApi } from '../src/http/queue-api.js';
import { QueueStore } from '../src/store/queue-store.js';

export const ADMIN_KEY = 'a'.repeat(40);
export const RW_KEY = 'k'.repeat(40);
export const READ_KEY = 'r'.repeat(40);
export const WORKER_KEY = 'w'.repeat(40);

/** @param {Record<string, string>} [overrides] */
export function testEnv(overrides = {}) {
  return { PORT: '0', LOG_LEVEL: 'silent', DB_PATH: ':memory:', QUEUE_API_KEYS: `console:${ADMIN_KEY}:admin,app:${RW_KEY},dash:${READ_KEY}:read,mailer:${WORKER_KEY}:write:emails`, ...overrides };
}

/** A clock tests move by hand. */
export function manualClock(start = 1_800_000_000_000) {
  const c = { t: start, now: () => c.t, advance: (/** @type {number} */ ms) => { c.t += ms; } };
  return c;
}

/** @param {Record<string, string>} [overrides] @param {() => number} [now] */
export function testService(overrides, now) {
  const config = Config.fromEnv(testEnv(overrides));
  const db = new Database(':memory:');
  const store = new QueueStore(db);
  const service = new QueueService({ db, store, limits: config.limits, now });
  return { config, db, store, service };
}

/** @param {Record<string, string>} [overrides] @param {object} [deps] @param {() => number} [now] */
export async function buildApp(overrides, deps = {}, now) {
  const t = testService(overrides, now);
  const app = await new QueueApi({ ...t, version: readServiceVersion(import.meta.url), ...deps }).build();
  await app.ready();
  return { app, ...t };
}

/** @param {string} key */
export function bearer(key) {
  return { authorization: `Bearer ${key}` };
}
