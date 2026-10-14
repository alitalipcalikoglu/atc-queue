# `atc-queue` readiness contract

## Purpose
Durable message queue for service-to-service work: named queues, delays, priorities, dedupe keys,
leased pulls (ack/nack/extend), retries with exponential backoff, dead letters with redrive.
Delivery is at least once.

## Dependencies
`atc-audit` (optional, management events, buffered off the request path). Nothing else.

## Persistence
SQLite at `DB_PATH` (`./data/queue.db`; Docker `/data/queue.db`), WAL. Tables: `queues`, `messages`
(indexes for due order, lease expiry and the per-queue unique `dedupe_key`), `counters` (lifetime
events per queue). Acked messages are deleted; dead letters expire after `DEAD_RETENTION_DAYS`.
Migrations by `user_version`, snapshot before upgrading, no down migrations.

## Health / readiness
`/health` no I/O. `/ready` database ping cached 10 s.

## Graceful shutdown
`SIGTERM`: reaper stops, open long-polls end at once (answer with no messages), HTTP drains,
audit flush, database closes. Force exit 30 s; PM2 `kill_timeout` 35 s. Leased messages stay leased
and are reclaimed after their leases expire on the next start.

## Resource limits
`MAX_MESSAGE_BYTES` 256 KiB, `MAX_QUEUE_DEPTH` 100 000, `MAX_BATCH` 100, `MAX_WAIT_SEC` 20,
`MAX_QUEUES` 500, `BODY_LIMIT` 2 x message size (≥ 1 MiB), `RATE_LIMIT_MAX` 6 000/min per key.

## Timeouts
Long-poll ≤ `MAX_WAIT_SEC`; an idle poll peeks with a read-only query every 200 ms (no write lock) and an enqueue in the same process wakes it at once; ends when the client disconnects.

## Retry policy
For consumers: nack or lease expiry → backoff `base * 2^(attempts-1)` ≤ max; dead after
`maxAttempts`. The service itself makes no outbound calls besides audit.

## Idempotency
Enqueue with a `dedupeKey` is idempotent while the message exists. Ack is fenced on the lease
token (a second ack answers 404, a stale token 409). Pull is not idempotent.

## Backup / restore
The SQLite file. After a restore, messages leased at backup time are redelivered once their leases
expire (at-least-once holds).

## Metrics
`queue_messages{queue,state}`, `queue_oldest_ready_seconds{queue}`, `queue_events_total{queue,event}`
(database), `queue_process_uptime_seconds`. Scoped keys see only their queues.

## Logging / tracing
Fastify request logs with request id and trace context, `authorization` redacted; message bodies
never logged.

## Security model
Bearer keys with `read`/`write`/`readwrite`/`admin` and optional queue scopes enforced on every
route, list, stats and metrics. Lease tokens are random UUIDs returned only to the puller.

## Scaling model
**B — single-node stateful.** One process per SQLite file (`instances: 1`). Claims run in
`BEGIN IMMEDIATE` transactions, so a message is never leased twice even under concurrent pulls.

## Known failure modes
- Consumer crash after work, before ack: redelivered after the lease (at least once).
- Disk full: enqueue fails with 500, nothing partial is stored.
- A very long `visibilitySec` hides a message for that long after a consumer crash.
