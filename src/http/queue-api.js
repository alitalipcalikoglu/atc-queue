import { readFileSync } from 'node:fs';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { createErrorHandler, registerInfo, registerOpenApi, registerProbes, registerRequestContext, requestOptions } from '@atc-web/atc-service-core/fastify';
import { QueueError } from '../domain/errors.js';
import { ApiKeyAuth } from './api-key-auth.js';
import { Schemas } from './schemas.js';
import { Views } from './views.js';

/** @typedef {import('../config.js').Config} Config */
/** @typedef {import('fastify').FastifyInstance} FastifyInstance */
/** @typedef {import('fastify').FastifyRequest} FastifyRequest */

/**
 * HTTP surface. Data plane (enqueue, pull, ack, nack, extend) needs `write`; browsing and stats
 * `read`; queue settings, purge, redrive and deletes `admin`. Queue-scoped keys only reach their
 * queues, including in lists and stats.
 */
export class QueueApi {
  static READY_CACHE_MS = 10_000;

  /**
   * @param {object} deps
   * @param {Config} deps.config
   * @param {import('../domain/queue-service.js').QueueService} deps.service
   * @param {import('../db.js').Database} deps.db
   * @param {string} deps.version
   * @param {import('../types.js').Logger} [deps.logger]
   * @param {import('@atc-web/atc-service-core/audit').AuditClient} [deps.audit]
   */
  constructor({ config, audit, service, db, version, logger }) {
    this.config = config;
    this.audit = audit;
    this.service = service;
    this.db = db;
    this.version = version;
    this.logger = logger;
    this.auth = new ApiKeyAuth(config.apiKeys);
    this.counters = { enqueued: 0, pulled: 0, acked: 0, nacked: 0 };
  }

  /** @returns {Promise<FastifyInstance>} */
  async build() {
    const { config } = this;
    const app = Fastify({
      ...(config.tls ? { https: { cert: readFileSync(config.tls.certPath), key: readFileSync(config.tls.keyPath), minVersion: 'TLSv1.2' } } : {}),
      ...requestOptions({ logger: this.logger, logLevel: config.logLevel }),
      trustProxy: config.trustProxy,
      bodyLimit: config.bodyLimit,
      ajv: { customOptions: { removeAdditional: false, coerceTypes: false } },
    });
    registerRequestContext(app, { trustProxy: config.trustProxy });
    app.decorateRequest('apiKey', /** @type {any} */ (null));
    app.setErrorHandler(createErrorHandler(QueueError));
    app.addHook('onSend', AuditClient.hook(this.audit));
    app.setNotFoundHandler((_request, reply) => {
      reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'route not found' } });
    });
    app.addHook('onSend', async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    });
    registerProbes(app, () => this.db.ping(), { cacheMs: QueueApi.READY_CACHE_MS });
    registerOpenApi(app, new URL('../../openapi.yaml', import.meta.url));
    registerInfo(app, { service: 'atc-queue', version: this.version, capabilities: ['leases', 'delays', 'priorities', 'dedupe', 'dead-letters', 'long-poll', 'queue-scoped-keys'], schemaVersion: this.db.schemaVersion });
    await app.register((api) => this.#registerV1(api), { prefix: '/v1' });
    await app.register((ops) => this.#registerMetrics(ops));
    return app;
  }

  /** @param {FastifyInstance} api */
  async #registerV1(api) {
    api.addHook('onRequest', this.auth.hook);
    await api.register(rateLimit, {
      max: this.config.rateLimitMax,
      timeWindow: '1 minute',
      keyGenerator: (request) => request.apiKey.id,
      errorResponseBuilder: (_request, context) => Object.assign(new Error(`rate limit exceeded, retry in ${context.after}`), { statusCode: 429, code: 'RATE_LIMITED' }),
    });
    const s = this.service;
    const read = { preHandler: ApiKeyAuth.require('read') };
    const write = { preHandler: ApiKeyAuth.require('write') };
    const admin = { preHandler: ApiKeyAuth.require('admin') };
    const q = (/** @type {FastifyRequest} */ r) => { const name = /** @type {{ name: string }} */ (r.params).name; ApiKeyAuth.assertQueue(r.apiKey, name); return name; };
    const mid = (/** @type {FastifyRequest} */ r) => /** @type {{ id: string }} */ (r.params).id;
    const visible = (/** @type {FastifyRequest} */ r, /** @type {string} */ name) => !r.apiKey.queues || r.apiKey.queues.includes(name);
    const target = (/** @type {FastifyRequest} */ r) => ({ type: 'queue', id: /** @type {any} */ (r.params).name });
    const now = () => s.now();

    // ---- queues
    api.get('/queues', read, async (request) => {
      const st = s.stats();
      return { items: st.items.filter((i) => visible(request, i.queue.name)).map((i) => ({ ...Views.queue(i.queue), ready: i.ready, delayed: i.delayed, leased: i.leased, dead: i.dead, oldestReadySec: i.oldestReadyMs === null ? null : Math.floor(i.oldestReadyMs / 1000) })) };
    });

    api.put('/queues/:name', { config: { audit: AuditClient.route('atc-queue.queue.upsert', target, (r, b) => ({ created: b.created, settings: r.body })) }, ...admin, schema: { params: Schemas.queueParams, body: Schemas.putQueue } }, async (request, reply) => {
      const { queue, created } = s.putQueue(q(request), /** @type {any} */ (request.body ?? {}), request.apiKey.id);
      return reply.code(created ? 201 : 200).send({ created, queue: Views.queue(queue) });
    });

    api.get('/queues/:name', { ...read, schema: { params: Schemas.queueParams } }, async (request) => {
      const name = q(request);
      const i = /** @type {any} */ (s.stats().items.find((x) => x.queue.name === name)) ?? (s.queue(name), null);
      return { queue: Views.queue(i.queue), depth: { ready: i.ready, delayed: i.delayed, leased: i.leased, dead: i.dead }, oldestReadySec: i.oldestReadyMs === null ? null : Math.floor(i.oldestReadyMs / 1000), counters: i.counters };
    });

    api.delete('/queues/:name', { config: { audit: AuditClient.route('atc-queue.queue.delete', target) }, ...admin, schema: { params: Schemas.queueParams, querystring: Schemas.deleteQuery } }, async (request, reply) => {
      s.deleteQueue(q(request), /** @type {any} */ (request.query).force === 'true');
      return reply.code(204).send();
    });

    api.post('/queues/:name/purge', { config: { audit: AuditClient.route('atc-queue.queue.purge', target, (r, b) => ({ state: /** @type {any} */ (r.body).state, removed: b.removed })) }, ...admin, schema: { params: Schemas.queueParams, body: Schemas.purge } }, async (request) => ({ removed: s.purge(q(request), /** @type {any} */ (request.body).state) }));

    api.post('/queues/:name/redrive', { config: { audit: AuditClient.route('atc-queue.message.redrive', target, (_r, b) => ({ redriven: b.redriven })) }, ...admin, schema: { params: Schemas.queueParams, body: Schemas.redrive } }, async (request) => {
      const b = /** @type {{ ids?: string[], all?: true }} */ (request.body ?? {});
      if (!b.ids && !b.all) throw new QueueError('INVALID_ARGUMENT', 'name the messages in ids, or pass all: true');
      return { redriven: s.redrive(q(request), b.all ? null : /** @type {string[]} */ (b.ids)) };
    });

    // ---- data plane
    api.post('/queues/:name/messages', { ...write, schema: { params: Schemas.queueParams, body: Schemas.message } }, async (request, reply) => {
      const [r] = s.enqueue(q(request), [/** @type {any} */ (request.body)], request.apiKey.id);
      this.counters.enqueued += r.deduplicated ? 0 : 1;
      return reply.code(r.deduplicated ? 200 : 201).send({ message: Views.message(r.message, now()), deduplicated: r.deduplicated });
    });

    api.post('/queues/:name/messages/batch', { ...write, schema: { params: Schemas.queueParams, body: Schemas.batch } }, async (request, reply) => {
      const out = s.enqueue(q(request), /** @type {any} */ (request.body).messages, request.apiKey.id);
      this.counters.enqueued += out.filter((r) => !r.deduplicated).length;
      return reply.code(201).send({ items: out.map((r) => ({ message: Views.message(r.message, now()), deduplicated: r.deduplicated })) });
    });

    api.post('/queues/:name/pull', { ...write, schema: { params: Schemas.queueParams, body: Schemas.pull } }, async (request) => {
      const controller = new AbortController();
      request.raw.once('close', () => controller.abort());
      const got = await s.pull(q(request), /** @type {any} */ (request.body ?? {}), controller.signal);
      this.counters.pulled += got.length;
      return { messages: got.map((m) => Views.message(m, now(), { token: true })) };
    });

    api.post('/queues/:name/messages/:id/ack', { ...write, schema: { params: Schemas.messageParams, body: Schemas.ack } }, async (request, reply) => {
      s.ack(q(request), mid(request), /** @type {any} */ (request.body).leaseToken);
      this.counters.acked++;
      return reply.code(204).send();
    });

    api.post('/queues/:name/messages/:id/nack', { ...write, schema: { params: Schemas.messageParams, body: Schemas.nack } }, async (request) => {
      const b = /** @type {any} */ (request.body);
      const outcome = s.nack(q(request), mid(request), b.leaseToken, { delaySec: b.delaySec, error: b.error, dead: b.dead });
      this.counters.nacked++;
      return { outcome, message: Views.message(s.message(q(request), mid(request)), now()) };
    });

    api.post('/queues/:name/messages/:id/extend', { ...write, schema: { params: Schemas.messageParams, body: Schemas.extend } }, async (request) => {
      const b = /** @type {any} */ (request.body);
      return { leaseUntil: Views.iso(s.extend(q(request), mid(request), b.leaseToken, b.visibilitySec)) };
    });

    // ---- browsing
    api.get('/queues/:name/messages', { ...read, schema: { params: Schemas.queueParams, querystring: Schemas.listQuery } }, async (request) => {
      const name = q(request);
      s.queue(name);
      const qs = /** @type {{ state?: any, limit?: string, cursor?: string }} */ (request.query);
      const limit = qs.limit ? Number(qs.limit) : 50;
      const rows = s.store.list(name, { state: qs.state, after: qs.cursor ? Number(qs.cursor) : 0, limit: limit + 1 }, now());
      const page = rows.slice(0, limit);
      return { items: page.map((m) => Views.message(m, now())), nextCursor: rows.length > limit ? String(page.at(-1)?.seq) : null };
    });

    api.get('/queues/:name/messages/:id', { ...read, schema: { params: Schemas.messageParams } }, async (request) => ({ message: Views.message(s.message(q(request), mid(request)), now()) }));

    api.delete('/queues/:name/messages/:id', { config: { audit: AuditClient.route('atc-queue.message.delete', (r) => ({ type: 'message', id: mid(r) }), (r) => ({ queue: /** @type {any} */ (r.params).name })) }, ...admin, schema: { params: Schemas.messageParams } }, async (request, reply) => {
      s.deleteMessage(q(request), mid(request));
      return reply.code(204).send();
    });

    api.get('/stats', read, async (request) => {
      const st = s.stats();
      const items = st.items.filter((i) => visible(request, i.queue.name));
      const sum = (/** @type {'ready'|'delayed'|'leased'|'dead'} */ k) => items.reduce((a, i) => a + i[k], 0);
      return { queues: items.length, ready: sum('ready'), delayed: sum('delayed'), leased: sum('leased'), dead: sum('dead'), oldestReadySec: items.reduce((/** @type {number|null} */ a, i) => (i.oldestReadyMs === null ? a : Math.max(a ?? 0, Math.floor(i.oldestReadyMs / 1000))), null), items: items.map((i) => ({ queue: i.queue.name, ready: i.ready, delayed: i.delayed, leased: i.leased, dead: i.dead, counters: i.counters })) };
    });
  }

  /** @param {FastifyInstance} ops */
  #registerMetrics(ops) {
    ops.addHook('onRequest', this.auth.hook);
    ops.get('/metrics', { logLevel: 'warn', preHandler: ApiKeyAuth.require('read') }, async (request, reply) => {
      // A queue-scoped key sees only its queues here too, as in /v1/stats.
      const scope = request.apiKey.queues;
      const st = { items: this.service.stats().items.filter((i) => !scope || scope.includes(i.queue.name)) };
      const label = (/** @type {string} */ v) => v.replace(/[\\"\n]/g, '\\$&');
      reply.type('text/plain; version=0.0.4; charset=utf-8');
      return [
        '# HELP queue_messages Messages by queue and state.',
        '# TYPE queue_messages gauge',
        ...st.items.flatMap((i) => ['ready', 'delayed', 'leased', 'dead'].map((k) => `queue_messages{queue="${label(i.queue.name)}",state="${k}"} ${i[/** @type {'ready'} */ (k)]}`)),
        '# HELP queue_oldest_ready_seconds Age of the oldest message waiting to be pulled.',
        '# TYPE queue_oldest_ready_seconds gauge',
        ...st.items.filter((i) => i.oldestReadyMs !== null).map((i) => `queue_oldest_ready_seconds{queue="${label(i.queue.name)}"} ${Math.floor(i.oldestReadyMs / 1000)}`),
        '# HELP queue_events_total Lifetime message events by queue (persisted).',
        '# TYPE queue_events_total counter',
        ...st.items.flatMap((i) => Object.entries(/** @type {Record<string, number>} */ (i.counters)).map(([k, v]) => `queue_events_total{queue="${label(i.queue.name)}",event="${label(k)}"} ${v}`)),
        '# HELP queue_process_uptime_seconds Process uptime.',
        '# TYPE queue_process_uptime_seconds gauge',
        `queue_process_uptime_seconds ${process.uptime().toFixed(0)}`,
        '',
      ].join('\n');
    });
  }
}
