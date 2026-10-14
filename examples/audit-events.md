# Audit events

With `AUDIT_URL` / `AUDIT_API_KEY` set, management actions are forwarded (`success`, or `denied` on 403):

| Action | Request | `meta` |
|---|---|---|
| `atc-queue.queue.upsert` | `PUT /v1/queues/:name` | `created`, `settings` |
| `atc-queue.queue.delete` | `DELETE /v1/queues/:name` | |
| `atc-queue.queue.purge` | `POST /v1/queues/:name/purge` | `state`, `removed` |
| `atc-queue.message.redrive` | `POST /v1/queues/:name/redrive` | `redriven` |
| `atc-queue.message.delete` | `DELETE /v1/queues/:name/messages/:id` | `queue` |

The data plane (enqueue, pull, ack, nack, extend) is not audited: it is high volume and its effect is visible in the queue counters and metrics. Message bodies never appear in events.
