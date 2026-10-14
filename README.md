# atc-queue

Durable message queue for service-to-service work, on SQLite. Named queues; enqueue with delay, priority and a dedupe key; pull with a visibility lease and long-poll; ack, nack and extend fenced on a lease token; retries with exponential backoff; dead letters with browse and redrive; purge; per-queue stats and metrics. Delivery is at least once. HTTP only.

Runtime dependencies: `fastify`, `@fastify/rate-limit`, `@atc-web/atc-service-core`. Storage is SQLite via `node:sqlite` (Node 22.13+).

## Run

```bash
cp .env.example .env        # set QUEUE_API_KEYS
npm ci
npm run dev
```

Production: `npm ci --omit=dev && pm2 start ecosystem.config.cjs`, or `docker build -t atc-queue . && docker run -p 3016:3016 -v atc-queue-data:/data --env-file .env atc-queue`.

Tests and type check: `npm test`, `npm run typecheck`.

## Model

- **Queue**: name, `visibilitySec` (default lease), `maxAttempts`, `backoffBaseSec`/`backoffMaxSec`, `paused`.
- **Message**: JSON body, `priority`, optional `delaySec` and `dedupeKey`. States: `ready` (due), `delayed` (ready, not yet due), `leased`, `dead`.
- **Pull** leases due messages (priority, then oldest) for `visibilitySec`; every delivery is an attempt. **Ack** deletes; **nack** makes it visible after `delaySec` or the backoff, or dead when attempts are used up (or `dead: true`); **extend** moves the lease end. An expired lease counts as a failed delivery.
- **Dead letters** stay until redriven (attempts reset), deleted, purged or `DEAD_RETENTION_DAYS`.
- **Dedupe**: while a message with the key is in the queue, enqueuing the key again returns that message (`deduplicated: true`).

## API

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/health`, `/ready`, `/v1/info` | none | Probes, identity |
| GET | `/metrics` | read | Prometheus text (only the key's queues) |
| GET | `/v1/queues` | read | Queues with depth |
| PUT / GET / DELETE | `/v1/queues/:name` | admin / read / admin | Create or update settings; depth, oldest due, counters; delete (`force=true` with messages) |
| POST | `/v1/queues/:name/purge` | admin | `{ state: ready\|dead\|all }` |
| POST | `/v1/queues/:name/redrive` | admin | `{ ids }` or `{ all: true }` |
| POST | `/v1/queues/:name/messages` | write | Enqueue one (`201`, or `200` deduplicated) |
| POST | `/v1/queues/:name/messages/batch` | write | Enqueue up to `MAX_BATCH` in one transaction |
| GET | `/v1/queues/:name/messages` | read | Browse by `state`, cursor paging |
| POST | `/v1/queues/:name/pull` | write | `{ max, visibilitySec, waitSec }` → leased messages with `leaseToken` |
| POST | `/v1/queues/:name/messages/:id/ack` / `nack` / `extend` | write | Lease operations (`leaseToken`) |
| GET / DELETE | `/v1/queues/:name/messages/:id` | read / admin | One message; delete one that is not leased |
| GET | `/v1/stats` | read | Totals and per queue |

Errors: `{ "error": { "code", "message" } }` — `VALIDATION_FAILED`, `INVALID_ARGUMENT` (400), `FORBIDDEN` (403), `QUEUE_NOT_FOUND`, `MESSAGE_NOT_FOUND` (404), `LEASE_LOST`, `QUEUE_FULL`, `QUEUE_NOT_EMPTY`, `INVALID_STATE`, `LIMIT_EXCEEDED` (409), `MESSAGE_TOO_LARGE` (413), `RATE_LIMITED` (429). Full contract: [openapi.yaml](openapi.yaml).

## Examples

Producing, consuming with a worker loop, retries and dead letters, scoped keys: [examples/README.md](examples/README.md).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT`, `HOST` | `3016`, `0.0.0.0` | Listen address |
| `QUEUE_API_KEYS` | required | `id:secret[:role[:queue+queue]]`; role `read`, `write`, `readwrite` (default), `admin` |
| `MAX_MESSAGE_BYTES` | `262144` | Encoded body size |
| `MAX_QUEUE_DEPTH` | `100000` | Messages per queue |
| `MAX_BATCH`, `MAX_WAIT_SEC` | `100`, `20` | Messages per batch/pull; longest long-poll |
| `MAX_QUEUES` | `500` | |
| `DEAD_RETENTION_DAYS`, `REAP_MS` | `14`, `1000` | Dead-letter expiry; lease reaper interval |
| `DB_PATH`, `DB_BACKUP_DIR`, `BODY_LIMIT`, `RATE_LIMIT_MAX` | `./data/queue.db`, –, 2 x message, `6000` | |
| `TRUST_PROXY`, `TLS_CERT_PATH`, `TLS_KEY_PATH`, `LOG_LEVEL` | | As in every service |
| `AUDIT_URL`, `AUDIT_API_KEY` | empty | Forward audit events (both or neither) |

## Security notes

- Every route checks the key's role and queue scope; scoped keys see only their queues in lists, stats and metrics.
- Lease tokens are random and returned only to the puller; ack/nack/extend are fenced on them.
- Message bodies are opaque JSON, never logged or audited.

## Code layout

```
src/
  application.js        composition root, lease reaper, lifecycle
  config.js, db.js, types.js
  domain/queue-service.js  queue rules: enqueue, pull/long-poll, ack/nack/extend, dead letters, redrive, purge, stats
  store/queue-store.js     SQLite statements, transactional claims, lease fencing, counters
  http/                    QueueApi routes, ApiKeyAuth (roles, queue scopes), Schemas, Views
test/                      node:test suites
```

## Out of scope by design

- Exactly-once delivery, FIFO groups and strict per-key ordering (priority, then due time, then arrival is the order).
- Push delivery to HTTP endpoints (use atc-webhook-out), topics and fan-out.
- Message dedupe after a message is gone (keys are free once acked or deleted).
- Clustering or replication; one process owns one SQLite file.

## Audit events

With `AUDIT_URL` and `AUDIT_API_KEY` set, management actions are forwarded (`success`, or `denied` on 403): `atc-queue.queue.upsert` (meta: created, settings), `atc-queue.queue.delete`, `atc-queue.queue.purge` (meta: state, removed), `atc-queue.message.redrive` (meta: redriven), `atc-queue.message.delete`. The data plane (enqueue, pull, ack, nack, extend) is not audited (high volume; visible in counters and metrics). Details: [examples/audit-events.md](examples/audit-events.md).

## Scaling model

**B — single-node stateful.** One process per SQLite file; claims are transactional, so concurrent pulls never lease a message twice. See [docs/READINESS.md](docs/READINESS.md).

## Observability

Request logs with request id and trace context; `/metrics` (depth by state, oldest due age, lifetime events); `/v1/stats`; `/ready`.

Audit forwarding is observable too: `audit_forward_enabled`, `audit_forward_events_total{result="recorded|sent|dropped|failed"}` and `audit_forward_pending`. A rising `dropped`, or a `pending` that does not drain, means audit events are being lost or delayed; alert on it.

## Backup / restore

The SQLite file at `DB_PATH`. `sqlite3 data/queue.db "VACUUM INTO 'backup.db'"` takes an online copy. After a restore, messages that were leased at backup time are redelivered once their leases expire.

## License

MIT, see [LICENSE](LICENSE).
