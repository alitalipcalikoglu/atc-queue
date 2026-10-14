import { Config } from './config.js';
import { AuditClient } from '@atc-web/atc-service-core/audit';
import { Lifecycle } from '@atc-web/atc-service-core/lifecycle';
import { readServiceVersion } from '@atc-web/atc-service-core/fastify';
import { Database } from './db.js';
import { QueueService } from './domain/queue-service.js';
import { QueueApi } from './http/queue-api.js';
import { QueueStore } from './store/queue-store.js';
import { EventPublisher } from './events/event-publisher.js';

/** Composition root: wires configuration, storage, domain and HTTP, runs the lease reaper, owns the lifecycle. */
export class Application {
  /** @param {Config} config */
  constructor(config) {
    this.config = config;
    this.version = readServiceVersion(import.meta.url);
    this.audit = new AuditClient({ target: config.audit });
    this.publisher = new EventPublisher({ source: 'atc-queue', target: config.webhookOut });
    this.db = new Database(config.dbPath, { backupDir: config.dbBackupDir });
    this.store = new QueueStore(this.db);
    this.service = new QueueService({ db: this.db, store: this.store, limits: config.limits, publisher: this.publisher });
    /** @type {import('fastify').FastifyInstance|null} */
    this.app = null;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** @type {(reason: string) => Promise<void>} */
    this.shutdown = async () => {};
  }

  /** Build from `process.env`; exits with a readable message on bad configuration. */
  static fromEnv() {
    try {
      return new Application(Config.fromEnv());
    } catch (err) {
      if (err instanceof Error && err.name === 'ConfigError') {
        console.error(`configuration error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }
  }

  async start() {
    const { config } = this;
    const app = await new QueueApi({ config, audit: this.audit, publisher: this.publisher, service: this.service, db: this.db, version: this.version }).build();
    this.app = app;
    const maintain = () => {
      try {
        const r = this.service.maintain();
        if (r.retried || r.buried || r.expired) app.log.info(r, 'queue maintenance');
      } catch (err) { app.log.error({ err }, 'queue maintenance failed'); }
    };
    maintain();
    this.timer = setInterval(maintain, config.limits.reapMs);
    this.timer.unref();
    const { shutdown } = Lifecycle.install({
      forceExitMs: 30_000,
      log: app.log,
      steps: [
        () => { if (this.timer) clearInterval(this.timer); this.service.stopping.abort(); },
        () => this.app?.close(),
        () => this.publisher.close(),
        () => this.audit.close(),
        () => this.db.close(),
      ],
    });
    this.shutdown = shutdown;
    this.audit.logger = app.log;
    this.publisher.logger = app.log;
    this.audit.start();
    await app.listen({ port: config.port, host: config.host });
    app.log.info({ tls: config.tls !== null, queues: this.store.queueCount() }, config.tls ? 'serving HTTPS' : 'serving plain HTTP, terminate TLS at a reverse proxy');
    if (process.send) process.send('ready'); // PM2 wait_ready
  }
}
