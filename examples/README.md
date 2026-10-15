# queue examples

Scenario-driven walkthroughs of every feature. Requests to `/v1/*` need `Authorization: Bearer <secret>` from `QUEUE_API_KEYS`. Base URL below is `http://localhost:3016`.

| Example | Shows |
|---|---|
| [Queues](queues.md) | Creating a queue, settings (visibility, attempts, backoff), pausing, deleting |
| [Producing](producing.md) | Enqueue, batches, delays, priorities, dedupe keys, caps |
| [Consuming](consuming.md) | Pull with long-poll, ack, nack, extend, a complete worker loop |
| [Push delivery](push.md) | The service POSTs messages to your endpoint, signature check, retries, switching back to pull |
| [Retries and dead letters](dead-letters.md) | Backoff, lease expiry, dead-lettering, browsing and redriving |
| [Operations on messages](maintenance.md) | Browsing by state, deleting one message, purging, retention |
| [API keys, roles and scopes](keys-and-roles.md) | read, write, readwrite, admin; keys scoped to queues |
| [Operations](operations.md) | Health, readiness, metrics, stats, PM2, Docker, backups |
| [Events](events.md) | `ops.queue.dead_letter` and `ops.queue.dead_expired` through atc-webhook-out |
| [Audit events](audit-events.md) | Which actions are forwarded to the audit service |

```bash
export QUEUE=http://localhost:3016
export ADMIN=<an admin secret>   KEY=<a write or readwrite secret>
alias qcurl='curl -s -H "Authorization: Bearer $KEY" -H "Content-Type: application/json"'
alias qadmin='curl -s -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json"'
```
